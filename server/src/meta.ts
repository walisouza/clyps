import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { db, type ClipRow } from './db.js';

// Optional single-account integration. Credentials never leave the server.
export function metaConfig() {
  return {
    owner: process.env.META_OWNER_USER_ID || '',
    account: process.env.META_IG_USER_ID || '',
    token: process.env.META_ACCESS_TOKEN || '',
    version: process.env.META_GRAPH_VERSION || '',
    origin: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    secret: process.env.MEDIA_SIGNING_SECRET || '',
  };
}
export function metaAvailable(userId: string): boolean {
  const c = metaConfig();
  let validOrigin = false;
  try { const u = new URL(c.origin); validOrigin = u.protocol === 'https:' && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password; } catch {}
  return Boolean(c.owner === userId && c.account && c.token && /^v\d+\.\d+$/.test(c.version) && validOrigin && c.secret.length >= 32);
}
export type Publication = {
  id: string; clip_id: string; user_id: string; caption: string; scheduled_at: number;
  status: 'queued' | 'processing' | 'publishing' | 'published' | 'failed' | 'uncertain' | 'cancelled';
  container_id: string | null; media_id: string | null; error: string | null;
  started_at: number | null;
};
export function initPublications() {
  db().exec(`create table if not exists publications (
    id text primary key, clip_id text not null references clips(id) on delete cascade,
    user_id text not null references users(id) on delete cascade, caption text not null,
    scheduled_at integer not null, status text not null default 'queued',
    container_id text, media_id text, error text, started_at integer,
    created_at integer not null
  );
  create index if not exists publications_due on publications(status, scheduled_at);
  create unique index if not exists publications_active_clip on publications(clip_id)
    where status in ('queued', 'processing', 'publishing', 'uncertain');`);
  // Never repeat a publish request after a crash: its remote outcome may be unknown.
  db().prepare("update publications set status = 'uncertain', error = 'O servidor reiniciou durante o envio. Confira o Instagram antes de tentar novamente.' where status = 'publishing'").run();
}
export function listPublications(userId: string, clipId: string) {
  return db().prepare('select id, status, caption, scheduled_at, media_id, error from publications where user_id = ? and clip_id = ? order by created_at desc limit 20').all(userId, clipId);
}
export function schedulePublication(userId: string, clip: ClipRow, caption: unknown, scheduledAt: unknown): string {
  if (!metaAvailable(userId)) throw new Error('A integração Instagram não está configurada para esta conta.');
  if (typeof caption !== 'string' || caption.length > 2200) throw new Error('A legenda deve ter no máximo 2.200 caracteres.');
  const now = Date.now();
  const due = scheduledAt == null ? now : typeof scheduledAt === 'string' ? Date.parse(scheduledAt) : NaN;
  if (!Number.isFinite(due) || (scheduledAt != null && due < now + 60_000) || due > now + 90 * 86400_000) {
    throw new Error('Escolha um horário entre 1 minuto e 90 dias no futuro.');
  }
  if (!existsSync(clip.file_path)) throw new Error('Arquivo do clipe não encontrado.');
  const active = db().prepare("select id from publications where clip_id = ? and status in ('queued','processing','publishing','uncertain')").get(clip.id);
  if (active) throw new Error('Este clipe já tem um envio pendente. Confira o status antes de enviar novamente.');
  const id = randomUUID();
  db().prepare('insert into publications (id, clip_id, user_id, caption, scheduled_at, created_at) values (?, ?, ?, ?, ?, ?)')
    .run(id, clip.id, userId, caption.trim(), due, now);
  return id;
}
function signature(id: string, expires: number) {
  return createHmac('sha256', metaConfig().secret).update(`${id}:${expires}`).digest('hex');
}
export function signedMediaUrl(id: string): string {
  const expires = Date.now() + 24 * 3600_000;
  return `${metaConfig().origin}/api/meta/media/${id}?expires=${expires}&signature=${signature(id, expires)}`;
}
export function validMediaSignature(id: string, rawExpires: unknown, rawSignature: unknown): boolean {
  const expires = Number(rawExpires);
  if (typeof rawSignature !== 'string' || !/^[a-f0-9]{64}$/.test(rawSignature) || !Number.isFinite(expires)
    || expires < Date.now() || expires > Date.now() + 24 * 3600_000 || metaConfig().secret.length < 32) return false;
  return timingSafeEqual(Buffer.from(rawSignature, 'hex'), Buffer.from(signature(id, expires), 'hex'));
}
async function graph(endpoint: string, params: Record<string, string>, method = 'GET'): Promise<any> {
  const c = metaConfig();
  const url = new URL(`https://graph.instagram.com/${c.version}/${endpoint}`);
  if (method === 'GET') url.search = new URLSearchParams(params).toString();
  const res = await fetch(url, { method, signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${c.token}`, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: method === 'POST' ? new URLSearchParams(params) : undefined,
  });
  const json: any = await res.json();
  if (!res.ok || json.error) {
    // Avoid exposing response bodies that may contain request URLs or credentials.
    throw new Error(`A Meta recusou a solicitação (HTTP ${res.status}, código ${Number(json.error?.code) || 0}). Verifique token, permissões e requisitos do vídeo.`);
  }
  return json;
}
let busy = false;
export async function publicationTick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const pending = db().prepare("select * from publications where (status = 'queued' and scheduled_at <= ?) or status = 'processing' order by scheduled_at limit 1").get(Date.now()) as Publication | undefined;
    if (!pending) return;
    try {
      if (!metaAvailable(pending.user_id)) throw new Error('Integração Instagram indisponível.');
      if (pending.status === 'queued') {
        // Claim once, before network I/O. Worker remains independent of video rendering.
        const claimed = db().prepare("update publications set status = 'processing', started_at = ? where id = ? and status = 'queued'").run(Date.now(), pending.id);
        if (!claimed.changes) return;
      }
      if (!pending.container_id) {
        const result = await graph(`${metaConfig().account}/media`, {
          media_type: 'REELS', video_url: signedMediaUrl(pending.clip_id), caption: pending.caption, share_to_feed: 'true',
        }, 'POST');
        if (!result.id) throw new Error('A Meta não retornou o identificador do vídeo.');
        db().prepare('update publications set container_id = ? where id = ?').run(String(result.id), pending.id);
        return;
      }
      const state = await graph(pending.container_id, { fields: 'status_code' });
      if (state.status_code === 'ERROR' || state.status_code === 'EXPIRED') throw new Error('A Meta não conseguiu processar o vídeo. Verifique os requisitos do Reel.');
      if (state.status_code === 'PUBLISHED') {
        db().prepare("update publications set status = 'published' where id = ?").run(pending.id);
        return;
      }
      if (state.status_code !== 'FINISHED') {
        if (Date.now() - (pending.started_at ?? 0) > 20 * 60_000) throw new Error('A Meta demorou demais para processar o vídeo.');
        return;
      }
      db().prepare("update publications set status = 'publishing' where id = ?").run(pending.id);
      try {
        const result = await graph(`${metaConfig().account}/media_publish`, { creation_id: pending.container_id }, 'POST');
        if (!result.id) throw new Error('Resposta sem confirmação.');
        db().prepare("update publications set status = 'published', media_id = ?, error = null where id = ?").run(String(result.id), pending.id);
      } catch {
        db().prepare("update publications set status = 'uncertain', error = ? where id = ?")
          .run('Não foi possível confirmar o resultado do envio. Confira o Instagram para evitar uma publicação duplicada.', pending.id);
      }
    } catch (err) {
      db().prepare("update publications set status = 'failed', error = ? where id = ?").run(err instanceof Error ? err.message : 'Falha na publicação.', pending.id);
    }
  } finally { busy = false; }
}
