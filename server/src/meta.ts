import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db, type ClipRow } from './db.js';
import { UserError } from './errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Publicação no Facebook (Reels da Página) e no Instagram (Reels) pela Graph API.
// A conexão é feita pelo Login do Facebook; os tokens das Páginas não expiram e
// ficam criptografados no banco. A Meta baixa o vídeo de um link público assinado.
// ─────────────────────────────────────────────────────────────────────────────

export type Network = 'instagram' | 'facebook';
export type PostStatus = 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';

export type MetaAccountRow = {
  user_id: string;
  page_id: string;
  page_name: string;
  page_token: string;
  page_picture: string | null;
  ig_user_id: string | null;
  ig_username: string | null;
  ig_picture: string | null;
  updated_at: string;
};

export type PostRow = {
  id: string;
  user_id: string;
  clip_id: string;
  network: Network;
  page_id: string;
  caption: string;
  scheduled_at: string;
  status: PostStatus;
  remote_id: string | null;
  permalink: string | null;
  error: string | null;
  origin: string | null;
  created_at: string;
  published_at: string | null;
};

// ── Segredo do servidor: assina os links públicos e criptografa os tokens. ──
let serverKey: Buffer | null = null;
function key(): Buffer {
  if (serverKey) return serverKey;
  const file = path.join(config.dataDir, 'server.key');
  if (!existsSync(file)) {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  serverKey = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  return serverKey;
}

function seal(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

function unseal(value: string): string {
  const [v, iv, tag, enc] = value.split('.');
  if (v !== 'v1' || !iv || !tag || !enc) throw new UserError('Token da Meta ilegível. Conecte a conta de novo na página Conta.');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

// ── Link público e temporário do arquivo do clipe (a Meta baixa o vídeo por ele). ──
const LINK_TTL_S = 24 * 3600;
const sign = (clipId: string, exp: number) => createHmac('sha256', key()).update(`clip:${clipId}:${exp}`).digest('base64url');

export function publicClipPath(clipId: string): string {
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_S;
  return `/api/public/clips/${clipId}/${exp}/${sign(clipId, exp)}.mp4`;
}

export function verifyPublicClip(clipId: string, exp: string, sig: string): boolean {
  const e = Number(exp);
  if (!Number.isInteger(e) || e < Date.now() / 1000) return false;
  const a = Buffer.from(sign(clipId, e));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Cliente da Graph API ──
type GraphError = { message?: string; code?: number; error_subcode?: number; error_user_msg?: string; error_user_title?: string };

export class MetaError extends UserError {}

function metaMessage(status: number, err: GraphError | undefined, raw: string): string {
  if (err?.code === 190) return 'A conexão com a Meta expirou ou foi revogada. Conecte de novo na página Conta.';
  if (err?.code === 10 || err?.code === 200 || (err?.code ?? 0) >= 200 && (err?.code ?? 0) < 300) {
    return `A Meta negou a permissão: ${err?.error_user_msg || err?.message}. Conecte de novo e aceite todas as permissões.`;
  }
  if (err?.code === 4 || err?.code === 17 || err?.code === 32 || err?.code === 613) {
    return 'A Meta limitou as publicações por agora (limite de uso). Tente de novo mais tarde.';
  }
  const text = err?.error_user_msg || err?.message || raw.slice(0, 200) || `HTTP ${status}`;
  return `A Meta recusou: ${text}`;
}

async function graph<T>(
  method: 'GET' | 'POST' | 'DELETE',
  pathOrUrl: string,
  params: Record<string, string | number | boolean | undefined> = {},
  init?: { headers?: Record<string, string>; base?: string },
): Promise<T> {
  const base = init?.base ?? `${config.metaGraphUrl}/${config.metaGraphVersion}`;
  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : `${base}/${pathOrUrl.replace(/^\//, '')}`);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (method === 'GET') url.searchParams.set(k, String(v));
    else body.set(k, String(v));
  }
  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method,
      headers: init?.headers,
      body: method === 'GET' ? undefined : body,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new MetaError(`Não foi possível falar com a Meta (${(err as Error).message}). Tente de novo.`);
  }
  const raw = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = undefined;
  }
  const err = (data as { error?: GraphError } | undefined)?.error;
  if (!res.ok || err) throw new MetaError(metaMessage(res.status, err, raw));
  return data as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Login do Facebook ──
const pendingStates = new Map<string, { userId: string; expires: number }>();

export const callbackUrl = (origin: string) => `${config.publicUrl || origin}/api/meta/callback`;

export function loginUrl(userId: string, origin: string): string {
  if (!config.metaConfigured) throw new UserError('A integração com a Meta não está configurada no servidor (META_APP_ID e META_APP_SECRET).');
  const state = randomUUID();
  const now = Date.now();
  for (const [k, v] of pendingStates) if (v.expires < now) pendingStates.delete(k);
  pendingStates.set(state, { userId, expires: now + 15 * 60 * 1000 });
  const u = new URL(`${config.metaDialogUrl}/${config.metaGraphVersion}/dialog/oauth`);
  u.searchParams.set('client_id', config.metaAppId);
  u.searchParams.set('redirect_uri', callbackUrl(origin));
  u.searchParams.set('state', state);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', config.metaScopes);
  return u.toString();
}

type PageData = {
  id: string;
  name: string;
  access_token?: string;
  picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string; profile_picture_url?: string };
};

