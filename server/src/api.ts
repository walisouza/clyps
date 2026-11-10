import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pipeline as pipe } from 'node:stream/promises';
import {
  SESSION_COOKIE, SESSION_MAX_AGE_MS, createSession, createUser, destroySession, findUserForLogin, userCount,
  userFromToken, type User,
} from './auth.js';
import { config } from './config.js';
import { MAX_COOKIES_BYTES, cookiesStatus, looksLikeNetscapeCookies, removeCookies, saveCookies } from './cookies.js';
import { db, type ClipRow, type JobRow } from './db.js';
import { clipsDir } from './pipeline.js';
import { normalizeOptions } from './types.js';

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
  api.use(express.json({ limit: '100kb' }));

  // ── Conta ──
  api.get('/me', (req, res) => {
    const user = userFromToken(readCookie(req, SESSION_COOKIE));
    res.json({ user, signupOpen: signupOpen() });
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
    res.json({ job: jobJson(job), clips: job.status === 'completed' ? clips.map(clipJson) : [] });
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
    if (!clip || !existsSync(clip.file_path)) return void res.status(404).json({ error: 'Arquivo não encontrado.' });
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (req.query.download) res.download(clip.file_path, `${slug(clip.title)}.mp4`);
    else res.sendFile(clip.file_path, { headers: { 'Content-Type': 'video/mp4' } });
  });

  api.use((_req, res) => void res.status(404).json({ error: 'Rota não encontrada.' }));
  app.use('/api', api);

  // ── App web ──
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
