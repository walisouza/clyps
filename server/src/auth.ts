import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';

const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'clyps_session';
export const SESSION_MAX_AGE_MS = SESSION_DAYS * 24 * 3600 * 1000;

export type User = { id: string; email: string; credits: number; isAdmin: boolean };

export const MIN_PASSWORD = 8;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function userCount(): number {
  return (db().prepare('select count(*) as n from users').get() as { n: number }).n;
}

export function createUser(email: string, password: string): User {
  const id = randomUUID();
  const isAdmin = userCount() === 0; // a primeira conta é a do administrador
  db()
    .prepare('insert into users (id, email, password_hash, is_admin) values (?, ?, ?, ?)')
    .run(id, email, hashPassword(password), isAdmin ? 1 : 0);
  return { id, email, credits: 0, isAdmin };
}

/** Troca a senha e encerra as outras sessões da conta (mantém a sessão atual, se informada). */
export function setPassword(userId: string, password: string, keepToken?: string): void {
  db().prepare('update users set password_hash = ? where id = ?').run(hashPassword(password), userId);
  if (keepToken) {
    db().prepare('delete from sessions where user_id = ? and token_hash != ?').run(userId, sha256(keepToken));
  } else {
    db().prepare('delete from sessions where user_id = ?').run(userId);
  }
}

export function checkPassword(userId: string, password: string): boolean {
  const row = db().prepare('select password_hash from users where id = ?').get(userId) as { password_hash: string } | undefined;
  return Boolean(row && verifyPassword(password, row.password_hash));
}

export function listUsers(): { id: string; email: string; created_at: string; is_admin: number }[] {
  return db().prepare('select id, email, created_at, is_admin from users order by created_at, rowid').all() as any;
}

export function findUserForLogin(email: string, password: string): User | null {
  const row = db().prepare('select id, email, credits, is_admin, password_hash from users where email = ?').get(email) as
    | { id: string; email: string; credits: number; is_admin: number; password_hash: string }
    | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return { id: row.id, email: row.email, credits: row.credits, isAdmin: Boolean(row.is_admin) };
}

/** Cria a sessão e devolve o token (só o hash fica no banco). */
export function createSession(userId: string): string {
  const token = randomBytes(32).toString('base64url');
  db().prepare('delete from sessions where expires_at < ?').run(Date.now());
  db().prepare('insert into sessions (token_hash, user_id, expires_at) values (?, ?, ?)').run(
    sha256(token), userId, Date.now() + SESSION_MAX_AGE_MS,
  );
  return token;
}

export function userFromToken(token: string | undefined): User | null {
  if (!token) return null;
  const row = db()
    .prepare(
      `select u.id, u.email, u.credits, u.is_admin from sessions s join users u on u.id = s.user_id
       where s.token_hash = ? and s.expires_at > ?`,
    )
    .get(sha256(token), Date.now()) as { id: string; email: string; credits: number; is_admin: number } | undefined;
  return row ? { id: row.id, email: row.email, credits: row.credits, isAdmin: Boolean(row.is_admin) } : null;
}

export function destroySession(token: string | undefined): void {
  if (token) db().prepare('delete from sessions where token_hash = ?').run(sha256(token));
}
