import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pipeline as pipe } from 'node:stream/promises';
import {
  MIN_PASSWORD, SESSION_COOKIE, SESSION_MAX_AGE_MS, checkPassword, createSession, createUser, destroySession,
  findUserForLogin, listUsers, setPassword, userCount, userFromToken, type User,
} from './auth.js';
import { config } from './config.js';
import { MAX_COOKIES_BYTES, cookiesPath, cookiesStatus, looksLikeNetscapeCookies, removeCookies, saveCookies } from './cookies.js';
import { db, requeueJob, type ClipRow, type JobRow } from './db.js';
import { ytInfo, type VideoInfo } from './media.js';
import { clipsDir } from './pipeline.js';
import { editorData, isEditable, saveEdit } from './editor.js';
import { UserError } from './errors.js';
import { normalizeOptions } from './types.js';
import { deletionPage, privacyPage, termsPage } from './legal.js';
import { getTrends, suggestHashtags } from './trends.js';
import {
  accountNames, createPosts, disconnect, finishLogin, listAccounts, loginUrl, postJson, runDuePosts, verifyPublicClip, type PostRow,
} from './meta.js';

type AuthedRequest = Request & { user: User };

const UPLOAD_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};
const UPLOAD_ID = /^[0-9a-f-]{36}\.(mp4|mov|webm)$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const uploadsDir = (userId: string) => path.join(config.dataDir, 'uploads', userId);

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = userFromToken(readCookie(req, SESSION_COOKIE));
  if (!user) {
    res.status(401).json({ error: 'Faça login para continuar.' });
    return;
  }
  (req as AuthedRequest).user = user;
  next();
}

/** Limite simples de tentativas de login/cadastro por IP. */
const attempts = new Map<string, { count: number; resetAt: number }>();
function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return next();
  }
  if (++entry.count > 20) {
    res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
    return;
  }
  next();
}

/** Aceita só links http(s) públicos (bloqueia localhost e IPs de rede interna). */
function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  if (net.isIPv6(host)) return false;
  return true;
}

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PARALLEL_PREVIEWS = 3;
const previewCache = new Map<string, { at: number; data: VideoInfo & { tooLong: boolean } }>();
let previewsRunning = 0;

const signupOpen = () => config.allowSignup || userCount() === 0;

function jobJson(j: JobRow) {
  return {
    id: j.id,
    status: j.status,
    stage: j.stage,
    progress: j.progress,
    source_type: j.source_type,
    source_url: j.source_url,
    title: j.title,
    duration_seconds: j.duration_seconds,
    options: JSON.parse(j.options || '{}'),
    error: j.error,
    notice: j.notice ?? null,
    created_at: j.created_at,
  };
}

function clipJson(c: ClipRow) {
  return {
    id: c.id,
    idx: c.idx,
    title: c.title,
    reason: c.reason,
    score: c.score,
    start_ms: c.start_ms,
    end_ms: c.end_ms,
    transcript: c.transcript,
    aspect: c.aspect,
    post_caption: c.post_caption,
    energy: c.energy,
    version: c.version ?? 0,
    rerendering: Boolean(c.rerendering),
    render_error: c.render_error ?? null,
    editable: isEditable(c),
  };
}

