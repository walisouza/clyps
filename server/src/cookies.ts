import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export const MAX_COOKIES_BYTES = 1024 * 1024; // 1 MB — cookies.txt tem alguns KB no normal

/** Um arquivo por usuário, nomeado pelo UUID (não há caminho construído com dado do usuário). */
export const cookiesPath = (userId: string) => path.join(config.dataDir, 'cookies', `${userId}.txt`);

/** Checa rapidamente que o conteúdo parece um cookies.txt no formato Netscape. */
export function looksLikeNetscapeCookies(text: string): boolean {
  const head = text.slice(0, 4000);
  if (/^#\s*Netscape HTTP Cookie File/i.test(head)) return true;
  // Linhas típicas: <domínio> <TRUE/FALSE> <path> <TRUE/FALSE> <expira> <nome> <valor>
  const lines = head.split('\n').filter((l) => l && !l.startsWith('#'));
  return lines.some((l) => /^\.?[\w.-]+\t(TRUE|FALSE)\t.+\t(TRUE|FALSE)\t\d+\t\S+\t/.test(l));
}

export async function saveCookies(userId: string, text: string): Promise<void> {
  const file = cookiesPath(userId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  await chmod(file, 0o600).catch(() => {});
}

export async function cookiesStatus(userId: string): Promise<{ hasCookies: boolean; uploadedAt?: string; size?: number }> {
  try {
    const s = await stat(cookiesPath(userId));
    return { hasCookies: true, uploadedAt: s.mtime.toISOString(), size: s.size };
  } catch {
    return { hasCookies: false };
  }
}

export async function removeCookies(userId: string): Promise<void> {
  await rm(cookiesPath(userId), { force: true });
}