/** Recebe o código do Login do Facebook, troca por tokens e guarda as Páginas (e os Instagrams ligados a elas). */
export async function finishLogin(userId: string, state: string, code: string, origin: string): Promise<number> {
  const pending = pendingStates.get(state);
  pendingStates.delete(state);
  if (!pending || pending.userId !== userId || pending.expires < Date.now()) {
    throw new UserError('O login com o Facebook expirou ou foi aberto em outra conta do Clyps. Tente conectar de novo.');
  }
  const short = await graph<{ access_token: string }>('GET', 'oauth/access_token', {
    client_id: config.metaAppId,
    client_secret: config.metaAppSecret,
    redirect_uri: callbackUrl(origin),
    code,
  });
  // Token de usuário de longa duração: as Páginas buscadas com ele recebem tokens que não expiram.
  const long = await graph<{ access_token: string }>('GET', 'oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: config.metaAppId,
    client_secret: config.metaAppSecret,
    fb_exchange_token: short.access_token,
  });

  const pages: PageData[] = [];
  let next: string | undefined = 'me/accounts';
  let params: Record<string, string> = {
    access_token: long.access_token,
    limit: '100',
    fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}',
  };
  for (let i = 0; next && i < 10; i++) {
    const r: { data?: PageData[]; paging?: { next?: string } } = await graph('GET', next, params);
    pages.push(...(r.data ?? []));
    next = r.paging?.next;
    params = {};
  }
  const usable = pages.filter((p) => p.access_token);
  if (!usable.length) {
    throw new UserError(
      'O Facebook não liberou nenhuma Página. Conecte de novo e, na janela do Facebook, marque as Páginas (e os perfis do Instagram) que o Clyps pode usar.',
    );
  }

  const conn = db();
  const upsert = conn.prepare(
    `insert into meta_accounts (user_id, page_id, page_name, page_token, page_picture, ig_user_id, ig_username, ig_picture, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     on conflict (user_id, page_id) do update set page_name = excluded.page_name, page_token = excluded.page_token,
       page_picture = excluded.page_picture, ig_user_id = excluded.ig_user_id, ig_username = excluded.ig_username,
       ig_picture = excluded.ig_picture, updated_at = excluded.updated_at`,
  );
  conn.transaction(() => {
    // Páginas que não vieram nesta conexão saem da lista (acesso removido no Facebook).
    const ids = usable.map((p) => p.id);
    conn
      .prepare(`delete from meta_accounts where user_id = ? and page_id not in (${ids.map(() => '?').join(',')})`)
      .run(userId, ...ids);
    for (const p of usable) {
      const ig = p.instagram_business_account;
      upsert.run(userId, p.id, p.name, seal(p.access_token!), p.picture?.data?.url ?? null, ig?.id ?? null, ig?.username ?? null, ig?.profile_picture_url ?? null);
    }
  })();
  return usable.length;
}

