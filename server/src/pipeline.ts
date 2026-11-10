import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { cookiesPath } from './cookies.js';
import { adjustCredits, db, updateJob, type JobRow } from './db.js';
import { extractAudioSegments, probe, ytDownload, ytInfo } from './media.js';
import { renderSelection } from './render.js';
import { mockSelect, selectClips } from './select.js';
import { mockTranscribe, transcribe } from './transcribe.js';
import { normalizeOptions } from './types.js';

/** Erro com mensagem que pode ser mostrada ao usuário. */
class UserError extends Error {}

export const clipsDir = (jobId: string) => path.join(config.dataDir, 'clips', jobId);
const nowIso = () => new Date().toISOString();

function assertAiConfigured(): void {
  if (config.mock) return;
  try {
    void config.sttApiKey;
    void config.llmApiKey;
    void config.llmModel;
  } catch {
    throw new UserError('As chaves de IA não estão configuradas no servidor (STT_API_KEY, LLM_API_KEY, LLM_MODEL).');
  }
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
      stage: 'transcribing',
      progress: 20,
      title: source.title,
      duration_seconds: info.duration,
      credit_cost: cost,
    });

    const words = config.mock
      ? mockTranscribe(info.duration)
      : await transcribe(await extractAudioSegments(source.file, tmp), opts.language, async (done, total) =>
          updateJob(job.id, { progress: 20 + Math.round((done / total) * 30) }),
        );
    if (words.length < 20) throw new UserError('Não encontramos fala suficiente no vídeo para gerar cortes.');

    updateJob(job.id, { stage: 'selecting', progress: 52 });
    const selections = config.mock
      ? mockSelect(words, opts, info.duration)
      : await selectClips(words, opts, source.title, info.duration);
    if (!selections.length) throw new UserError('A IA não encontrou trechos bons para corte neste vídeo.');

    updateJob(job.id, { stage: 'rendering', progress: 60 });
    db().prepare('delete from clips where job_id = ?').run(job.id); // nova tentativa não duplica
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    const insert = db().prepare(
      `insert into clips (id, job_id, user_id, idx, title, reason, score, start_ms, end_ms, transcript, file_path, aspect)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < selections.length; i++) {
      const s = selections[i];
      const rendered = await renderSelection(source.file, info, words, s, opts, outDir, i);
      await rm(path.join(outDir, `clip-${i}.ass`), { force: true });
      insert.run(
        randomUUID(), job.id, job.user_id, i, s.title, s.reason, s.score,
        Math.round(s.start * 1000), Math.round(s.end * 1000), rendered.transcript, rendered.file, opts.aspect,
      );
      updateJob(job.id, { progress: 60 + Math.round(((i + 1) / selections.length) * 38) });
    }

    updateJob(job.id, { status: 'completed', stage: 'done', progress: 100, completed_at: nowIso() });
  } catch (err) {
    const message = err instanceof UserError ? err.message : 'Erro interno no processamento. Tente novamente.';
    console.error(`[job ${job.id}]`, err);
    if (charged > 0) adjustCredits(job.user_id, job.id, charged, 'Clips: estorno por falha');
    updateJob(job.id, { status: 'failed', error: message, completed_at: nowIso() });
  } finally {
    await rm(tmp, { recursive: true, force: true });
    // O vídeo original enviado não é mais necessário depois do processamento.
    if (job.upload_path) {
      await rm(job.upload_path, { force: true });
      updateJob(job.id, { upload_path: null });
    }
  }
}
