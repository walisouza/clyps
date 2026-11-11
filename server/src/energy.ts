import { spawn } from 'node:child_process';

/** Resolução da análise de energia, em segundos. */
export const ENERGY_STEP = 0.5;
const SAMPLE_RATE = 8000;

const toDb = (meanSquare: number) => (meanSquare <= 0 ? -96 : 10 * Math.log10(meanSquare / (32768 * 32768)));

/** Volume (dBFS) do áudio a cada meio segundo, lendo o PCM direto do FFmpeg sem gravar arquivo. */
export function measureEnergy(file: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const perWindow = SAMPLE_RATE * ENERGY_STEP;
    const levels: number[] = [];
    let sum = 0;
    let n = 0;
    let leftover: Buffer | null = null;
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const s = buf.readInt16LE(i);
        sum += s * s;
        if (++n === perWindow) {
          levels.push(toDb(sum / n));
          sum = 0;
          n = 0;
        }
      }
      leftover = usable < buf.length ? buf.subarray(usable) : null;
    });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (n > 0) levels.push(toDb(sum / n));
      if (code === 0) resolve(levels);
      else reject(new Error(`ffmpeg (energia) saiu com código ${code}: ${stderr}`));
    });
  });
}

/**
 * Normaliza para 0..1 em relação ao próprio vídeo: 0 ≈ fala calma (percentil 20), 1 ≈ picos (percentil 95).
 * Silêncios ficam em 0. Assim um vídeo baixo e um alto são comparados pela variação, não pelo volume absoluto.
 */
export function normalizeEnergy(levels: number[]): number[] {
  const voiced = levels.filter((d) => d > -55).sort((a, b) => a - b);
  if (voiced.length < 4) return levels.map(() => 0);
  const q = (p: number) => voiced[Math.min(voiced.length - 1, Math.floor(p * voiced.length))];
  const lo = q(0.2);
  const span = Math.max(3, q(0.95) - lo);
  return levels.map((d) => Math.max(0, Math.min(1, (d - lo) / span)));
}

export function avgEnergy(norm: number[], start: number, end: number): number {
  const a = Math.max(0, Math.floor(start / ENERGY_STEP));
  const b = Math.min(norm.length, Math.ceil(end / ENERGY_STEP));
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += norm[i];
  return s / (b - a);
}

/** Nota de energia do trecho (0 a 100). Os 3 primeiros segundos pesam mais: é o gancho. */
export function segmentEnergyScore(norm: number[], start: number, end: number): number {
  if (!norm.length) return 0;
  const avg = avgEnergy(norm, start, end);
  const hook = avgEnergy(norm, start, Math.min(end, start + 3));
  return Math.round(100 * (0.6 * avg + 0.4 * hook));
}