export function listAccounts(userId: string) {
  const rows = db().prepare('select * from meta_accounts where user_id = ? order by page_name').all(userId) as MetaAccountRow[];
  return rows.map((r) => ({
    pageId: r.page_id,
    pageName: r.page_name,
    pagePicture: r.page_picture,
    instagram: r.ig_user_id ? { id: r.ig_user_id, username: r.ig_username, picture: r.ig_picture } : null,
    updatedAt: r.updated_at,
  }));
}

export function disconnect(userId: string): void {
  const conn = db();
  conn.transaction(() => {
    conn.prepare("update posts set status = 'cancelled', error = 'Conta da Meta desconectada.' where user_id = ? and status = 'scheduled'").run(userId);
    conn.prepare('delete from meta_accounts where user_id = ?').run(userId);
  })();
}

// ── Publicações ──
export const MAX_CAPTION = 2200;

/** Nome da conta de cada publicação (@usuario no Instagram, nome da Página no Facebook). */
export function accountNames(userId: string): (p: PostRow) => string | null {
  const rows = db().prepare('select page_id, page_name, ig_username from meta_accounts where user_id = ?').all(userId) as MetaAccountRow[];
  const by = new Map(rows.map((r) => [r.page_id, r]));
  return (p) => {
    const a = by.get(p.page_id);
    if (!a) return null;
    return p.network === 'instagram' ? (a.ig_username ? `@${a.ig_username}` : a.page_name) : a.page_name;
  };
}

export function postJson(p: PostRow, name?: (p: PostRow) => string | null) {
  return {
    account: name?.(p) ?? null,
    id: p.id,
    clipId: p.clip_id,
    network: p.network,
    pageId: p.page_id,
    caption: p.caption,
    scheduledAt: p.scheduled_at,
    status: p.status,
    permalink: p.permalink,
    error: p.error,
    createdAt: p.created_at,
    publishedAt: p.published_at,
  };
}

