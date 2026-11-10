import { config } from './config.js';
import { LENGTH_RANGES, type JobOptions, type Selection, type Word } from './types.js';

const WINDOW_SECONDS = 30 * 60;
const LANGUAGE_NAMES = { pt: 'português do Brasil', en: 'English', es: 'español' } as const;

/** Transcrição em linhas curtas com o tempo de início, para o LLM citar tempos reais. */
function toLines(words: Word[]): string {
  const lines: string[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) lines.push(`[${cur[0].start.toFixed(1)}] ${cur.map((w) => w.word.trim()).join(' ')}`);
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - cur[0].start > 8 || w.start - prev.end > 0.8)) flush();
    cur.push(w);
  }
  flush();
  return lines.join('\n');
}

async function askLlm(transcript: string, opts: JobOptions, title: string, wanted: number): Promise<Selection[]> {
  const [min, max] = LENGTH_RANGES[opts.clipLength];
  const system = [
    'Você é um editor de vídeos curtos (Shorts, Reels, TikTok).',
    'Recebe a transcrição de um vídeo longo, com o tempo de início de cada linha em segundos entre colchetes.',
    `Escolha até ${wanted} trechos que funcionem sozinhos como clipe: começam com um gancho forte, têm uma ideia completa e terminam numa conclusão, sem cortar frases no meio.`,
    `Cada trecho deve ter entre ${min} e ${max} segundos. Não sobreponha trechos.`,
    `Escreva "title" e "reason" em ${LANGUAGE_NAMES[opts.language]}. "title" tem no máximo 70 caracteres. "score" vai de 0 a 100 (potencial de retenção).`,
    'Responda somente com JSON no formato {"clips":[{"start":number,"end":number,"title":string,"reason":string,"score":number}]}.',
    'Se não houver nenhum trecho bom, responda {"clips":[]}.',
  ].join('\n');
  const user = [
    `Título do vídeo: ${title}`,
    opts.context ? `Contexto do criador: ${opts.context}` : '',
    '',
    'Transcrição:',
    transcript,
  ].filter(Boolean).join('\n');

  const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llmApiKey}` },
    body: JSON.stringify({
      model: config.llmModel,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Falha no LLM: ${res.status} ${(await res.text()).slice(0, 300)}`);
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
    score: Math.max(0, Math.min(100, Math.round(Number(c.score) || 0))),
  }));
}

/** Ajusta os tempos às palavras reais, valida duração e remove sobreposições. */
export function refine(selections: Selection[], words: Word[], opts: JobOptions, videoDuration: number): Selection[] {
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
      return { ...s, start, end };
    })
    .filter((s): s is Selection => s !== null && s.end - s.start >= tolMin && s.end - s.start <= tolMax)
    .sort((a, b) => b.score - a.score);

  const kept: Selection[] = [];
  for (const s of snapped) {
    if (kept.length >= opts.maxClips) break;
    if (kept.every((k) => s.end <= k.start || s.start >= k.end)) kept.push(s);
  }
  return kept.sort((a, b) => b.score - a.score);
}

export async function selectClips(words: Word[], opts: JobOptions, title: string, videoDuration: number): Promise<Selection[]> {
  if (!words.length) return [];
  const windows = Math.max(1, Math.ceil(videoDuration / WINDOW_SECONDS));
  const perWindow = Math.max(2, Math.ceil((opts.maxClips * 1.5) / windows));
  const found: Selection[] = [];
  for (let i = 0; i < windows; i++) {
    const from = i * WINDOW_SECONDS;
    const slice = words.filter((w) => w.start >= from && w.start < from + WINDOW_SECONDS);
    if (slice.length < 30) continue;
    found.push(...(await askLlm(toLines(slice), opts, title, perWindow)));
  }
  return refine(found, words, opts, videoDuration);
}

/** Seleção falsa para testes (MOCK_AI=1): trechos espaçados ao longo do vídeo. */
export function mockSelect(words: Word[], opts: JobOptions, videoDuration: number): Selection[] {
  const [min] = LENGTH_RANGES[opts.clipLength];
  const length = Math.min(min + 5, videoDuration * 0.8);
  const count = Math.max(1, Math.min(opts.maxClips, Math.floor(videoDuration / (length + 2))));
  const step = videoDuration / count;
  const picks: Selection[] = Array.from({ length: count }, (_, i) => ({
    start: i * step + 0.5,
    end: i * step + 0.5 + length,
    title: `Clipe de teste ${i + 1}`,
    reason: 'Seleção simulada (MOCK_AI=1).',
    score: 90 - i * 5,
  }));
  return refine(picks, words, opts, videoDuration);
}
