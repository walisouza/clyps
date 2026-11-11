import { config } from './config.js';
import { LLM_GATEWAY, LLM_GENERIC, apiError } from './errors.js';
import { avgEnergy, segmentEnergyScore } from './energy.js';
import { LENGTH_RANGES, type JobOptions, type Selection, type Word } from './types.js';

const WINDOW_SECONDS = 30 * 60;
const LANGUAGE_NAMES = { pt: 'português do Brasil', en: 'English', es: 'español' } as const;
/** Peso da IA na nota final; o restante vem da energia medida no áudio. */
const LLM_WEIGHT = 0.7;

type Line = { start: number; end: number; text: string; words: number };

function toLines(words: Word[]): Line[] {
  const lines: Line[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) {
      lines.push({
        start: cur[0].start,
        end: cur[cur.length - 1].end,
        text: cur.map((w) => w.word.trim()).join(' '),
        words: cur.length,
      });
    }
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - cur[0].start > 8 || w.start - prev.end > 0.8)) flush();
    cur.push(w);
  }
  flush();
  return lines;
}

/**
 * Transcrição em linhas com tempo de início e marcas de energia/ritmo, para o LLM achar os momentos de impacto.
 * Só marca o que foge do normal do próprio vídeo, para não gastar contexto à toa.
 */
export function annotateLines(lines: Line[], norm: number[]): string {
  const quantile = (values: number[], q: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  };
  const rates = lines.map((l) => l.words / Math.max(0.5, l.end - l.start));
  const fastThreshold = lines.length >= 10 ? quantile(rates, 0.8) : Infinity;

  // Energia relativa ao próprio vídeo: as 15% linhas mais intensas são "alta" (com piso absoluto,
  // para um vídeo todo calmo não ganhar marcas) e as 15% mais fracas são "baixa".
  const energies = norm.length ? lines.map((l) => avgEnergy(norm, l.start, l.end)) : [];
  const highThreshold = energies.length ? Math.max(0.5, quantile(energies, 0.85)) : Infinity;
  const lowThreshold = energies.length ? Math.min(0.3, quantile(energies, 0.15)) : -Infinity;

  return lines
    .map((l, i) => {
      const marks: string[] = [];
      if (energies.length) {
        if (energies[i] >= highThreshold) marks.push('energia alta');
        else if (energies[i] <= lowThreshold) marks.push('energia baixa');
      }
      if (rates[i] >= fastThreshold) marks.push('ritmo rápido');
      const tag = marks.length ? ` · ${marks.join(' · ')}` : '';
      return `[${l.start.toFixed(1)}${tag}] ${l.text}`;
    })
    .join('\n');
}