export function createPosts(
  userId: string,
  clip: ClipRow,
  input: { targets: unknown; caption: unknown; scheduledAt: unknown },
  origin: string,
): PostRow[] {
  if (!config.metaConfigured) throw new UserError('A integração com a Meta não está configurada no servidor.');
  const targets = Array.isArray(input.targets) ? input.targets : [];
  if (!targets.length) throw new UserError('Escolha onde publicar.');
  const caption = typeof input.caption === 'string' ? input.caption.slice(0, MAX_CAPTION) : '';

  let when = new Date();
  if (input.scheduledAt) {
    when = new Date(String(input.scheduledAt));
    if (Number.isNaN(when.getTime())) throw new UserError('Data de agendamento inválida.');
    if (when.getTime() < Date.now() - 60_000) throw new UserError('A data do agendamento já passou.');
    if (when.getTime() > Date.now() + 75 * 24 * 3600 * 1000) throw new UserError('Agende para no máximo 75 dias à frente.');
  }

  const accounts = db().prepare('select * from meta_accounts where user_id = ?').all(userId) as MetaAccountRow[];
  const rows: PostRow[] = [];
  const seen = new Set<string>();
  for (const t of targets as { network?: unknown; pageId?: unknown }[]) {
    const network = t?.network === 'instagram' || t?.network === 'facebook' ? t.network : null;
    const acc = accounts.find((a) => a.page_id === String(t?.pageId));
    if (!network || !acc) throw new UserError('Uma das contas escolhidas não está mais conectada. Recarregue a página.');
    if (network === 'instagram' && !acc.ig_user_id) throw new UserError(`A Página ${acc.page_name} não tem Instagram profissional ligado.`);
    const k = `${network}:${acc.page_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({
      id: randomUUID(),
      user_id: userId,
      clip_id: clip.id,
      network,
      page_id: acc.page_id,
      caption,
      scheduled_at: when.toISOString(),
      status: 'scheduled',
      remote_id: null,
      permalink: null,
      error: null,
      origin: config.publicUrl || origin,
      created_at: new Date().toISOString(),
      published_at: null,
    });
  }
  const insert = db().prepare(
    `insert into posts (id, user_id, clip_id, network, page_id, caption, scheduled_at, status, origin, created_at)
     values (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
  );
  db().transaction(() => rows.forEach((r) => insert.run(r.id, r.user_id, r.clip_id, r.network, r.page_id, r.caption, r.scheduled_at, r.origin, r.created_at)))();
  void runDuePosts();
  return rows;
}

const setPost = (id: string, fields: Partial<PostRow>) => {
  const keys = Object.keys(fields) as (keyof PostRow)[];
  db()
    .prepare(`update posts set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`)
    .run(...keys.map((k) => fields[k] as string | null), id);
};

async function publishInstagram(acc: MetaAccountRow, token: string, videoUrl: string, caption: string): Promise<{ id: string; permalink: string | null }> {
  const container = await graph<{ id: string }>('POST', `${acc.ig_user_id}/media`, {
    media_type: 'REELS',
    video_url: videoUrl,
    caption,
    share_to_feed: true,
    access_token: token,
  });
  // O Instagram baixa e processa o vídeo; só dá para publicar quando o contêiner fica FINISHED.
  const deadline = Date.now() + 20 * 60 * 1000;
  for (;;) {
    await sleep(5000);
    const s = await graph<{ status_code?: string; status?: string }>('GET', container.id, { fields: 'status_code,status', access_token: token });
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
      throw new MetaError(`O Instagram não aceitou o vídeo${s.status ? ` (${s.status})` : ''}.`);
    }
    if (Date.now() > deadline) throw new MetaError('O Instagram demorou demais para processar o vídeo. Tente de novo.');
  }
  const media = await graph<{ id: string }>('POST', `${acc.ig_user_id}/media_publish`, { creation_id: container.id, access_token: token });
  const info = await graph<{ permalink?: string }>('GET', media.id, { fields: 'permalink', access_token: token }).catch(() => ({}) as { permalink?: string });
  return { id: media.id, permalink: info.permalink ?? null };
}

async function publishFacebook(
  acc: MetaAccountRow,
  token: string,
  videoUrl: string,
  caption: string,
  clip: ClipRow,
): Promise<{ id: string; permalink: string | null }> {
  const seconds = (clip.end_ms - clip.start_ms) / 1000;
  const asReel = clip.aspect === '9:16' && seconds >= 3 && seconds <= 90;

  if (!asReel) {
    // Fora do formato de Reel (9:16, 3–90 s): vai como vídeo normal da Página.
    const v = await graph<{ id: string }>('POST', `${acc.page_id}/videos`, {
      file_url: videoUrl,
      description: caption,
      title: clip.title,
      access_token: token,
    });
    const info = await graph<{ permalink_url?: string }>('GET', v.id, { fields: 'permalink_url', access_token: token }).catch(() => ({}) as { permalink_url?: string });
    return { id: v.id, permalink: info.permalink_url ? new URL(info.permalink_url, 'https://www.facebook.com').toString() : null };
  }

  const start = await graph<{ video_id: string }>('POST', `${acc.page_id}/video_reels`, { upload_phase: 'start', access_token: token });
  await graph(
    'POST',
    `${config.metaRuploadUrl}/video-upload/${config.metaGraphVersion}/${start.video_id}`,
    {},
    { headers: { Authorization: `OAuth ${token}`, file_url: videoUrl } },
  );
  // Espera o Facebook terminar de baixar o arquivo antes de publicar.
  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    const s = await graph<{ status?: { video_status?: string; uploading_phase?: { status?: string; error?: { message?: string } } } }>(
      'GET',
      start.video_id,
      { fields: 'status', access_token: token },
    );
    const up = s.status?.uploading_phase;
    if (up?.status === 'complete' || ['ready', 'processing', 'upload_complete'].includes(s.status?.video_status ?? '')) break;
    if (up?.status === 'error' || ['error', 'upload_failed', 'expired'].includes(s.status?.video_status ?? '')) {
      throw new MetaError(`O Facebook não conseguiu baixar o vídeo${up?.error?.message ? `: ${up.error.message}` : ''}.`);
    }
    if (Date.now() > deadline) throw new MetaError('O Facebook demorou demais para receber o vídeo. Tente de novo.');
    await sleep(5000);
  }
  await graph('POST', `${acc.page_id}/video_reels`, {
    upload_phase: 'finish',
    video_id: start.video_id,
    video_state: 'PUBLISHED',
    description: caption,
    title: clip.title,
    access_token: token,
  });
  return { id: start.video_id, permalink: `https://www.facebook.com/reel/${start.video_id}` };
}