const slug = (t: string) =>
  t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60) || 'clipe';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));

  // ── Conta ──
  api.get('/me', (req, res) => {
    const user = userFromToken(readCookie(req, SESSION_COOKIE));
    res.json({
      user,
      signupOpen: signupOpen(),
      mock: config.mock,
      features: { auphonic: Boolean(config.auphonicApiKey), transcription: config.sttProvider, textAi: config.llmConfigured, meta: config.metaConfigured },
    });
  });

  api.post('/signup', rateLimit, (req, res) => {
    if (!signupOpen()) return void res.status(403).json({ error: 'O cadastro está fechado.' });
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!EMAIL.test(email) || email.length > 200) return void res.status(400).json({ error: 'E-mail inválido.' });
    if (password.length < 8 || password.length > 200) return void res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
    const exists = db().prepare('select 1 from users where email = ?').get(email);
    if (exists) return void res.status(409).json({ error: 'Já existe uma conta com esse e-mail.' });
    const user = createUser(email, password);
    setSessionCookie(req, res, createSession(user.id));
    res.json({ user });
  });

  api.post('/login', rateLimit, (req, res) => {
    const user = findUserForLogin(String(req.body?.email ?? '').trim().toLowerCase(), String(req.body?.password ?? ''));
    if (!user) return void res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    setSessionCookie(req, res, createSession(user.id));
    res.json({ user });
  });

  api.post('/logout', (req, res) => {
    destroySession(readCookie(req, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ── Conta ──
  api.post('/account/password', requireAuth, rateLimit, (req, res) => {
    const user = (req as AuthedRequest).user;
    const current = String(req.body?.current ?? '');
    const next = String(req.body?.next ?? '');
    if (!checkPassword(user.id, current)) return void res.status(400).json({ error: 'A senha atual está incorreta.' });
    if (next.length < MIN_PASSWORD || next.length > 200) {
      return void res.status(400).json({ error: `A nova senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.` });
    }
    setPassword(user.id, next, readCookie(req, SESSION_COOKIE));
    res.json({ ok: true });
  });

  // ── Contas (só o administrador) ──
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!(req as AuthedRequest).user?.isAdmin) return void res.status(403).json({ error: 'Só o administrador pode fazer isso.' });
    next();
  };

  api.get('/users', requireAuth, requireAdmin, (_req, res) => {
    res.json({ users: listUsers().map((u) => ({ id: u.id, email: u.email, createdAt: u.created_at, isAdmin: Boolean(u.is_admin) })) });
  });

  api.post('/users', requireAuth, requireAdmin, (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!EMAIL.test(email) || email.length > 200) return void res.status(400).json({ error: 'E-mail inválido.' });
    if (password.length < MIN_PASSWORD || password.length > 200) {
      return void res.status(400).json({ error: `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.` });
    }
    if (db().prepare('select 1 from users where email = ?').get(email)) {
      return void res.status(409).json({ error: 'Já existe uma conta com esse e-mail.' });
    }
    const u = createUser(email, password);
    res.status(201).json({ id: u.id });
  });

  api.post('/users/:id/password', requireAuth, requireAdmin, (req, res) => {
    const password = String(req.body?.password ?? '');
    if (password.length < MIN_PASSWORD || password.length > 200) {
      return void res.status(400).json({ error: `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.` });
    }
    if (!db().prepare('select 1 from users where id = ?').get(req.params.id)) return void res.status(404).json({ error: 'Conta não encontrada.' });
    setPassword(req.params.id, password);
    res.json({ ok: true });
  });

  api.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const me = (req as AuthedRequest).user;
    if (req.params.id === me.id) return void res.status(400).json({ error: 'Você não pode apagar a sua própria conta.' });
    if (!db().prepare('select 1 from users where id = ?').get(req.params.id)) return void res.status(404).json({ error: 'Conta não encontrada.' });
    // Apaga os arquivos da conta (clipes, envios, cookies); o banco apaga cortes e sessões em cascata.
    const jobs = db().prepare('select id from jobs where user_id = ?').all(req.params.id) as { id: string }[];
    for (const j of jobs) await rm(clipsDir(j.id), { recursive: true, force: true });
    await rm(uploadsDir(req.params.id), { recursive: true, force: true });
    await removeCookies(req.params.id);
    db().prepare('delete from users where id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── Prévia do link (título, miniatura, duração) antes de gerar ──
  api.get('/preview', requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    const url = String(req.query.url ?? '').trim();
    if (url.length > 2000 || !isPublicHttpUrl(url)) return void res.status(400).json({ error: 'Link inválido.' });

    const key = `${user.id}|${url}`; // por usuário: os cookies de cada um mudam o resultado
    const hit = previewCache.get(key);
    if (hit && Date.now() - hit.at < PREVIEW_TTL_MS) return void res.json(hit.data);
    if (previewsRunning >= MAX_PARALLEL_PREVIEWS) {
      return void res.status(429).json({ error: 'Muitas buscas ao mesmo tempo. Tente de novo em instantes.' });
    }

    previewsRunning++;
    try {
      const file = cookiesPath(user.id);
      const info = await ytInfo(url, existsSync(file) ? file : undefined, 45_000);
      const data = { ...info, tooLong: info.duration > config.maxDurationSeconds };
      previewCache.set(key, { at: Date.now(), data });
      if (previewCache.size > 300) previewCache.delete(previewCache.keys().next().value!);
      res.json(data);
    } catch {
      res.status(422).json({
        error: 'Não encontramos um vídeo nesse link. Confira se ele é público ou envie os cookies do navegador.',
      });
    } finally {
      previewsRunning--;
    }
  });

  // ── Cookies do yt-dlp (opcional, para links que exigem login) ──
  api.get('/cookies', requireAuth, async (req, res) => {
    res.json(await cookiesStatus((req as AuthedRequest).user.id));
  });

  api.put('/cookies', requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (Number(req.headers['content-length'] ?? 0) > MAX_COOKIES_BYTES) {
      return void res.status(413).json({ error: 'Arquivo de cookies grande demais.' });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_COOKIES_BYTES) req.destroy(new Error('too_large'));
      else chunks.push(chunk);
    });
    req.on('end', async () => {
      if (size === 0) return void res.status(400).json({ error: 'Arquivo vazio.' });
      const text = Buffer.concat(chunks).toString('utf8');
      if (!looksLikeNetscapeCookies(text)) {
        return void res.status(400).json({
          error: 'Formato inválido. Exporte um cookies.txt no formato Netscape (extensão "Get cookies.txt LOCALLY" ou equivalente).',
        });
      }
      await saveCookies(user.id, text);
      res.json(await cookiesStatus(user.id));
    });
    req.on('error', () => {
      if (!res.headersSent) res.status(400).json({ error: 'Falha no envio.' });
    });
  });

  api.delete('/cookies', requireAuth, async (req, res) => {
    await removeCookies((req as AuthedRequest).user.id);
    res.json({ ok: true });
  });

  // ── Upload (corpo da requisição é o próprio arquivo) ──
  api.put('/uploads', requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    const ext = UPLOAD_TYPES[String(req.headers['content-type'] ?? '').split(';')[0].trim()];
    if (!ext) return void res.status(415).json({ error: 'Formato não aceito. Use MP4, MOV ou WebM.' });
    if (Number(req.headers['content-length'] ?? 0) > config.maxUploadBytes) {
      return void res.status(413).json({ error: 'O arquivo passa do tamanho máximo.' });
    }
    const uploadId = `${randomUUID()}.${ext}`;
    const dir = uploadsDir(user.id);
    const file = path.join(dir, uploadId);
    await mkdir(dir, { recursive: true });

    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > config.maxUploadBytes) req.destroy(new Error('too_large'));
    });
    try {
      await pipe(req, createWriteStream(file));
      if (size === 0) throw new Error('empty');
      res.json({ uploadId });
    } catch {
      await rm(file, { force: true });
      if (!res.headersSent) res.status(400).json({ error: 'O envio falhou ou foi interrompido.' });
    }
  });

  // ── Jobs ──
  api.post('/jobs', requireAuth, (req, res) => {
    const user = (req as AuthedRequest).user;
    const body = req.body ?? {};
    const options = JSON.stringify(normalizeOptions(body.options));
    const id = randomUUID();

    if (body.sourceType === 'url') {
      const url = String(body.url ?? '').trim();
      if (url.length > 2000 || !isPublicHttpUrl(url)) return void res.status(400).json({ error: 'Cole um link público válido (http ou https).' });
      db().prepare(`insert into jobs (id, user_id, source_type, source_url, options) values (?, ?, 'url', ?, ?)`).run(id, user.id, url, options);
    } else if (body.sourceType === 'upload') {
      const uploadId = String(body.uploadId ?? '');
      const file = path.join(uploadsDir(user.id), uploadId);
      if (!UPLOAD_ID.test(uploadId) || !existsSync(file)) return void res.status(400).json({ error: 'Envio não encontrado. Envie o arquivo de novo.' });
      const title = String(body.title ?? '').slice(0, 200) || 'Vídeo enviado';
      db().prepare(`insert into jobs (id, user_id, source_type, upload_path, title, options) values (?, ?, 'upload', ?, ?, ?)`).run(id, user.id, file, title, options);
    } else {
      return void res.status(400).json({ error: 'Fonte do vídeo inválida.' });
    }
    res.status(201).json({ id });
  });

  api.get('/jobs', requireAuth, (req, res) => {
    const user = (req as AuthedRequest).user;
    const rows = db().prepare('select * from jobs where user_id = ? order by created_at desc limit 100').all(user.id) as JobRow[];
    res.json({ jobs: rows.map(jobJson) });
  });

  api.get('/jobs/:id', requireAuth, (req, res) => {
    const user = (req as AuthedRequest).user;
    const job = db().prepare('select * from jobs where id = ? and user_id = ?').get(req.params.id, user.id) as JobRow | undefined;
    if (!job) return void res.status(404).json({ error: 'Corte não encontrado.' });
    const clips = db().prepare('select * from clips where job_id = ? order by idx').all(job.id) as ClipRow[];
    const posts = db()
      .prepare('select p.* from posts p join clips c on c.id = p.clip_id where c.job_id = ? order by p.scheduled_at')
      .all(job.id) as PostRow[];
    const names = accountNames(user.id);
    res.json({ job: jobJson(job), clips: job.status === 'completed' ? clips.map(clipJson) : [], posts: posts.map((p) => postJson(p, names)) });
  });

  api.post('/jobs/:id/retry', requireAuth, (req, res) => {
    const user = (req as AuthedRequest).user;
    const job = db().prepare('select * from jobs where id = ? and user_id = ?').get(req.params.id, user.id) as JobRow | undefined;
    if (!job) return void res.status(404).json({ error: 'Corte não encontrado.' });
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      return void res.status(409).json({ error: 'Só dá para tentar de novo um corte que falhou.' });
    }
    if (job.source_type === 'upload' && (!job.upload_path || !existsSync(job.upload_path))) {
      return void res.status(409).json({
        error: 'O arquivo original deste corte não está mais no servidor. Crie um corte novo enviando o vídeo de novo.',
      });
    }
    requeueJob(job.id, user.id);
    res.json({ ok: true });
  });

  api.delete('/jobs/:id', requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    const job = db().prepare('select * from jobs where id = ? and user_id = ?').get(req.params.id, user.id) as JobRow | undefined;
    if (!job) return void res.status(404).json({ error: 'Corte não encontrado.' });
    if (job.status === 'processing') return void res.status(409).json({ error: 'Aguarde o processamento terminar para apagar.' });
    db().prepare('delete from jobs where id = ?').run(job.id);
    await rm(clipsDir(job.id), { recursive: true, force: true });
    if (job.upload_path) await rm(job.upload_path, { force: true });
    res.json({ ok: true });
  });

  // ── Arquivo do clipe (com suporte a Range para o player) ──
  api.get('/clips/:id/file', requireAuth, (req, res) => {
    const user = (req as AuthedRequest).user;
    const clip = db().prepare('select * from clips where id = ? and user_id = ?').get(req.params.id, user.id) as ClipRow | undefined;
    // variant=clean: versão sem legenda e com folga, usada no editor.
    const file = req.query.variant === 'clean' ? clip?.clean_path : clip?.file_path;
    if (!clip || !file || !existsSync(file)) return void res.status(404).json({ error: 'Arquivo não encontrado.' });
    // A URL muda a cada edição (?v=versão), então o navegador pode guardar em cache.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (req.query.download) res.download(file, `${slug(clip.title)}.mp4`);
    else res.sendFile(file, { headers: { 'Content-Type': 'video/mp4' } });
  });

  // ── Link público e temporário do clipe, usado pela Meta para baixar o vídeo. ──
  api.get('/public/clips/:id/:exp/:sig.mp4', (req, res) => {
    const { id, exp, sig } = req.params;
    const clip = verifyPublicClip(id, exp, sig)
      ? (db().prepare('select file_path from clips where id = ?').get(id) as { file_path: string } | undefined)
      : undefined;
    if (!clip || !existsSync(clip.file_path)) return void res.status(404).json({ error: 'Link inválido ou expirado.' });
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(clip.file_path, { headers: { 'Content-Type': 'video/mp4' } });
  });

  // ── Trend Scanner ──
  api.get('/trends', requireAuth, async (req, res) => {
    res.json(await getTrends(req.query.refresh === '1'));
  });

  api.get('/trends/hashtags', requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    let text = String(req.query.text ?? '').slice(0, 5000);
    if (req.query.clipId) {
      const clip = db().prepare('select title, transcript, post_caption from clips where id = ? and user_id = ?').get(String(req.query.clipId), user.id) as
        | { title: string; transcript: string | null; post_caption: string | null }
        | undefined;
      if (clip) text = `${clip.title} ${clip.transcript ?? ''} ${clip.post_caption ?? ''} ${text}`;
    }
    await getTrends();
    res.json({ hashtags: suggestHashtags(text) });
  });

  // ── Meta (Facebook e Instagram) ──
  const originOf = (req: Request) => `${req.protocol}://${req.get('host')}`;

  api.get('/meta/status', requireAuth, (req, res) => {
    const user = (req as AuthedRequest).user;
    res.json({
      configured: config.metaConfigured,
      callbackUrl: `${config.publicUrl || originOf(req)}/api/meta/callback`,
      accounts: listAccounts(user.id),
    });
  });

  api.get('/meta/connect', requireAuth, (req, res) => {
    const user = (req as AuthedRequest).user;
    try {
      res.redirect(loginUrl(user.id, originOf(req)));
    } catch (err) {
      res.redirect(`/conta?meta=erro&msg=${encodeURIComponent((err as Error).message)}`);
    }
  });

  api.get('/meta/callback', async (req, res) => {
    const user = userFromToken(readCookie(req, SESSION_COOKIE));
    const back = (q: string) => res.redirect(`/conta?${q}`);
    if (!user) return back(`meta=erro&msg=${encodeURIComponent('Entre no Clyps antes de conectar com o Facebook.')}`);
    if (req.query.error) {
      const why = String(req.query.error_description || req.query.error_reason || 'conexão cancelada');
      return back(`meta=erro&msg=${encodeURIComponent(`O Facebook não concluiu a conexão (${why}).`)}`);
    }
    try {
      const n = await finishLogin(user.id, String(req.query.state ?? ''), String(req.query.code ?? ''), originOf(req));
      back(`meta=ok&n=${n}`);
    } catch (err) {
      const msg = err instanceof UserError ? err.message : 'Falha ao conectar com o Facebook.';
      console.error('[meta] callback:', err);
      back(`meta=erro&msg=${encodeURIComponent(msg)}`);
    }
  });

  api.delete('/meta', requireAuth, (req, res) => {
    disconnect((req as AuthedRequest).user.id);
    res.json({ ok: true });
  });

  api.get('/clips/:id/posts', requireAuth, (req, res) => {
    const user = (req as AuthedRequest).user;
    const posts = db().prepare('select * from posts where clip_id = ? and user_id = ? order by scheduled_at').all(req.params.id, user.id) as PostRow[];
    const name = accountNames(user.id);
    res.json({ posts: posts.map((p) => postJson(p, name)) });
  });

  api.post('/clips/:id/posts', requireAuth, (req, res) => {
    const user = (req as AuthedRequest).user;
    const clip = db().prepare('select * from clips where id = ? and user_id = ?').get(req.params.id, user.id) as ClipRow | undefined;
    if (!clip) return void res.status(404).json({ error: 'Clipe não encontrado.' });
    try {
      const rows = createPosts(user.id, clip, req.body ?? {}, originOf(req));
      const name = accountNames(user.id);
      res.json({ posts: rows.map((p) => postJson(p, name)) });
    } catch (err) {
      if (err instanceof UserError) return void res.status(400).json({ error: err.message });
      throw err;
    }
  });

  api.delete('/posts/:id', requireAuth, (req, res) => {
    const user = (req as AuthedRequest).user;
    const r = db()
      .prepare("update posts set status = 'cancelled' where id = ? and user_id = ? and status in ('scheduled', 'failed')")
      .run(req.params.id, user.id);
    if (!r.changes) return void res.status(409).json({ error: 'Esta publicação não pode mais ser cancelada.' });
    res.json({ ok: true });
  });

  api.post('/posts/:id/retry', requireAuth, (req, res) => {
    const user = (req as AuthedRequest).user;
    const r = db()
      .prepare("update posts set status = 'scheduled', error = null, scheduled_at = ? where id = ? and user_id = ? and status = 'failed'")
      .run(new Date().toISOString(), req.params.id, user.id);
    if (!r.changes) return void res.status(409).json({ error: 'Só dá para tentar de novo uma publicação que falhou.' });
    void runDuePosts();
    res.json({ ok: true });
  });

  // ── Editor de clipe ──
  api.get('/clips/:id/editor', requireAuth, (req, res) => {
    const user = (req as AuthedRequest).user;
    const clip = db().prepare('select * from clips where id = ? and user_id = ?').get(req.params.id, user.id) as ClipRow | undefined;
    if (!clip) return void res.status(404).json({ error: 'Clipe não encontrado.' });
    if (!isEditable(clip)) {
      return void res.status(409).json({
        error: 'Este clipe foi gerado antes do editor existir. Crie o corte de novo para poder editar.',
      });
    }
    res.json(editorData(clip));
  });

  api.put('/clips/:id/editor', requireAuth, (req, res) => {
    const user = (req as AuthedRequest).user;
    const clip = db().prepare('select * from clips where id = ? and user_id = ?').get(req.params.id, user.id) as ClipRow | undefined;
    if (!clip) return void res.status(404).json({ error: 'Clipe não encontrado.' });
    const b = req.body ?? {};
    try {
      saveEdit(clip, {
        version: Number(b.version),
        startMs: Number(b.startMs),
        endMs: Number(b.endMs),
        title: b.title,
        postCaption: b.postCaption,
        captions: b.captions,
        texts: Array.isArray(b.texts) ? b.texts.slice(0, 5000) : undefined,
        framing: b.framing,
      });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof UserError) return void res.status(400).json({ error: err.message });
      throw err;
    }
  });

  api.use((_req, res) => void res.status(404).json({ error: 'Rota não encontrada.' }));
  app.use('/api', api);

  // ── App web ──
  // A Meta só baixa vídeos de sites cujo robots.txt libera o robô dela.
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nAllow: /api/public/\nDisallow: /api/\n'));

  // Páginas públicas (sem login): exigidas pela Meta para o app.
  const legal = (html: () => string) => (_req: Request, res: Response) => res.type('html').send(html());
  app.get(['/privacidade', '/privacy'], legal(privacyPage));
  app.get(['/termos', '/terms'], legal(termsPage));
  app.get(['/exclusao-de-dados', '/data-deletion'], legal(deletionPage));

  if (existsSync(path.join(config.webDir, 'index.html'))) {
    app.use(express.static(config.webDir, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(config.webDir, 'index.html')));
  } else {
    app.get('*', (_req, res) => void res.status(503).send('Build do app web não encontrado (rode "npm run build" em web/).'));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number })?.status;
    if (status && status < 500) return void res.status(status).json({ error: 'Requisição inválida.' });
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Erro interno.' });
  });

  return app;
}