async function askLlm(transcript: string, opts: JobOptions, title: string, wanted: number): Promise<Selection[]> {
  const [min, max] = LENGTH_RANGES[opts.clipLength];
  const lang = LANGUAGE_NAMES[opts.language];
  const system = [
    'Você é um editor de vídeos curtos (Shorts, Reels, TikTok) especialista em retenção.',
    'Recebe a transcrição de um vídeo longo. Cada linha começa com o tempo em segundos entre colchetes.',
    'Algumas linhas trazem marcas medidas no áudio: "energia alta" (voz mais forte, empolgação, ênfase), "energia baixa" e "ritmo rápido" (fala acelerada).',
    '',
    `Escolha até ${wanted} trechos com maior potencial de viralizar. Priorize, nesta ordem:`,
    '1. Gancho forte nos 3 primeiros segundos: pergunta provocativa, afirmação polêmica, número surpreendente ou início de história.',
    '2. Momentos de emoção ou energia: empolgação, indignação, humor, virada de história, frase de efeito. Linhas com "energia alta" ou "ritmo rápido" costumam ser esses momentos.',
    '3. Ideia completa: o trecho se entende sozinho, sem contexto anterior, e termina numa conclusão ou punchline.',
    'Evite trechos de introdução, agradecimentos, leitura de patrocínio e trechos dominados por "energia baixa".',
    '',
    `Cada trecho deve ter entre ${min} e ${max} segundos, começar no início de uma frase e não cortar frases no fim. Não sobreponha trechos.`,
    `Escreva em ${lang}:`,
    '- "title": título curto do clipe, até 70 caracteres.',
    '- "reason": por que esse trecho prende, em uma frase.',
    '- "post": legenda pronta para o post nas redes sociais: 1 a 3 frases curtas, tom natural de criador, pode ter 1 emoji, terminando com 3 a 6 hashtags relevantes.',
    '"score" vai de 0 a 100 (potencial de retenção).',
    'Responda somente com JSON: {"clips":[{"start":number,"end":number,"title":string,"reason":string,"post":string,"score":number}]}.',
    'Se não houver nenhum trecho bom, responda {"clips":[]}.',
  ].join('\n');
  const user = [
    `Título do vídeo: ${title}`,
    opts.context ? `Contexto do criador: ${opts.context}` : '',
    '',
    'Transcrição:',
    transcript,
  ].filter(Boolean).join('\n');

  const gateway = config.llmViaAssemblyAI;
  const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // O Gateway da AssemblyAI recebe a chave pura; APIs no padrão OpenAI usam "Bearer".
      Authorization: gateway ? config.llmApiKey : `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(gateway ? { max_tokens: 4096 } : { response_format: { type: 'json_object' } }),
    }),
  });
  if (!res.ok) {
    throw apiError(gateway ? LLM_GATEWAY : LLM_GENERIC, res.status, await res.text(), gateway ? 'ASSEMBLYAI_API_KEY' : 'LLM_API_KEY');
  }
  const json: any = await res.json();
  const content: string = json.choices?.[0]?.message?.content ?? '';
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const clips = Array.isArray(parsed.clips) ? parsed.clips : [];
  return clips.map((c: any) => ({
    start: Number(c.start),
    end: Number(c.end),
    title: String(c.title ?? '').slice(0, 120) || 'Clipe',
    reason: String(c.reason ?? '').slice(0, 400),
    post: String(c.post ?? '').slice(0, 2200) || undefined,
    score: Math.max(0, Math.min(100, Math.round(Number(c.score) || 0))),
  }));
}

/**
 * Ajusta os tempos às palavras reais, valida duração, mede a energia de cada trecho,
 * combina com a nota da IA e remove sobreposições.
 */
export function refine(
  selections: Selection[],
  words: Word[],
  opts: JobOptions,
  videoDuration: number,
  norm: number[] = [],
): Selection[] {
  const [min, max] = LENGTH_RANGES[opts.clipLength];
  const tolMin = Math.max(8, min * 0.6);
  const tolMax = max * 1.25;

  const snapped = selections
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => {
      const inside = words.filter((w) => w.end > s.start - 0.3 && w.start < s.end + 0.3);
      if (!inside.length) return null;
      const start = Math.max(0, inside[0].start - 0.15);
      const end = Math.min(videoDuration, inside[inside.length - 1].end + 0.35);
      if (!norm.length) return { ...s, start, end };
      const energy = segmentEnergyScore(norm, start, end);
      return { ...s, start, end, energy, score: Math.round(LLM_WEIGHT * s.score + (1 - LLM_WEIGHT) * energy) };
    })
    .filter((s): s is Selection => s !== null && s.end - s.start >= tolMin && s.end - s.start <= tolMax)
    .sort((a, b) => b.score - a.score);

  const kept: Selection[] = [];
  for (const s of snapped) {
    if (kept.length >= opts.maxClips) break;
    if (kept.every((k) => s.end <= k.start || s.start >= k.end)) kept.push(s);
  }
  return kept;
}

export async function selectClips(
  words: Word[],
  opts: JobOptions,
  title: string,
  videoDuration: number,
  norm: number[] = [],
): Promise<Selection[]> {
  if (!words.length) return [];
  const windows = Math.max(1, Math.ceil(videoDuration / WINDOW_SECONDS));
  const perWindow = Math.max(2, Math.ceil((opts.maxClips * 1.5) / windows));
  const found: Selection[] = [];
  for (let i = 0; i < windows; i++) {
    const from = i * WINDOW_SECONDS;
    const slice = words.filter((w) => w.start >= from && w.start < from + WINDOW_SECONDS);
    if (slice.length < 30) continue;
    found.push(...(await askLlm(annotateLines(toLines(slice), norm), opts, title, perWindow)));
  }
  return refine(found, words, opts, videoDuration, norm);
}

/**
 * Seleção para testes (MOCK_AI=1), sem IA: escolhe as janelas de maior energia do áudio.
 * Já mostra o efeito da análise de energia mesmo sem chaves configuradas.
 */
export function mockSelect(words: Word[], opts: JobOptions, videoDuration: number, norm: number[] = []): Selection[] {
  const [min] = LENGTH_RANGES[opts.clipLength];
  const length = Math.min(min + 5, videoDuration * 0.8);
  const candidates: Selection[] = [];
  for (let start = 0.5; start + length <= videoDuration; start += 2) {
    const energy = segmentEnergyScore(norm, start, start + length);
    candidates.push({
      start,
      end: start + length,
      title: 'Clipe de teste',
      reason: `Modo de teste: trecho escolhido só pela energia do áudio (${energy}/100).`,
      score: energy,
    });
  }
  // Sem análise de energia (norm vazio), mantém trechos espaçados pelo vídeo.
  if (!norm.length) candidates.forEach((c, i) => (c.score = 100 - (i % 50)));

  // Pré-seleção gulosa sem sobreposição antes do refine (que percorre as palavras de cada candidato).
  const shortlist: Selection[] = [];
  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    if (shortlist.length >= opts.maxClips * 2) break;
    if (shortlist.every((k) => c.end <= k.start || c.start >= k.end)) shortlist.push(c);
  }
  const picked = refine(shortlist, words, opts, videoDuration, norm);
  return picked.map((s, i) => ({
    ...s,
    title: `Clipe de teste ${i + 1}`,
    post: `Clipe de teste ${i + 1} gerado pelo Clyps 🎬 Com as chaves de IA configuradas, aqui aparece uma legenda escrita a partir do que é falado no trecho.\n\n#cortes #clyps #shorts #reels`,
  }));
}