async function publishPost(post: PostRow): Promise<void> {
  const clip = db().prepare('select * from clips where id = ?').get(post.clip_id) as ClipRow | undefined;
  const acc = db().prepare('select * from meta_accounts where user_id = ? and page_id = ?').get(post.user_id, post.page_id) as MetaAccountRow | undefined;
  if (!clip || !existsSync(clip.file_path)) throw new UserError('O arquivo do clipe não está mais no servidor.');
  if (!acc) throw new UserError('Esta conta foi desconectada do Clyps.');
  const token = unseal(acc.page_token);
  const origin = config.publicUrl || post.origin;
  if (!origin) throw new UserError('O servidor não sabe o próprio endereço público (PUBLIC_URL no .env).');
  const videoUrl = `${origin}${publicClipPath(clip.id)}`;
  const r =
    post.network === 'instagram'
      ? await publishInstagram(acc, token, videoUrl, post.caption)
      : await publishFacebook(acc, token, videoUrl, post.caption, clip);
  setPost(post.id, { status: 'published', remote_id: r.id, permalink: r.permalink, error: null, published_at: new Date().toISOString() });
}

// ── Agendador: publica o que já passou do horário, um por vez. ──
let running = false;

export async function runDuePosts(): Promise<void> {
  if (running || !config.metaConfigured) return;
  running = true;
  try {
    for (;;) {
      const post = db()
        .prepare(
          `select p.* from posts p join clips c on c.id = p.clip_id
           where p.status = 'scheduled' and p.scheduled_at <= ? and c.rerendering = 0
           order by p.scheduled_at limit 1`,
        )
        .get(new Date().toISOString()) as PostRow | undefined;
      if (!post) break;
      setPost(post.id, { status: 'publishing', error: null });
      try {
        await publishPost(post);
        console.log(`[post ${post.id}] publicado no ${post.network}`);
      } catch (err) {
        console.error(`[post ${post.id}] falhou:`, err);
        const msg = err instanceof UserError ? err.message : `Falha ao publicar: ${String((err as Error)?.message ?? err).split('\n')[0].slice(0, 200)}`;
        setPost(post.id, { status: 'failed', error: msg });
      }
    }
  } finally {
    running = false;
  }
}

/** Publicações que estavam em andamento quando o servidor caiu: não dá para saber se saíram. */
export function recoverInterruptedPosts(): void {
  db()
    .prepare(
      "update posts set status = 'failed', error = 'O servidor reiniciou durante a publicação. Confira no Instagram/Facebook se saiu; se não, tente de novo.' where status = 'publishing'",
    )
    .run();
}

export function startScheduler(): void {
  recoverInterruptedPosts();
  setInterval(() => void runDuePosts(), 20_000).unref();
  void runDuePosts();
}
