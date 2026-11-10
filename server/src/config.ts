import path from 'node:path';

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Variável de ambiente ausente: ${key}`);
  return v;
}

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

  // Transcrição (API compatível com OpenAI /audio/transcriptions)
  get sttBaseUrl() {
    return process.env.STT_BASE_URL || 'https://api.openai.com/v1';
  },
  get sttApiKey() {
    return required('STT_API_KEY');
  },
  get sttModel() {
    return process.env.STT_MODEL || 'whisper-1';
  },

  // LLM que escolhe os trechos (API compatível com OpenAI /chat/completions)
  get llmBaseUrl() {
    return process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  },
  get llmApiKey() {
    return required('LLM_API_KEY');
  },
  get llmModel() {
    return required('LLM_MODEL');
  },

  maxDurationSeconds: num('MAX_DURATION_SECONDS', 4 * 3600),
  maxUploadBytes: num('MAX_UPLOAD_BYTES', 4 * 1024 ** 3),
  pollIntervalMs: num('POLL_INTERVAL_MS', 3000),
  creditsPerMinute: num('CREDITS_PER_MINUTE', 100),
  get enforceCredits() {
    return process.env.ENFORCE_CREDITS === '1';
  },
  captionFont: process.env.CAPTION_FONT || 'Inter',
};
