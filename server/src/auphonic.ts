import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { AUPHONIC, UserError, apiError, sleep } from './errors.js';

/**
 * Configuração do Auphonic para fala gravada com eco e ruído:
 * denoiser dinâmico (mantém voz e música, tira o resto), remoção de reverberação total,
 * nivelador e volume final no padrão das redes sociais (-14 LUFS).
 * As quantidades podem ser ajustadas no .env (em dB; 100 = remoção completa, 0 = automático).
 */
function algorithms() {
  const amount = (key: string, fallback: number) => {
    const v = Number(process.env[key]);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    denoise: true,
    denoisemethod: process.env.AUPHONIC_DENOISE_METHOD || 'dynamic',
    denoiseamount: amount('AUPHONIC_DENOISE_AMOUNT', 100),
    deverbamount: amount('AUPHONIC_DEVERB_AMOUNT', 100),
    leveler: true,
    filtering: true,
    normloudness: true,
    loudnesstarget: -14,
    maxpeak: -1,
  };
}

// Códigos de status do Auphonic: 3 = pronto; 2 = erro; 9 = incompleto; 11 = desatualizado.
const DONE = 3;
const FAILED = new Set([2, 9, 11]);
const TIMEOUT_MS = 30 * 60 * 1000;

const ENV = 'AUPHONIC_API_KEY';

async function call(pathname: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${config.auphonicBaseUrl}${pathname}`, {
    ...init,
    headers: { Authorization: `bearer ${config.auphonicApiKey}`, ...init.headers },
  });
  if (!res.ok) throw apiError(AUPHONIC, res.status, await res.text(), ENV);
  return res.json();
}

/** Só envia a chave (que vai na URL do download) para o próprio Auphonic. */
function assertAuphonicHost(url: string): URL {
  const u = new URL(url, config.auphonicBaseUrl);
  const allowed = new URL(config.auphonicBaseUrl).hostname;
  if (u.hostname !== allowed && !u.hostname.endsWith('.auphonic.com') && u.hostname !== 'auphonic.com') {
    throw new UserError('O Auphonic devolveu um endereço de download inesperado.');
  }
  return u;
}

/** Envia o áudio de um trecho ao Auphonic, espera o processamento e grava o resultado (FLAC) em `output`. */
export async function auphonicEnhance(input: string, output: string): Promise<void> {
  const created = await call('/api/productions.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metadata: { title: `Clyps ${path.basename(input)}` },
      algorithms: algorithms(),
      output_files: [{ format: 'flac' }],
    }),
  });
  const uuid: string | undefined = created?.data?.uuid;
  if (!uuid) throw new UserError('O Auphonic não criou a produção.');

  try {
    const form = new FormData();
    form.append('input_file', new Blob([await readFile(input)], { type: 'audio/flac' }), path.basename(input));
    await call(`/api/production/${uuid}/upload.json`, { method: 'POST', body: form });
    await call(`/api/production/${uuid}/start.json`, { method: 'POST' });

    const started = Date.now();
    for (;;) {
      await sleep(5000);
      const s = await call(`/api/production/${uuid}/status.json`);
      const status = Number(s?.data?.status);
      if (status === DONE) break;
      if (FAILED.has(status) || /error/i.test(String(s?.data?.status_string ?? ''))) {
        throw new UserError(`O Auphonic não conseguiu processar o áudio (${s?.data?.status_string ?? status}).`);
      }
      if (Date.now() - started > TIMEOUT_MS) throw new UserError('O Auphonic demorou demais para processar.');
    }

    const details = await call(`/api/production/${uuid}.json`);
    const file = (details?.data?.output_files ?? []).find((f: any) => f?.download_url);
    if (!file) throw new UserError('O Auphonic não devolveu o arquivo processado.');
    const url = assertAuphonicHost(file.download_url);
    url.searchParams.set('bearer_token', config.auphonicApiKey);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw apiError(AUPHONIC, res.status, await res.text(), ENV);
    await writeFile(output, Buffer.from(await res.arrayBuffer()));
  } finally {
    // Não deixa as produções acumulando na conta do Auphonic.
    await fetch(`${config.auphonicBaseUrl}/api/production/${uuid}.json`, {
      method: 'DELETE',
      headers: { Authorization: `bearer ${config.auphonicApiKey}` },
    }).catch(() => {});
  }
}
