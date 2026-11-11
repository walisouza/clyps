import { config } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Trend Scanner: o que está em alta no Google (Brasil) e no nicho escolhido.
// - Em alta agora: RSS público do Google Trends (sem chave).
// - Nicho: consultas em alta e mais buscadas relacionadas a termos-semente do nicho,
//   pela mesma API que a página do Google Trends usa (pública, mas limitada; se o
//   Google recusar, a lista do nicho fica com a última leitura que deu certo).
// Tudo fica em cache na memória; a página e as legendas leem do cache.
// ─────────────────────────────────────────────────────────────────────────────

export type TrendNews = { title: string; url: string; source: string };
export type Trend = {
  title: string;
  traffic: string;
  startedAt: string | null;
  picture: string | null;
  news: TrendNews[];
  niche: boolean;
  hashtag: string;
};
export type NicheQuery = { query: string; value: string; kind: 'rising' | 'top'; seed: string; hashtag: string };

type Snapshot = {
  geo: string;
  niche: { name: string; seeds: string[] };
  trending: Trend[];
  nicheQueries: NicheQuery[];
  trendingAt: string | null;
  nicheAt: string | null;
  trendingError: string | null;
  nicheError: string | null;
};

const GEO = () => (process.env.TRENDS_GEO ?? '').trim().toUpperCase() || 'BR';
const NICHE_NAME = () => (process.env.TRENDS_NICHE_NAME ?? '').trim() || 'Gospel e igreja';
const SEEDS = () =>
  ((process.env.TRENDS_SEEDS ?? '').trim() || 'gospel,louvor,pregação,igreja,culto')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);

/** Palavras que marcam um assunto como do nicho (comparação sem acento e em minúsculas). */
const NICHE_WORDS = () =>
  ((process.env.TRENDS_NICHE_WORDS ?? '').trim() ||
    'gospel,louvor,igreja,culto,pastor,pastora,pregacao,pregador,deus,jesus,cristo,biblia,biblico,fe,oracao,evangelico,evangelica,cristao,crista,ministerio,adoracao,worship,apostolo,bispo,missionario,padre,papa,catolico,catolica,missa,santo,santa,salmo,versiculo,avivamento,profecia,batismo,hino,harpa,cantor gospel,cantora gospel,teologia,espirito santo,natal,pascoa,retiro,conferencia,congresso,marcha para jesus')
    .split(',')
    .map((w) => norm(w.trim()))
    .filter(Boolean);

/** Hashtags do nicho que sempre aparecem como sugestão. */
export const NICHE_BASE_TAGS = () =>
  ((process.env.TRENDS_BASE_TAGS ?? '').trim() || '#gospel,#fe,#jesus,#igreja,#pregacao,#louvor,#deus,#palavradedeus')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

const TRENDING_TTL = 30 * 60 * 1000;
const NICHE_TTL = 6 * 3600 * 1000;
const MIN_FORCE_INTERVAL = 5 * 60 * 1000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function toHashtag(s: string): string {
  const words = norm(s).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean);
  const tag = words.join('').slice(0, 30);
  return tag ? `#${tag}` : '';
}

function isNiche(text: string): boolean {
  const t = ` ${norm(text).replace(/[^a-z0-9 ]/g, ' ')} `;
  return NICHE_WORDS().some((w) => t.includes(` ${w} `));
}

// ── Cache ──
const snap: Snapshot = {
  geo: GEO(),
  niche: { name: NICHE_NAME(), seeds: SEEDS() },
  trending: [],
  nicheQueries: [],
  trendingAt: null,
  nicheAt: null,
  trendingError: null,
  nicheError: null,
};
let trendingPromise: Promise<void> | null = null;
let nichePromise: Promise<void> | null = null;
let lastForced = 0;

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
};

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; cookies: string[] }> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9', ...headers }, signal: AbortSignal.timeout(20_000) });
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, text: await res.text(), cookies };
}

