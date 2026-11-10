import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { SEGMENT_SECONDS } from './media.js';
import { UserError } from './errors.js';
import type { Word } from './types.js';

export function parseTranscript(json: any): Word[] {
  if (!Array.isArray(json.words)) {
    if (!String(json.text ?? '').trim()) return [];
    throw new UserError('O serviço de transcrição não retornou tempos por palavra. Configure um modelo compatível, como whisper-1.');
  }
  const words: Word[] = [];
  for (const item of json.words) {
    const word = String(item.word ?? '').trim();
    const start = Number(item.start), end = Number(item.end);
    if (!word || item.start == null || item.end == null || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end <= start || end > SEGMENT_SECONDS + 2) {
      throw new UserError('O serviço retornou tempos de legenda inválidos. Tente transcrever novamente.');
    }
    words.push({ word, start, end });
  }
  if (!words.length && String(json.text ?? '').trim()) {
    throw new UserError('A transcrição retornou texto sem tempos por palavra. Verifique o modelo de transcrição.');
  }
  return words.sort((a, b) => a.start - b.start);
}

export async function transcribeFile(file: string, language: string): Promise<Word[]> {
  const form = new FormData();
  form.append('file', new Blob([await readFile(file)], { type: 'audio/mpeg' }), path.basename(file));
  form.append('model', config.sttModel);
  form.append('language', language);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${config.sttBaseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.sttApiKey}` }, body: form,
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      if (attempt === 3) throw new UserError('Não foi possível conectar ao serviço de transcrição. Tente novamente.');
      await new Promise(r => setTimeout(r, attempt * 1500));
      continue;
    }
    if (res.ok) {
      let json: any;
      try { json = await res.json(); } catch { throw new UserError('Resposta inválida do serviço de transcrição.'); }
      return parseTranscript(json);
    }
    if (res.status === 401 || res.status === 403) throw new UserError('A chave de transcrição foi recusada. Verifique STT_API_KEY no servidor.');
    if (res.status === 400) throw new UserError('O serviço recusou o áudio ou o modelo. Use um modelo com verbose_json e tempos por palavra, como whisper-1.');
    if ((res.status < 500 && res.status !== 429) || attempt === 3) {
      throw new UserError(res.status === 429 ? 'Limite ou saldo do serviço de transcrição atingido. Verifique a conta da API.' : 'O serviço de transcrição está indisponível. Tente novamente.');
    }
    await new Promise(r => setTimeout(r, attempt * 3000));
  }
  throw new UserError('Não foi possível transcrever o áudio.');
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
