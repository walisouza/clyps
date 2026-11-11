import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sttAudioFilter } from './audio.js';
import { auphonicEnhance } from './auphonic.js';
import { config, isPlaceholder } from './config.js';
import { cookiesPath } from './cookies.js';
import { adjustCredits, db, updateJob, type JobRow } from './db.js';
import { measureEnergy, normalizeEnergy } from './energy.js';
import { UserError } from './errors.js';
import { extractAudio, extractAudioSegments, extractClipAudio, probe, ytDownload, ytInfo } from './media.js';
import { cleanFileName, cleanRange, clipFileName, finalizeFromClean, renderClean, type Range } from './render.js';
import { heuristicSelect } from './heuristic.js';
import { mockSelect, selectClips } from './select.js';
import { ensureSpeachesReady, mockTranscribe, transcribe, transcribeAssemblyAI } from './transcribe.js';
import { captionsFromOptions, normalizeOptions, type Selection } from './types.js';

const STAGE_NAMES: Record<string, string> = {
  starting: 'início',
  downloading: 'download do vídeo',
  analyzing: 'análise de energia',
  preparing_stt: 'preparação da transcrição',
  transcribing: 'transcrição',
  selecting: 'escolha dos trechos',
  enhancing: 'tratamento de voz (Auphonic)',
  rendering: 'renderização dos clipes',
};

export const clipsDir = (jobId: string) => path.join(config.dataDir, 'clips', jobId);
const nowIso = () => new Date().toISOString();

function assertAiConfigured(): void {
  if (config.mock) return;
  if (config.sttProvider === 'assemblyai' && isPlaceholder(config.assemblyaiApiKey)) {
    throw new UserError('A ASSEMBLYAI_API_KEY no .env ainda é o texto de exemplo. Troque pela sua chave da AssemblyAI.');
  }
  if (!config.sttProvider) {
    throw new UserError('Falta configurar a transcrição no servidor: o Speaches (SPEACHES_URL) ou ASSEMBLYAI_API_KEY no .env.');
  }
  // O LLM é opcional: sem ele, os trechos são escolhidos pela energia da fala e pelas frases.
}

const AUPHONIC_PARALLEL = 3;

/**
 * Trata o áudio de cada trecho no Auphonic (até 3 ao mesmo tempo).
 * Devolve o arquivo tratado por índice; trechos que falharem ficam sem arquivo e usam o filtro local.
 */
async function enhanceWithAuphonic(
  jobId: string,
  src: string,
  selections: Range[],
  tmp: string,
): Promise<{ files: (string | undefined)[]; failed: number; reason?: string }> {
  const files: (string | undefined)[] = new Array(selections.length).fill(undefined);
  let failed = 0;
  let reason: string | undefined;
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < selections.length) {
      const i = next++;
      const s = selections[i];
      const raw = path.join(tmp, `clip-${i}-raw.flac`);
      const out = path.join(tmp, `clip-${i}-auphonic.flac`);
      try {
        await extractClipAudio(src, raw, s.start, s.end - s.start);
        await auphonicEnhance(raw, out);
        files[i] = out;
      } catch (err) {
        failed++;
        if (err instanceof UserError) reason ??= err.message;
        console.warn(`[job ${jobId}] Auphonic falhou no clipe ${i}:`, err);
      }
      updateJob(jobId, { progress: 56 + Math.round((++done / selections.length) * 8) });
    }
  }
  await Promise.all(Array.from({ length: Math.min(AUPHONIC_PARALLEL, selections.length) }, worker));
  return { files, failed, reason };
}

async function fetchSource(job: JobRow, tmp: string): Promise<{ file: string; title: string }> {
  if (job.source_type === 'upload') {
    if (!job.upload_path) throw new UserError('O arquivo enviado não foi encontrado.');
    return { file: job.upload_path, title: job.title || 'Vídeo enviado' };
  }
  const url = job.source_url ?? '';
  const userCookies = cookiesPath(job.user_id);
  const cookieFile = existsSync(userCookies) ? userCookies : undefined;
  const info = await ytInfo(url, cookieFile).catch(() => {
    throw new UserError(
      'Não foi possível ler esse link. Se for um vídeo privado ou que exige login, envie os cookies do navegador na tela de novo corte.',
    );
  });
  if (info.duration > config.maxDurationSeconds) throw new UserError('O vídeo passa do limite de duração.');
  const file = path.join(tmp, 'source.mp4');
  await ytDownload(url, file, cookieFile).catch(() => {
    throw new UserError(
      'Não foi possível baixar esse vídeo. Alguns sites bloqueiam o download; tente baixar o arquivo e enviar pela aba "Arquivo".',
    );
  });
  return { file, title: info.title };
}