async function loadTrending(): Promise<void> {
  try {
    const r = await get(`https://trends.google.com/trending/rss?geo=${GEO()}`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const items = r.text.split('<item>').slice(1).map((chunk) => chunk.split('</item>')[0]);
    const list: Trend[] = items.map((it) => {
      const news = it
        .split('<ht:news_item>')
        .slice(1)
        .map((n) => ({
          title: tag(n, 'ht:news_item_title'),
          url: tag(n, 'ht:news_item_url'),
          source: tag(n, 'ht:news_item_source'),
        }))
        .filter((n) => n.title && /^https?:\/\//.test(n.url))
        .slice(0, 3);
      const title = tag(it, 'title');
      const date = tag(it, 'pubDate');
      const picture = tag(it, 'ht:picture');
      return {
        title,
        traffic: tag(it, 'ht:approx_traffic'),
        startedAt: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
        picture: /^https:\/\//.test(picture) ? picture : null,
        news,
        niche: isNiche(`${title} ${news.map((n) => n.title).join(' ')}`),
        hashtag: toHashtag(title),
      };
    });
    if (!list.length) throw new Error('lista vazia');
    snap.trending = list.filter((t) => t.title);
    snap.trendingAt = new Date().toISOString();
    snap.trendingError = null;
  } catch (err) {
    console.error('[trends] em alta:', err);
    snap.trendingError = `Não foi possível ler o Google Trends agora (${(err as Error).message}).`;
  }
}

/** A API interna do Google Trends responde com um prefixo anti-JSON-hijacking antes do JSON. */
const parseGoogleJson = (text: string) => JSON.parse(text.slice(text.indexOf('{')));

async function loadNiche(): Promise<void> {
  const hl = 'pt-BR';
  const tz = '180';
  const out: NicheQuery[] = [];
  let failures = 0;
  let lastError = '';
  try {
    // Cookie de sessão: sem ele o Google costuma responder 429.
    const home = await get(`https://trends.google.com/trends/?geo=${GEO()}`);
    const cookie = home.cookies.map((c) => c.split(';')[0]).join('; ');
    for (const seed of SEEDS()) {
      try {
        const req = { comparisonItem: [{ keyword: seed, geo: GEO(), time: 'now 7-d' }], category: 0, property: '' };
        const ex = await get(
          `https://trends.google.com/trends/api/explore?hl=${hl}&tz=${tz}&req=${encodeURIComponent(JSON.stringify(req))}`,
          cookie ? { Cookie: cookie } : {},
        );
        if (ex.status !== 200) throw new Error(`HTTP ${ex.status}`);
        const widget = (parseGoogleJson(ex.text).widgets as { id: string; token: string; request: unknown }[]).find((w) => w.id === 'RELATED_QUERIES');
        if (!widget) throw new Error('sem consultas relacionadas');
        const rel = await get(
          `https://trends.google.com/trends/api/widgetdata/relatedsearches?hl=${hl}&tz=${tz}&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${encodeURIComponent(widget.token)}`,
          cookie ? { Cookie: cookie } : {},
        );
        if (rel.status !== 200) throw new Error(`HTTP ${rel.status}`);
        const lists = parseGoogleJson(rel.text).default?.rankedList ?? [];
        const pick = (i: number, kind: 'top' | 'rising', n: number) =>
          ((lists[i]?.rankedKeyword ?? []) as { query: string; formattedValue?: string; value?: number }[]).slice(0, n).forEach((k) =>
            out.push({ query: k.query, value: String(k.formattedValue ?? k.value ?? ''), kind, seed, hashtag: toHashtag(k.query) }),
          );
        pick(1, 'rising', 8);
        pick(0, 'top', 5);
      } catch (err) {
        failures++;
        lastError = (err as Error).message;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!out.length) throw new Error(lastError || 'sem resultados');
    // Remove repetidas (a mesma busca pode vir de sementes diferentes).
    const seen = new Set<string>();
    snap.nicheQueries = out.filter((q) => {
      const k = norm(q.query);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    snap.nicheAt = new Date().toISOString();
    snap.nicheError = failures ? `Parte dos termos não respondeu (${lastError}).` : null;
  } catch (err) {
    console.error('[trends] nicho:', err);
    snap.nicheError = /429/.test(String((err as Error).message))
      ? 'O Google limitou as consultas do nicho por agora. Mostrando a última leitura; tente de novo mais tarde.'
      : `Não foi possível ler as buscas do nicho agora (${(err as Error).message}).`;
  }
}

function refreshTrending(): Promise<void> {
  trendingPromise ??= loadTrending().finally(() => (trendingPromise = null));
  return trendingPromise;
}
function refreshNiche(): Promise<void> {
  nichePromise ??= loadNiche().finally(() => (nichePromise = null));
  return nichePromise;
}

const stale = (at: string | null, ttl: number) => !at || Date.now() - Date.parse(at) > ttl;

/** Devolve o que está em cache; se estiver velho, atualiza (espera só se ainda não houver nada). */
export async function getTrends(force = false): Promise<Snapshot & { refreshing: boolean }> {
  if (force && Date.now() - lastForced > MIN_FORCE_INTERVAL) {
    lastForced = Date.now();
    snap.trendingAt = null;
    snap.nicheAt = null;
  }
  const waits: Promise<void>[] = [];
  if (stale(snap.trendingAt, TRENDING_TTL)) {
    const p = refreshTrending();
    if (!snap.trending.length) waits.push(p);
  }
  if (stale(snap.nicheAt, NICHE_TTL)) {
    const p = refreshNiche();
    if (!snap.nicheQueries.length) waits.push(Promise.race([p, new Promise<void>((r) => setTimeout(r, 25_000))]));
  }
  await Promise.all(waits);
  const trending = [...snap.trending].sort((a, b) => Number(b.niche) - Number(a.niche));
  return {
    ...snap,
    geo: GEO(),
    niche: { name: NICHE_NAME(), seeds: SEEDS() },
    trending,
    refreshing: Boolean(trendingPromise || nichePromise),
  };
}

/** Aquece o cache na subida do servidor e mantém atualizado. */
export function startTrends(): void {
  if (config.mock && process.env.TRENDS_IN_MOCK !== '1') return;
  void refreshTrending();
  setTimeout(() => void refreshNiche(), 10_000).unref();
  setInterval(() => void getTrends(), 15 * 60 * 1000).unref();
}

// ── Hashtags sugeridas para um texto (legenda/transcrição do clipe) ──
export type HashtagSuggestion = { tag: string; reason: 'em alta' | 'nicho em alta' | 'nicho' };

export function suggestHashtags(text: string, limit = 12): HashtagSuggestion[] {
  const body = ` ${norm(text).replace(/[^a-z0-9 ]/g, ' ')} `;
  const has = (phrase: string) => {
    const words = norm(phrase).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length >= 4);
    // Assunto relacionado: todas as palavras significativas aparecem no texto.
    return words.length > 0 && words.every((w) => body.includes(` ${w} `) || body.includes(` ${w}s `));
  };
  const out: HashtagSuggestion[] = [];
  const add = (tag: string, reason: HashtagSuggestion['reason']) => {
    if (tag && tag.length > 2 && !out.some((o) => o.tag === tag)) out.push({ tag, reason });
  };
  for (const t of snap.trending) if (has(t.title)) add(t.hashtag, 'em alta');
  for (const q of snap.nicheQueries.filter((q) => q.kind === 'rising')) if (has(q.query)) add(q.hashtag, 'nicho em alta');
  for (const q of snap.nicheQueries.filter((q) => q.kind === 'top')) if (has(q.query)) add(q.hashtag, 'nicho');
  // Hashtags base do nicho: primeiro as que têm a ver com o texto, depois as demais.
  const base = NICHE_BASE_TAGS();
  const related = base.filter((t) => body.includes(` ${t.slice(1)} `) || body.includes(` ${t.slice(1)}s `));
  [...related, ...base.filter((t) => !related.includes(t))].forEach((t) => add(t, 'nicho'));
  // Assuntos em alta do nicho (mesmo sem citação direta no texto), para dar alcance.
  snap.nicheQueries.filter((q) => q.kind === 'rising').slice(0, 3).forEach((q) => add(q.hashtag, 'nicho em alta'));
  return out.slice(0, limit);
}

/** Acrescenta à legenda as hashtags em alta que têm relação direta com o clipe (até `max`). */
export function addTrendTags(post: string, clipText: string, max = 2): string {
  const present = new Set((post.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => norm(t)));
  const extra = suggestHashtags(`${clipText} ${post}`, 20)
    .filter((s) => s.reason !== 'nicho' && !present.has(norm(s.tag)))
    .slice(0, max)
    .map((s) => s.tag);
  if (!extra.length) return post;
  return /#[\p{L}\p{N}_]+\s*$/u.test(post.trim()) ? `${post.trim()} ${extra.join(' ')}` : `${post.trim()}\n\n${extra.join(' ')}`;
}

/** Linha de contexto para a IA de texto: assuntos em alta do nicho (vazia se não houver cache). */
export function trendsPromptLine(): string {
  const niche = snap.nicheQueries.filter((q) => q.kind === 'rising').slice(0, 8).map((q) => q.query);
  const general = snap.trending.filter((t) => t.niche).slice(0, 5).map((t) => t.title);
  const all = [...niche, ...general];
  return all.length ? `Buscas em alta agora no nicho do criador (use como hashtag só se o trecho tiver relação direta): ${all.join('; ')}` : '';
}
