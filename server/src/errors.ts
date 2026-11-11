/** Erro com mensagem que pode ser mostrada ao usuário. */
export class UserError extends Error {}

/** Nome do serviço com o artigo certo, para as mensagens saírem em bom português. */
export type Service = { name: string; article: 'o' | 'a' };
export const ASSEMBLYAI: Service = { name: 'AssemblyAI', article: 'a' };
export const AUPHONIC: Service = { name: 'Auphonic', article: 'o' };
export const LLM_GATEWAY: Service = { name: 'LLM Gateway da AssemblyAI', article: 'o' };
export const LLM_GENERIC: Service = { name: 'serviço de IA', article: 'o' };

/** Converte a resposta de erro de um serviço externo numa mensagem clara, sem expor detalhes internos. */
/** Extrai a mensagem de erro que o serviço mandou (campos comuns em JSON), curta e sem quebras. */
function serviceMessage(body: string): string {
  let msg = body;
  try {
    const j = JSON.parse(body);
    // O Gateway da AssemblyAI põe o motivo real em metadata.errors; "message" é genérico.
    msg = String(j?.metadata?.errors?.[0] ?? j?.error?.message ?? j?.error_message ?? j?.error ?? j?.message ?? j?.detail ?? body);
  } catch {
    /* corpo não é JSON */
  }
  msg = msg.replace(/\s+/g, ' ').trim().slice(0, 160);
  return msg && !/^<!doctype|^<html/i.test(msg) ? ` Resposta: “${msg}”` : '';
}

export function apiError(service: Service, status: number, body: string, envVar?: string): UserError {
  const subject = `${service.article === 'a' ? 'A' : 'O'} ${service.name}`;
  const text = body.toLowerCase();
  const detail = serviceMessage(body);
  if (status === 401) {
    return new UserError(`${subject} recusou a chave${envVar ? ` (${envVar} no .env)` : ''}. Confira se ela está correta e ativa.${detail}`);
  }
  if (status === 403) {
    return new UserError(`${subject} negou o acesso (403). Pode ser a conta sem permissão para esse recurso ou um bloqueio de rede da VPS.${detail}`);
  }
  if (status === 402 || /insufficient|balance|credit|quota|payment/.test(text)) {
    return new UserError(`Acabaram os créditos ${service.article === 'a' ? 'na' : 'no'} ${service.name}. Recarregue a conta para continuar.`);
  }
  if (status === 429) return new UserError(`${subject} está limitando as requisições. Tente de novo em alguns minutos.`);
  console.error(`[${service.name}] HTTP ${status}: ${body.slice(0, 500)}`);
  return new UserError(`${subject} respondeu com erro (${status}). Tente de novo.${detail}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
