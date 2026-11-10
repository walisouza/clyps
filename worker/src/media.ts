import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { run } from './exec.js';
import type { Aspect, Layout } from './types.js';

export type Probe = { duration: number; width: number; height: number; hasAudio: boolean };

export async function probe(file: string): Promise<Probe> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const info = JSON.parse(stdout);
  const video = info.streams?.find((s: any) => s.codec_type === 'video');
  if (!video) throw new Error('O arquivo não tem faixa de vídeo.');
  return {
    duration: Number(info.format?.duration ?? video.duration ?? 0),
    width: Number(video.width),
    height: Number(video.height),
    hasAudio: Boolean(info.streams?.some((s: any) => s.codec_type === 'audio')),
  };
}

export async function ytInfo(url: string): Promise<{ title: string; duration: number }> {
  const { stdout } = await run('yt-dlp', ['--dump-single-json', '--no-playlist', '--no-warnings', '--', url], 120_000);
  const j = JSON.parse(stdout);
  return { title: String(j.title ?? 'Vídeo'), duration: Number(j.duration ?? 0) };
}

export async function ytDownload(url: string, out: string): Promise<void> {
  await run('yt-dlp', [
    '--no-playlist', '--no-warnings',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '-o', out,
    '--', url,
  ]);
}

export const SEGMENT_SECONDS = 1200;

/** Extrai o áudio em MP3 mono leve, em partes de 20 min (limite de upload das APIs de transcrição). */
export async function extractAudioSegments(file: string, dir: string): Promise<string[]> {
  await run('ffmpeg', [
    '-y', '-v', 'error', '-i', file,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
    '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-reset_timestamps', '1',
    path.join(dir, 'audio-%03d.mp3'),
  ]);
  const files = (await readdir(dir)).filter((f) => f.startsWith('audio-')).sort();
  return files.map((f) => path.join(dir, f));
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function outputSize(aspect: Aspect, src: { width: number; height: number }): { w: number; h: number } {
  if (aspect === '9:16') return { w: 1080, h: 1920 };
  if (aspect === '1:1') return { w: 1080, h: 1080 };
  if (aspect === '4:5') return { w: 1080, h: 1350 };
  const scale = Math.min(1, 1920 / Math.max(src.width, src.height));
  return { w: even(src.width * scale), h: even(src.height * scale) };
}

const escapeFilterPath = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

export type RenderInput = {
  src: string;
  out: string;
  startSec: number;
  durationSec: number;
  size: { w: number; h: number };
  layout: Layout;
  assPath?: string;
  hasAudio: boolean;
};

/** Corta o trecho, reenquadra para o formato pedido e queima a legenda. */
export async function renderClip(r: RenderInput): Promise<void> {
  const { w, h } = r.size;
  const chain: string[] = [];
  if (r.layout === 'blur') {
    chain.push(
      `[0:v]split=2[bgsrc][fgsrc]`,
      `[bgsrc]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=24:2[bg]`,
      `[fgsrc]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[base]`,
    );
  } else {
    chain.push(`[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1[base]`);
  }
  chain.push(r.assPath ? `[base]ass='${escapeFilterPath(r.assPath)}'[v]` : `[base]null[v]`);

  const args = [
    '-y', '-v', 'error',
    '-ss', r.startSec.toFixed(3), '-i', r.src, '-t', r.durationSec.toFixed(3),
    '-filter_complex', chain.join(';'),
    '-map', '[v]',
  ];
  if (r.hasAudio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k');
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    r.out,
  );
  await run('ffmpeg', args);
}
