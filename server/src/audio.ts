import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from './exec.js';
import type { JobOptions, Word } from './types.js';

export type EnergySample = { start: number; end: number; level: number };

export function audioFilter(mode: JobOptions['audioEnhancement']): string | undefined {
  if (mode === 'off') return undefined;
  const base = 'highpass=f=80,lowpass=f=10000,afftdn=nf=-25:nr=8';
  // A gentle downward expander attenuates room tails in pauses; this is not AI dereverberation.
  const voice = mode === 'voice'
    ? ',equalizer=f=250:t=q:w=1:g=-3,equalizer=f=3000:t=q:w=1:g=2,agate=threshold=0.015:ratio=1.5:range=0.5:attack=10:release=250'
    : '';
  return `${base}${voice},loudnorm=I=-16:TP=-1.5:LRA=11`;
}

export function parseEnergy(text: string, words: Word[]): EnergySample[] {
  const samples: { start: number; db: number }[] = [];
  let start = 0;
  for (const line of text.split('\n')) {
    const time = line.match(/pts_time:([\d.]+)/);
    if (time) start = Number(time[1]);
    const rms = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+)/);
    if (rms && Number.isFinite(Number(rms[1]))) samples.push({ start, db: Number(rms[1]) });
  }
  // Only rank frames containing transcribed speech, so music/applause cannot win by volume alone.
  let cursor = 0;
  const speech = samples.filter(s => {
    while (cursor < words.length && words[cursor].end <= s.start) cursor++;
    return cursor < words.length && words[cursor].start < s.start + 0.5 && s.db > -65;
  });
  const sorted = speech.map(s => s.db).sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * 0.1)] ?? -60;
  const high = sorted[Math.floor(sorted.length * 0.9)] ?? low;
  return speech.map(s => ({ start: s.start, end: s.start + 0.5,
    level: high - low < 3 ? 0.5 : Math.max(0, Math.min(1, (s.db - low) / (high - low))) }));
}

export function energyScore(samples: EnergySample[], start: number, end: number): number | undefined {
  const inside = samples.filter(s => s.start < end && s.end > start);
  if (!inside.length) return undefined;
  return inside.reduce((sum, s) => sum + s.level, 0) / inside.length;
}

export async function analyzeEnergy(file: string, dir: string, words: Word[]): Promise<EnergySample[]> {
  const output = path.join(dir, 'energy.txt');
  const escaped = output.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  await run('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-af',
    `aresample=16000,aformat=channel_layouts=mono,asetnsamples=n=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file='${escaped}'`,
    '-f', 'null', '-']);
  return parseEnergy(await readFile(output, 'utf8'), words);
}
