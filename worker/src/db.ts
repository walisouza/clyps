import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';
import type { Job } from './types.js';

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  client ??= createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

export async function claimNextJob(): Promise<Job | null> {
  const { data, error } = await db().rpc('claim_next_job');
  if (error) throw new Error(`claim_next_job: ${error.message}`);
  return (data as Job[] | null)?.[0] ?? null;
}

/** Atualiza o job e renova o "locked_at" (sinal de vida do worker). */
export async function updateJob(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db()
    .from('jobs')
    .update({ ...patch, locked_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`Atualizar job: ${error.message}`);
}

export async function adjustCredits(userId: string, jobId: string, delta: number, reason: string): Promise<boolean> {
  const { data, error } = await db().rpc('adjust_credits', {
    p_user: userId,
    p_job: jobId,
    p_delta: delta,
    p_reason: reason,
  });
  if (error) throw new Error(`adjust_credits: ${error.message}`);
  return data === true;
}
