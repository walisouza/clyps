import { config } from './config.js';
import { LLM_GATEWAY, LLM_GENERIC, UserError, apiError, sleep } from './errors.js';

type Message = { role: 'system' | 'user'; content: string };
type Variant = { label: string; model: string; build: (system: string, user: string) => Record<string, unknown> };

const withSystem = (system: string, user: string): Message[] => [
  { role: 'system', content: system },
  { role: 'user', content: user },
];
const userOnly = (system: string, user: string): Message[] => [{ role: 'user', content: `${system}\n\n---\n\n${user}` }];

/** Modelos reserva para serviços no padrão OpenAI (ex.: LLM_FALLBACK_MODELS=gemini-2.5-flash). */
function genericFallbackModels(): string[] {
  return (process.env.LLM_FALLBACK_MODELS ?? '').split(',').map((m) => m.trim()).filter((m) => m && m !== config.llmModel);
}

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

/** Esperas entre tentativas quando o serviço está sobrecarregado ou instável (429/5xx). */
const RETRY_DELAYS_MS = (process.env.LLM_RETRY_DELAYS ?? '5000,15000,30000')
  .split(',')
  .map(Number)
  .filter((n) => Number.isFinite(n) && n >= 0);
const TRANSIENT = new Set([429, 500, 502, 503, 504, 529]);

/** Envia e, se a resposta for de sobrecarga/instabilidade, espera e tenta de novo. */
async function post(body: Record<string, unknown>, gateway: boolean): Promise<Response> {
  let res: Response | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      res = await postOnce(body, gateway);
      if (!TRANSIENT.has(res.status)) return res;
      console.warn(`[LLM] ${body.model}: HTTP ${res.status} (tentativa ${attempt + 1}); tentando de novo.`);
    } catch (err) {
      if (attempt === RETRY_DELAYS_MS.length) throw err;
      console.warn(`[LLM] ${body.model}: sem conexão (tentativa ${attempt + 1}); tentando de novo.`);
    }
    if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
  }
  return res!;
}

async function postOnce(body: Record<string, unknown>, gateway: boolean): Promise<Response> {
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
    // Modelo principal e, se ele seguir sobrecarregado, os reservas de LLM_FALLBACK_MODELS.
    const models = [config.llmModel, ...genericFallbackModels()];
    let failure: { status: number; body: string } | null = null;
    for (const model of models) {
      const base = { model, messages: withSystem(system, user) };
      let res = await post({ ...base, response_format: { type: 'json_object' } }, false);
      // Alguns provedores compatíveis não aceitam response_format: o Clyps já extrai o JSON do texto.
      if (res.status === 400) res = await post(base, false);
      if (res.ok) {
        if (model !== config.llmModel) console.log(`[LLM] usando o modelo reserva ${model}.`);
        return contentOf(await res.json());
      }
      failure = { status: res.status, body: await res.text() };
      // Só troca de modelo quando o problema é do modelo (sobrecarga ou inexistente), não da chave.
      if (!TRANSIENT.has(res.status) && res.status !== 404) break;
    }
    throw apiError(LLM_GENERIC, failure!.status, failure!.body, 'LLM_API_KEY');
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
  if (last && /does not have access/i.test(last.body)) {
    throw new UserError(
      'Sua conta da AssemblyAI não tem acesso ao LLM Gateway (ele não faz parte do plano gratuito). ' +
        'Cadastre um cartão na conta da AssemblyAI para liberar, ou configure LLM_API_KEY, LLM_BASE_URL e LLM_MODEL de outro provedor no .env.',
    );
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
