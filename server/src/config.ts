import path from 'node:path';

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Variável de ambiente ausente: ${key}`);
  return v;
}

/** Lê uma chave do .env sem espaços, quebra de linha do Windows (\r) ou aspas em volta. */
function secret(key: string): string {
  return (process.env[key] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

/** true se a chave ainda é o texto de exemplo das instruções. */
export const isPlaceholder = (v: string) => /cole_a_chave|cole_aqui|sua_chave|your[_-]?key/i.test(v);

function num(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  /** MOCK_AI=1 pula transcrição e LLM (gera dados falsos) para testar sem chaves. */
  get mock() {
    return process.env.MOCK_AI === '1';
  },

  port: num('PORT', 3000),
  /** Banco (SQLite), uploads e clipes ficam aqui. */
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  /** Build do app web servido pelo próprio servidor. */
  webDir: path.resolve(process.env.WEB_DIR || '../web/dist'),
  /** Por padrão só a primeira conta pode ser criada; ALLOW_SIGNUP=1 abre o cadastro. */
  get allowSignup() {
    return process.env.ALLOW_SIGNUP === '1';
  },

  // AssemblyAI: transcrição com tempo por palavra e, pela mesma chave, o LLM Gateway.
  get assemblyaiApiKey() {
    return secret('ASSEMBLYAI_API_KEY');
  },
  assemblyaiBaseUrl: process.env.ASSEMBLYAI_BASE_URL || 'https://api.assemblyai.com',

  /** Qual serviço transcreve: AssemblyAI se houver chave; senão, API compatível com OpenAI. */
  get sttProvider(): 'assemblyai' | 'openai' | null {
    if (this.assemblyaiApiKey) return 'assemblyai';
    if (secret('STT_API_KEY')) return 'openai';
    return null;
  },

  // Auphonic: tratamento profissional de voz (ruído e eco), por clipe.
  get auphonicApiKey() {
    return secret('AUPHONIC_API_KEY');
  },
  auphonicBaseUrl: process.env.AUPHONIC_BASE_URL || 'https://auphonic.com',

  // Transcrição alternativa (API compatível com OpenAI /audio/transcriptions)
  get sttBaseUrl() {
    return process.env.STT_BASE_URL || 'https://api.openai.com/v1';
  },
  get sttApiKey() {
    return secret('STT_API_KEY') || required('STT_API_KEY');
  },
  get sttModel() {
    return process.env.STT_MODEL || 'whisper-1';
  },

  // LLM que escolhe os trechos e escreve as legendas.
  // Sem LLM_API_KEY, usa o LLM Gateway da AssemblyAI com a mesma chave da transcrição.
  /** true quando o LLM é o Gateway da AssemblyAI (autenticação sem "Bearer", sem response_format). */
  get llmViaAssemblyAI() {
    return !secret('LLM_API_KEY') && Boolean(this.assemblyaiApiKey);
  },
  get llmBaseUrl() {
    const custom = process.env.LLM_BASE_URL;
    // Um .env antigo traz LLM_BASE_URL da OpenAI; com a chave da AssemblyAI ele é ignorado.
    if (custom && !(this.llmViaAssemblyAI && /api\.openai\.com/.test(custom))) return custom;
    return this.llmViaAssemblyAI ? 'https://llm-gateway.assemblyai.com/v1' : 'https://api.openai.com/v1';
  },
  get llmApiKey() {
    return secret('LLM_API_KEY') || this.assemblyaiApiKey || required('LLM_API_KEY');
  },
  get llmModel() {
    return process.env.LLM_MODEL || (this.llmViaAssemblyAI ? 'claude-sonnet-4-6' : required('LLM_MODEL'));
  },

  maxDurationSeconds: num('MAX_DURATION_SECONDS', 4 * 3600),
  maxUploadBytes: num('MAX_UPLOAD_BYTES', 4 * 1024 ** 3),
  pollIntervalMs: num('POLL_INTERVAL_MS', 3000),
  creditsPerMinute: num('CREDITS_PER_MINUTE', 100),
  get enforceCredits() {
    return process.env.ENFORCE_CREDITS === '1';
  },
  captionFont: process.env.CAPTION_FONT || 'Inter',
  /** Modelo RNNoise usado no tratamento de voz "forte" (ausente = etapa pulada). */
  rnnoiseModel: process.env.RNNOISE_MODEL || '/usr/share/clyps/std.rnnn',
};
