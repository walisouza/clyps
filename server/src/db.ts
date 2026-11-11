import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `
create table if not exists users (
  id text primary key,
  email text not null unique collate nocase,
  password_hash text not null,
  credits integer not null default 0,
  created_at text not null default (datetime('now'))
);

create table if not exists sessions (
  token_hash text primary key,
  user_id text not null references users (id) on delete cascade,
  expires_at integer not null
);

create table if not exists jobs (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  status text not null default 'queued',
  stage text,
  progress integer not null default 0,
  source_type text not null,
  source_url text,
  upload_path text,
  title text,
  duration_seconds real,
  options text not null default '{}',
  error text,
  credit_cost integer not null default 0,
  attempts integer not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at text
);
create index if not exists jobs_user_idx on jobs (user_id, created_at desc);
create index if not exists jobs_queue_idx on jobs (status, created_at);

create table if not exists clips (
  id text primary key,
  job_id text not null references jobs (id) on delete cascade,
  user_id text not null references users (id) on delete cascade,
  idx integer not null,
  title text not null,
  reason text,
  score integer,
  start_ms integer not null,
  end_ms integer not null,
  transcript text,
  file_path text not null,
  aspect text not null,
  unique (job_id, idx)
);

create table if not exists credit_ledger (
  id integer primary key autoincrement,
  user_id text not null references users (id) on delete cascade,
  job_id text,
  delta integer not null,
  reason text not null,
  created_at text not null default (datetime('now'))
);
`;

export type JobRow = {
  id: string;
  user_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  stage: string | null;
  progress: number;
  source_type: 'url' | 'upload';
  source_url: string | null;
  upload_path: string | null;
  title: string | null;
  duration_seconds: number | null;
  options: string;
  error: string | null;
  credit_cost: number;
  attempts: number;
  created_at: string;
  completed_at: string | null;
  /** Aviso não fatal sobre o processamento (ex.: Auphonic falhou e usamos o filtro local). */
  notice: string | null;
};

export type ClipRow = {
  id: string;
  job_id: string;
  user_id: string;
  idx: number;
  title: string;
  reason: string | null;
  score: number | null;
  start_ms: number;
  end_ms: number;
  transcript: string | null;
  file_path: string;
  aspect: string;
  post_caption: string | null;
  energy: number | null;
};

let conn: Database.Database | null = null;

/** Migração simples: adiciona a coluna se o banco foi criado por uma versão anterior. */
function ensureColumn(d: Database.Database, table: string, column: string, type: string): void {
  const cols = d.prepare(`pragma table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) d.exec(`alter table ${table} add column ${column} ${type}`);
}

export function db(): Database.Database {
  if (!conn) {
    mkdirSync(config.dataDir, { recursive: true });
    conn = new Database(path.join(config.dataDir, 'clyps.db'));
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    conn.exec(SCHEMA);
    ensureColumn(conn, 'clips', 'post_caption', 'text');
    ensureColumn(conn, 'clips', 'energy', 'integer');
    ensureColumn(conn, 'jobs', 'notice', 'text');
  }
  return conn;
}

const JOB_COLUMNS = new Set([
  'status', 'stage', 'progress', 'title', 'duration_seconds', 'error', 'credit_cost', 'completed_at', 'upload_path', 'notice',
]);

export function updateJob(id: string, patch: Partial<JobRow>): void {
  const keys = Object.keys(patch).filter((k) => JOB_COLUMNS.has(k));
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db().prepare(`update jobs set ${sets} where id = @id`).run({ ...patch, id });
}

/** Jobs que estavam em andamento quando o servidor caiu voltam para a fila (até 3 tentativas). */
/** Recoloca um corte que falhou na fila, do zero. Devolve false se ele não estiver em estado de nova tentativa. */
export function requeueJob(id: string, userId: string): boolean {
  const r = db()
    .prepare(
      `update jobs set status = 'queued', stage = null, progress = 0, error = null, notice = null,
         attempts = 0, completed_at = null
       where id = ? and user_id = ? and status in ('failed', 'cancelled')`,
    )
    .run(id, userId);
  return r.changes > 0;
}

/** Originais guardados para nova tentativa somem depois de alguns dias, para não lotar o disco. */
export function staleFailedUploads(days: number): { id: string; upload_path: string }[] {
  return db()
    .prepare(
      `select id, upload_path from jobs
       where status in ('failed', 'cancelled') and upload_path is not null
         and completed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`,
    )
    .all(`-${days} days`) as { id: string; upload_path: string }[];
}

export function recoverInterruptedJobs(): void {
  db().prepare(
    `update jobs set status = 'failed', error = 'Processamento interrompido após 3 tentativas.',
       completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     where status = 'processing' and attempts >= 3`,
  ).run();
  db().prepare(`update jobs set status = 'queued', stage = null, progress = 0 where status = 'processing'`).run();
}

export function claimNextJob(): JobRow | null {
  const claim = db().transaction((): JobRow | null => {
    const job = db().prepare(`select * from jobs where status = 'queued' order by created_at limit 1`).get() as
      | JobRow
      | undefined;
    if (!job) return null;
    db().prepare(
      `update jobs set status = 'processing', stage = 'starting', progress = 0, attempts = attempts + 1, error = null, notice = null
       where id = ?`,
    ).run(job.id);
    return { ...job, status: 'processing', attempts: job.attempts + 1 };
  });
  return claim();
}

/** Débito/crédito atômico. delta negativo exige saldo suficiente. */
export function adjustCredits(userId: string, jobId: string | null, delta: number, reason: string): boolean {
  const tx = db().transaction((): boolean => {
    const r = db()
      .prepare(`update users set credits = credits + ? where id = ? and credits + ? >= 0`)
      .run(delta, userId, delta);
    if (r.changes === 0) return false;
    db().prepare(`insert into credit_ledger (user_id, job_id, delta, reason) values (?, ?, ?, ?)`).run(
      userId, jobId, delta, reason,
    );
    return true;
  });
  return tx();
}
