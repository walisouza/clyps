import { config } from './config.js';
import { LLM_GATEWAY, LLM_GENERIC, apiError } from './errors.js';

type Message = { role: 'system' | 'user'; content: string };
type Variant = { label: string; model: string; build: (system: string, user: string) => Record<string, unknown> };

const withSystem = (system: string, user: string): Message[] => [
  { role: 'system', content: system },
  { role: 'user', content: user },
];
const userOnly = (system: string, user: string): Message[] => [{ role: 'user', content: `${system}\n\n---\n\n${user}` }];

/** Modelos de reserva no Gateway, caso o configurado não esteja liberado na conta. */
function fallbackModels(): string[] {
  const raw = process.env.LLM_FALLBACK_MODELS ?? 'gpt-4.1,gemini-2.5-flash';
  return raw.split(',').map((m) => m.trim()).filter((m) => m && m !== config.llmModel);
}

/**
 * Formatos de pedido tentados no LLM Gateway da AssemblyAI, do mais completo ao mais simples.
 * O Gateway responde só "invalid request body" quando algo não é aceito, sem dizer o quê;
 * por isso o Clyps tenta as variações e guarda a que funcionou.
 */
function gatewayVariants(): Variant[] {
  const m = config.llmModel;
  const list: Variant[] = [
    { label: 'system+user, max_tokens 4096', model: m, build: (s, u) => ({ model: m, messages: withSystem(s, u), max_tokens: 4096 }) },
    { label: 'system+user, sem max_tokens', model: m, build: (s, u) => ({ model: m, messages: withSystem(s, u) }) },
    { label: 'só user, max_tokens 2048', model: m, build: (s, u) => ({ model: m, messages: userOnly(s, u), max_tokens: 2048 }) },
  ];
  for (const fm of fallbackModels()) {
    list.push({ label: `modelo ${fm}`, model: fm, build: (s, u) => ({ model: fm, messages: withSystem(s, u), max_tokens: 4096 }) });
  }
  return list;
}

let workingVariant: string | null = null;

function contentOf(json: any): string {
  const c = json?.choices?.[0]?.message?.content;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return typeof c === 'string' ? c : '';
}

async function post(body: Record<string, unknown>, gateway: boolean): Promise<Response> {
  return fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // O Gateway da AssemblyAI recebe a chave pura; APIs no padrão OpenAI usam "Bearer".
      Authorization: gateway ? config.llmApiKey : `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify(body),
  });
}

/** Envia o pedido ao LLM e devolve o texto da resposta. */
export async function chat(system: string, user: string): Promise<string> {
  const gateway = config.llmViaAssemblyAI;

  if (!gateway) {
    const res = await post(
      { model: config.llmModel, messages: withSystem(system, user), response_format: { type: 'json_object' } },
      false,
    );
    if (!res.ok) throw apiError(LLM_GENERIC, res.status, await res.text(), 'LLM_API_KEY');
    return contentOf(await res.json());
  }

  const variants = gatewayVariants();
  // Começa pela variação que já funcionou nesta execução do servidor.
  const ordered = workingVariant
    ? [...variants.filter((v) => v.label === workingVariant), ...variants.filter((v) => v.label !== workingVariant)]
    : variants;

  let last: { status: number; body: string } | null = null;
  for (const v of ordered) {
    const res = await post(v.build(system, user), true);
    if (res.ok) {
      if (workingVariant !== v.label) {
        console.log(`[LLM Gateway] usando a variação "${v.label}" (modelo ${v.model}).`);
        workingVariant = v.label;
      }
      return contentOf(await res.json());
    }
    const body = await res.text();
    last = { status: res.status, body };
    // Só vale tentar outro formato quando o pedido foi recusado pelo conteúdo (400/404/422).
    if (![400, 404, 422].includes(res.status)) break;
    console.warn(`[LLM Gateway] variação "${v.label}" recusada (${res.status}): ${body.slice(0, 300)}`);
  }
  throw apiError(LLM_GATEWAY, last?.status ?? 500, last?.body ?? '', 'ASSEMBLYAI_API_KEY');
}

/** Para o diagnóstico: testa cada variação com um pedido curto e devolve o resultado de cada uma. */
export async function probeGateway(): Promise<{ label: string; status: number; body: string }[]> {
  const out: { label: string; status: number; body: string }[] = [];
  for (const v of gatewayVariants()) {
    const res = await post(v.build('Responda só com JSON.', 'Responda exatamente {"ok":true}'), true);
    out.push({ label: v.label, status: res.status, body: (await res.text()).replace(/\s+/g, ' ').slice(0, 200) });
  }
  return out;
}
