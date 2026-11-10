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
  /** MOCK_AI=1 pula transcrição e LLM (gera dados falsos) para testar o pipeline sem chaves. */
  get mock() {
    return process.env.MOCK_AI === '1';
  },
  get supabaseUrl() {
    return required('SUPABASE_URL');
  },
  get supabaseServiceKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY');
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
  pollIntervalMs: num('POLL_INTERVAL_MS', 5000),
  creditsPerMinute: num('CREDITS_PER_MINUTE', 100),
  get enforceCredits() {
    return process.env.ENFORCE_CREDITS === '1';
  },
  captionFont: process.env.CAPTION_FONT || 'Inter',
};
