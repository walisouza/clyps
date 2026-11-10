import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
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

/** Transcrição falsa para testes (MOCK_AI=1). */
export function mockTranscribe(durationSec: number): Word[] {
  const vocab = ['esse', 'é', 'um', 'teste', 'do', 'Clyps', 'cortando', 'vídeos', 'longos', 'em', 'clipes', 'curtos.'];
  const words: Word[] = [];
  for (let t = 0.5, i = 0; t < durationSec - 0.5; t += 0.42, i++) {
    words.push({ word: vocab[i % vocab.length], start: t, end: t + 0.34 });
  }
  return words;
}
