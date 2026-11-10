import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as pipe } from 'node:stream/promises';
import { config } from './config.js';
import { adjustCredits, db, updateJob } from './db.js';
import { extractAudioSegments, probe, ytDownload, ytInfo } from './media.js';
import { renderSelection } from './render.js';
import { mockSelect, selectClips } from './select.js';
import { mockTranscribe, transcribe } from './transcribe.js';
import { normalizeOptions, type Job } from './types.js';

/** Erro com mensagem que pode ser mostrada ao usuário. */
class UserError extends Error {}

async function fetchSource(job: Job, dir: string): Promise<{ file: string; title: string }> {
  const file = path.join(dir, 'source.mp4');

  if (job.source_type === 'url') {
    const url = job.source_url ?? '';
    if (!/^https?:\/\//i.test(url)) throw new UserError('Link inválido.');
    const info = await ytInfo(url).catch(() => {
      throw new UserError('Não foi possível ler esse link. Confira se o vídeo é público.');
    });
    if (info.duration > config.maxDurationSeconds) throw new UserError('O vídeo passa do limite de duração.');
    await ytDownload(url, file);
    return { file, title: info.title };
  }

  const { data, error } = await db().storage.from('uploads').createSignedUrl(job.storage_key!, 3600);
  if (error || !data) throw new Error(`Assinar upload: ${error?.message}`);
  const res = await fetch(data.signedUrl);
  if (!res.ok || !res.body) throw new UserError('O arquivo enviado não foi encontrado.');
  await pipe(Readable.fromWeb(res.body as any), createWriteStream(file));
  return { file, title: job.title || path.basename(job.storage_key!).replace(/^[0-9a-f-]{36}-/, '') };
}

export async function processJob(job: Job): Promise<void> {
  const opts = normalizeOptions(job.options);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clyps-'));
  let charged = 0;

  try {
    await updateJob(job.id, { stage: 'downloading', progress: 5 });
    const source = await fetchSource(job, dir);
    const info = await probe(source.file);
    if (!info.hasAudio) throw new UserError('O vídeo não tem áudio; os cortes dependem da fala.');
    if (info.duration > config.maxDurationSeconds) throw new UserError('O vídeo passa do limite de duração.');

    const cost = Math.ceil(info.duration / 60) * config.creditsPerMinute;
    if (config.enforceCredits) {
      const ok = await adjustCredits(job.user_id, job.id, -cost, 'Clips: processamento');
      if (!ok) throw new UserError('Créditos insuficientes.');
      charged = cost;
    }
    await updateJob(job.id, {
      stage: 'transcribing',
      progress: 20,
      title: source.title,
      duration_seconds: info.duration,
      credit_cost: cost,
    });

    const words = config.mock
      ? mockTranscribe(info.duration)
      : await transcribe(await extractAudioSegments(source.file, dir), opts.language, (done, total) =>
          updateJob(job.id, { progress: 20 + Math.round((done / total) * 30) }),
        );
    if (words.length < 20) throw new UserError('Não encontramos fala suficiente no vídeo para gerar cortes.');

    await updateJob(job.id, { stage: 'selecting', progress: 52 });
    const selections = config.mock
      ? mockSelect(words, opts, info.duration)
      : await selectClips(words, opts, source.title, info.duration);
    if (!selections.length) throw new UserError('A IA não encontrou trechos bons para corte neste vídeo.');

    await updateJob(job.id, { stage: 'rendering', progress: 60 });
    await db().from('clips').delete().eq('job_id', job.id); // nova tentativa não duplica

    for (let i = 0; i < selections.length; i++) {
      const rendered = await renderSelection(source.file, info, words, selections[i], opts, dir, i);
      const key = `${job.user_id}/${job.id}/${i}.mp4`;
      const upload = await db().storage.from('clips').upload(key, await readFile(rendered.file), {
        contentType: 'video/mp4',
        upsert: true,
      });
      if (upload.error) throw new Error(`Enviar clipe: ${upload.error.message}`);

      const insert = await db().from('clips').insert({
        job_id: job.id,
        user_id: job.user_id,
        idx: i,
        title: selections[i].title,
        reason: selections[i].reason,
        score: selections[i].score,
        start_ms: Math.round(selections[i].start * 1000),
        end_ms: Math.round(selections[i].end * 1000),
        transcript: rendered.transcript,
        storage_key: key,
        aspect: opts.aspect,
      });
      if (insert.error) throw new Error(`Salvar clipe: ${insert.error.message}`);
      await rm(rendered.file, { force: true });
      await updateJob(job.id, { progress: 60 + Math.round(((i + 1) / selections.length) * 38) });
    }

    await updateJob(job.id, { status: 'completed', stage: 'done', progress: 100, completed_at: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof UserError ? err.message : 'Erro interno no processamento. Tente novamente.';
    console.error(`[job ${job.id}]`, err);
    if (charged > 0) await adjustCredits(job.user_id, job.id, charged, 'Clips: estorno por falha').catch(() => {});
    await updateJob(job.id, { status: 'failed', error: message, completed_at: new Date().toISOString() }).catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
