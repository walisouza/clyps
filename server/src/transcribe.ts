import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from 'undici';
import { config } from './config.js';
import { ASSEMBLYAI, UserError, apiError, sleep } from './errors.js';
import { SEGMENT_SECONDS } from './media.js';
import type { Word } from './types.js';

type SttTarget = { baseUrl: string; apiKey: string; model: string; service: string };

/**
 * Sem limite de tempo de resposta: no Speaches (CPU da VPS) cada parte pode levar vários minutos,
 * e o fetch do Node desiste depois de 5 min esperando os cabeçalhos.
 */
const patientAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 });

function sttTarget(): SttTarget {
  if (config.sttProvider === 'speaches') {
    return { baseUrl: config.speachesUrl, apiKey: 'local', model: config.speachesModel, service: 'Speaches' };
  }
  return { baseUrl: config.sttBaseUrl, apiKey: config.sttApiKey, model: config.sttModel, service: 'serviço de transcrição' };
}

async function transcribeFile(target: SttTarget, file: string, language: string): Promise<Word[]> {
  const form = new FormData();
  form.append('file', new Blob([await readFile(file)], { type: 'audio/mpeg' }), path.basename(file));
  form.append('model', target.model);
  form.append('language', language);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');

  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${target.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${target.apiKey}` },
        body: form,
        dispatcher: patientAgent,
      } as RequestInit);
    } catch (err) {
      lastError = `sem conexão (${(err as Error).message})`;
      await sleep(attempt * 5000);
      continue;
    }
    if (res.ok) {
      const json: any = await res.json();
      const words = Array.isArray(json.words) ? json.words : [];
      return words.map((w: any) => ({ word: String(w.word), start: Number(w.start), end: Number(w.end) }));
    }
    lastError = `${res.status} ${(await res.text()).slice(0, 300)}`;
    if (res.status < 500 && res.status !== 429) break;
    await sleep(attempt * 3000);
  }
  throw new UserError(`O ${target.service} não conseguiu transcrever o áudio: ${lastError.slice(0, 200)}`);
}

/**
 * Speaches: espera o container responder e garante que o modelo está baixado.
 * Na primeira vez o download leva alguns minutos (o PRELOAD_MODELS do compose costuma adiantar isso).
 */
export async function ensureSpeachesReady(onWait?: (msg: string) => void): Promise<void> {
  const base = config.speachesUrl;
  const root = base.replace(/\/v1$/, '');
  const model = encodeURIComponent(config.speachesModel).replace(/%2F/g, '/');

  const started = Date.now();
  for (;;) {
    try {
      const health = await fetch(`${root}/health`);
      if (health.ok) break;
    } catch {
      /* ainda subindo */
    }
    if (Date.now() - started > 5 * 60_000) {
      throw new UserError('O Speaches não respondeu. Confira se o container está rodando: docker compose ps');
    }
    onWait?.('Aguardando o Speaches iniciar');
    await sleep(5000);
  }

  const info = await fetch(`${base}/models/${model}`);
  if (info.ok) return;
  if (info.status !== 404) {
    throw new UserError(`O Speaches respondeu com erro (${info.status}) ao consultar o modelo ${config.speachesModel}.`);
  }
  onWait?.(`Baixando o modelo ${config.speachesModel} (só na primeira vez)`);
  const dl = await fetch(`${base}/models/${model}`, { method: 'POST', dispatcher: patientAgent } as RequestInit);
  if (!dl.ok && dl.status !== 409) {
    throw new UserError(
      `O Speaches não conseguiu baixar o modelo ${config.speachesModel} (${dl.status}): ${(await dl.text()).slice(0, 160)}`,
    );
  }
}

/** Transcreve as partes de áudio em ordem e devolve palavras com tempo absoluto. */
export async function transcribe(
  segments: string[],
  language: string,
  onProgress: (done: number, total: number) => Promise<void>,
  segmentSeconds = SEGMENT_SECONDS,
): Promise<Word[]> {
  const target = sttTarget();
  const all: Word[] = [];
  for (let i = 0; i < segments.length; i++) {
    const offset = i * segmentSeconds;
    const words = await transcribeFile(target, segments[i], language);
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