export async function processJob(job: JobRow): Promise<void> {
  const opts = normalizeOptions(JSON.parse(job.options || '{}'));
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'clyps-'));
  const outDir = clipsDir(job.id);
  let charged = 0;
  // Avisos não fatais acumulados (ex.: sem LLM, Auphonic falhou). Aparecem na tela do corte.
  const notices: string[] = [];
  const addNotice = (msg: string) => {
    notices.push(msg);
    updateJob(job.id, { notice: notices.join(' ') });
  };

  try {
    assertAiConfigured();
    updateJob(job.id, { stage: 'downloading', progress: 5 });
    const source = await fetchSource(job, tmp);
    const info = await probe(source.file).catch(() => {
      throw new UserError('Não foi possível ler o arquivo de vídeo.');
    });
    if (!info.hasAudio) throw new UserError('O vídeo não tem áudio; os cortes dependem da fala.');
    if (info.duration > config.maxDurationSeconds) throw new UserError('O vídeo passa do limite de duração.');

    const cost = Math.ceil(info.duration / 60) * config.creditsPerMinute;
    if (config.enforceCredits) {
      if (!adjustCredits(job.user_id, job.id, -cost, 'Clips: processamento')) throw new UserError('Créditos insuficientes.');
      charged = cost;
    }
    updateJob(job.id, {
      stage: 'analyzing',
      progress: 12,
      title: source.title,
      duration_seconds: info.duration,
      credit_cost: cost,
    });
    // Energia do áudio: usada para achar os momentos mais intensos. Se falhar, segue sem ela.
    const norm = await measureEnergy(source.file)
      .then(normalizeEnergy)
      .catch((err) => {
        console.warn(`[job ${job.id}] análise de energia falhou:`, err);
        return [] as number[];
      });

    updateJob(job.id, { stage: 'transcribing', progress: 20 });
    let words;
    if (config.mock) {
      words = mockTranscribe(info.duration);
    } else if (config.sttProvider === 'assemblyai') {
      // A AssemblyAI lida bem com ruído; o áudio vai sem filtros, que podem atrapalhar o reconhecimento.
      const audio = path.join(tmp, 'audio.mp3');
      await extractAudio(source.file, audio);
      words = await transcribeAssemblyAI(audio, opts.language, async (f) =>
        updateJob(job.id, { progress: 20 + Math.round(f * 30) }),
      );
    } else {
      const local = config.sttProvider === 'speaches';
      if (local) {
        await ensureSpeachesReady(() => updateJob(job.id, { stage: 'preparing_stt' }));
        updateJob(job.id, { stage: 'transcribing' });
      }
      // No Speaches (CPU da VPS) partes menores dão progresso mais frequente e evitam pedidos muito longos.
      const segmentSeconds = local ? 600 : 1200;
      words = await transcribe(
        await extractAudioSegments(source.file, tmp, sttAudioFilter(opts.audioEnhance), segmentSeconds),
        opts.language,
        async (done, total) => updateJob(job.id, { progress: 20 + Math.round((done / total) * 30) }),
        segmentSeconds,
      );
    }
    if (words.length < 20) throw new UserError('Não encontramos fala suficiente no vídeo para gerar cortes.');

    updateJob(job.id, { stage: 'selecting', progress: 52 });
    let selections;
    if (config.mock) {
      selections = mockSelect(words, opts, info.duration, norm);
    } else if (!config.llmViaAssemblyAI && config.llmConfigured && isPlaceholder(config.llmApiKey)) {
      selections = heuristicSelect(words, opts, info.duration, norm);
      addNotice('A LLM_API_KEY no .env ainda é o texto de exemplo; troque pela sua chave. Os trechos foram escolhidos pela energia da fala e pelas frases.');
    } else if (!config.llmConfigured) {
      selections = heuristicSelect(words, opts, info.duration, norm);
      addNotice(
        'Sem IA de texto configurada: os trechos foram escolhidos pela energia da fala e pelas frases, e a legenda do post usa o começo da fala. Para títulos e legendas escritos por IA, configure LLM_API_KEY, LLM_BASE_URL e LLM_MODEL.',
      );
    } else {
      try {
        selections = await selectClips(words, opts, source.title, info.duration, norm);
        if (!selections.length) {
          selections = heuristicSelect(words, opts, info.duration, norm);
          if (selections.length) addNotice('A IA de texto não devolveu trechos válidos; usamos a seleção pela energia da fala e pelas frases.');
        }
      } catch (err) {
        // Qualquer falha da IA de texto (chave, crédito, sobrecarga, rede, resposta estranha)
        // não perde o corte: cai na seleção sem IA de texto e explica o motivo.
        const reason = err instanceof UserError ? err.message : `erro inesperado: ${(err as Error)?.message ?? err}`;
        console.warn(`[job ${job.id}] IA de texto indisponível, usando seleção sem IA de texto:`, err);
        selections = heuristicSelect(words, opts, info.duration, norm);
        addNotice(`A IA de texto falhou (${reason.slice(0, 300)}) Os trechos foram escolhidos pela energia da fala e pelas frases.`);
      }
    }
    if (!selections.length) throw new UserError('Não encontramos trechos bons para corte neste vídeo.');

    // Intervalo de cada clipe com folga: base da versão limpa (e do áudio do Auphonic).
    const ranges = selections.map((s) => cleanRange(s, info.duration));
    let enhanced: (string | undefined)[] = [];
    if (opts.audioEnhance === 'auphonic') {
      if (!config.auphonicApiKey) {
        addNotice('O Auphonic não está configurado no servidor (AUPHONIC_API_KEY); usamos o tratamento de voz Forte do Clyps.');
      } else if (info.hasAudio) {
        updateJob(job.id, { stage: 'enhancing', progress: 56 });
        const r = await enhanceWithAuphonic(job.id, source.file, ranges, tmp);
        enhanced = r.files;
        if (r.failed > 0) {
          addNotice(
            `O Auphonic não tratou ${r.failed} de ${selections.length} clipes${r.reason ? ` (${r.reason})` : ''}. Nesses, usamos o tratamento de voz Forte do Clyps.`,
          );
        }
      }
    }

    updateJob(job.id, { stage: 'rendering', progress: 64 });
    db().prepare('delete from clips where job_id = ?').run(job.id); // nova tentativa não duplica
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    const insert = db().prepare(
      `insert into clips (id, job_id, user_id, idx, title, reason, score, start_ms, end_ms, transcript, file_path, aspect,
                          post_caption, energy, clean_path, clean_start_ms, clean_end_ms, words_json, captions_json)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const captions = captionsFromOptions(opts);
    for (let i = 0; i < selections.length; i++) {
      const s = selections[i];
      const range = ranges[i];
      const clean = cleanFileName(outDir, i);
      const file = clipFileName(outDir, i);
      await renderClean(source.file, info, range, opts, clean, enhanced[i]);
      // Palavras do intervalo com folga, em tempo absoluto: permitem editar corte e legenda depois.
      const rangeWords = words.filter((w) => w.start >= range.start - 0.05 && w.end <= range.end + 0.05);
      const { transcript } = await finalizeFromClean({
        clean, cleanStart: range.start, words: rangeWords, start: s.start, end: s.end, captions, out: file,
      });
      insert.run(
        randomUUID(), job.id, job.user_id, i, s.title, s.reason, s.score,
        Math.round(s.start * 1000), Math.round(s.end * 1000), transcript, file, opts.aspect,
        s.post ?? null, s.energy ?? null,
        clean, Math.round(range.start * 1000), Math.round(range.end * 1000), JSON.stringify(rangeWords), JSON.stringify(captions),
      );
      updateJob(job.id, { progress: 64 + Math.round(((i + 1) / selections.length) * 34) });
    }

    updateJob(job.id, { status: 'completed', stage: 'done', progress: 100, completed_at: nowIso() });
  } catch (err) {
    let message: string;
    if (err instanceof UserError) {
      message = err.message;
    } else {
      // Mostra a etapa e um resumo técnico, para dar para entender o problema sem abrir o log.
      const stage = (db().prepare('select stage from jobs where id = ?').get(job.id) as { stage?: string } | undefined)?.stage;
      const summary = String((err as Error)?.message ?? err).split('\n').find((l) => l.trim()) ?? '';
      message = `Erro interno${stage ? ` na etapa "${STAGE_NAMES[stage] ?? stage}"` : ''}: ${summary.slice(0, 220)}. Tente novamente; se repetir, veja docker compose logs app.`;
    }
    console.error(`[job ${job.id}]`, err);
    if (charged > 0) adjustCredits(job.user_id, job.id, charged, 'Clips: estorno por falha');
    updateJob(job.id, { status: 'failed', error: message, completed_at: nowIso() });
  } finally {
    await rm(tmp, { recursive: true, force: true });
    // O vídeo enviado só é apagado quando o corte dá certo; se falhar, fica para "Tentar novamente".
    const finalStatus = (db().prepare('select status from jobs where id = ?').get(job.id) as { status?: string } | undefined)?.status;
    if (job.upload_path && finalStatus === 'completed') {
      await rm(job.upload_path, { force: true });
      updateJob(job.id, { upload_path: null });
    }
  }
}
