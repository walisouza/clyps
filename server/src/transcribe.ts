import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { ASSEMBLYAI, UserError, apiError, sleep } from './errors.js';
import { SEGMENT_SECONDS } from './media.js';
import type { Word } from './types.js';

async function transcribeFile(file: string, language: string): Promise<Word[]> {
  const form = new FormData();
  form.append('file', new Blob([await readFile(file)], { type: 'audio/mpeg' }), path.basename(file));
  form.append('model', config.sttModel);
  form.append('language', language);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');

  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${config.sttBaseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.sttApiKey}` },
      body: form,
    });
    if (res.ok) {
      const json: any = await res.json();
      const words = Array.isArray(json.words) ? json.words : [];
      return words.map((w: any) => ({ word: String(w.word), start: Number(w.start), end: Number(w.end) }));
    }
    lastError = `${res.status} ${(await res.text()).slice(0, 300)}`;
    if (res.status < 500 && res.status !== 429) break;
    await new Promise((r) => setTimeout(r, attempt * 3000));
  }
  throw new Error(`Falha na transcrição: ${lastError}`);
}

/** Transcreve as partes de áudio em ordem e devolve palavras com tempo absoluto. */
export async function transcribe(
  segments: string[],
  language: string,
  onProgress: (done: number, total: number) => Promise<void>,
): Promise<Word[]> {
  const all: Word[] = [];
  for (let i = 0; i < segments.length; i++) {
    const offset = i * SEGMENT_SECONDS;
    const words = await transcribeFile(segments[i], language);
    for (const w of words) all.push({ word: w.word, start: w.start + offset, end: w.end + offset });
    await onProgress(i + 1, segments.length);
  }
  return all;
}

/**
 * AssemblyAI: envia o áudio inteiro de uma vez (sem dividir em partes) e espera a transcrição
 * com tempo de cada palavra. Os tempos vêm em milissegundos.
 */
export async function transcribeAssemblyAI(
  file: string,
  language: string,
  onProgress: (fraction: number) => Promise<void>,
): Promise<Word[]> {
  const base = config.assemblyaiBaseUrl;
  const auth = { authorization: config.assemblyaiApiKey };
  const env = 'ASSEMBLYAI_API_KEY';

  const up = await fetch(`${base}/v2/upload`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/octet-stream' },
    body: await readFile(file),
  });
  if (!up.ok) throw apiError(ASSEMBLYAI, up.status, await up.text(), env);
  const { upload_url } = (await up.json()) as { upload_url?: string };
  if (!upload_url) throw new UserError('A AssemblyAI não devolveu o endereço do áudio enviado.');

  const create = await fetch(`${base}/v2/transcript`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: upload_url, language_code: language, punctuate: true, format_text: true }),
  });
  if (!create.ok) throw apiError(ASSEMBLYAI, create.status, await create.text(), env);
  const { id } = (await create.json()) as { id?: string };
  if (!id) throw new UserError('A AssemblyAI não criou a transcrição.');

  const started = Date.now();
  for (;;) {
    await sleep(3000);
    const res = await fetch(`${base}/v2/transcript/${id}`, { headers: auth });
    if (!res.ok) {
      if (res.status >= 500 || res.status === 429) continue; // instabilidade passageira: tenta de novo
      throw apiError(ASSEMBLYAI, res.status, await res.text(), env);
    }
    const t: any = await res.json();
    if (t.status === 'completed') {
      const words = Array.isArray(t.words) ? t.words : [];
      return words.map((w: any) => ({ word: String(w.text), start: Number(w.start) / 1000, end: Number(w.end) / 1000 }));
    }
    if (t.status === 'error') {
      throw new UserError(`A AssemblyAI não conseguiu transcrever: ${String(t.error ?? 'erro desconhecido').slice(0, 200)}`);
    }
    const elapsed = Date.now() - started;
    if (elapsed > 3 * 3600 * 1000) throw new UserError('A transcrição demorou demais. Tente de novo.');
    // A API não informa o progresso: avança de forma suave até 95%.
    await onProgress(Math.min(0.95, 1 - Math.exp(-elapsed / 90_000)));
  }
}

/** Transcrição falsa para testes (MOCK_AI=1). */
export function mockTranscribe(durationSec: number): Word[] {
  const vocab = ['esse', 'é', 'um', 'teste', 'do', 'Clyps', 'cortando', 'vídeos', 'longos', 'em', 'clipes', 'curtos.'];
  const words: Word[] = [];
  for (let t = 0.5, i = 0; t < durationSec - 0.5; t += 0.42, i++) {
    words.push({ word: vocab[i % vocab.length], start: t, end: t + 0.34 });
  }
  return words;
}
