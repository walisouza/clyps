/** Erro com mensagem que pode ser mostrada ao usuário. */
export class UserError extends Error {}

/** Nome do serviço com o artigo certo, para as mensagens saírem em bom português. */
export type Service = { name: string; article: 'o' | 'a' };
export const ASSEMBLYAI: Service = { name: 'AssemblyAI', article: 'a' };
export const AUPHONIC: Service = { name: 'Auphonic', article: 'o' };
export const LLM_GATEWAY: Service = { name: 'LLM Gateway da AssemblyAI', article: 'o' };
export const LLM_GENERIC: Service = { name: 'serviço de IA', article: 'o' };

/** Converte a resposta de erro de um serviço externo numa mensagem clara, sem expor detalhes internos. */
export function apiError(service: Service, status: number, body: string, envVar?: string): UserError {
  const subject = `${service.article === 'a' ? 'A' : 'O'} ${service.name}`;
  const text = body.toLowerCase();
  if (status === 401 || status === 403) {
    return new UserError(`${subject} recusou a chave${envVar ? ` (${envVar} no .env)` : ''}. Confira se ela está correta e ativa.`);
  }
  if (status === 402 || /insufficient|balance|credit|quota|payment/.test(text)) {
    return new UserError(`Acabaram os créditos ${service.article === 'a' ? 'na' : 'no'} ${service.name}. Recarregue a conta para continuar.`);
  }
  if (status === 429) return new UserError(`${subject} está limitando as requisições. Tente de novo em alguns minutos.`);
  console.error(`[${service.name}] HTTP ${status}: ${body.slice(0, 500)}`);
  return new UserError(`${subject} respondeu com erro (${status}). Tente de novo.`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
