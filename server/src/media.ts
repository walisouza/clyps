import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { run } from './exec.js';
import type { Aspect, Layout } from './types.js';

/** Número de canais do primeiro áudio de um arquivo (serve para arquivos só de áudio). */
export async function audioChannels(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', file,
  ]);
  return Number(stdout.trim()) || 2;
}

export type Probe = { duration: number; width: number; height: number; hasAudio: boolean; audioChannels: number };

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
    audioChannels: Number(info.streams?.find((s: any) => s.codec_type === 'audio')?.channels) || 2,
  };
}

/** Cookies no formato Netscape (exportado do navegador) usados pelo yt-dlp quando presente. */
const withCookies = (args: string[], cookiesPath?: string) =>
  cookiesPath ? ['--cookies', cookiesPath, ...args] : args;

export type VideoInfo = {
  title: string;
  duration: number;
  thumbnail: string | null;
  uploader: string | null;
  site: string | null;
};

const httpUrl = (v: unknown) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : null);

export async function ytInfo(url: string, cookiesPath?: string, timeoutMs = 120_000): Promise<VideoInfo> {
  const { stdout } = await run(
    'yt-dlp',
    withCookies(['--dump-single-json', '--no-playlist', '--no-warnings', '--socket-timeout', '20', '--', url], cookiesPath),
    timeoutMs,
  );
  const j = JSON.parse(stdout);
  const thumbs = Array.isArray(j.thumbnails) ? j.thumbnails : [];
  return {
    title: String(j.title ?? 'Vídeo').slice(0, 300),
    duration: Number(j.duration ?? 0),
    thumbnail: httpUrl(j.thumbnail) ?? httpUrl(thumbs[thumbs.length - 1]?.url),
    uploader: typeof j.uploader === 'string' ? j.uploader.slice(0, 120) : typeof j.channel === 'string' ? j.channel.slice(0, 120) : null,
    site: typeof j.extractor_key === 'string' ? j.extractor_key : null,
  };
}

export async function ytDownload(url: string, out: string, cookiesPath?: string): Promise<void> {
  await run(
    'yt-dlp',
    withCookies(
      [
        '--no-playlist', '--no-warnings',
        '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
        '--merge-output-format', 'mp4',
        '-o', out,
        '--', url,
      ],
      cookiesPath,
    ),
  );
}

/** Áudio inteiro em um MP3 mono leve (para a AssemblyAI, que aceita arquivos longos). */
export async function extractAudio(file: string, out: string): Promise<void> {
  await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', out]);
}

/** Áudio de um trecho em FLAC 48 kHz, sem perdas (entrada do Auphonic). */
export async function extractClipAudio(file: string, out: string, startSec: number, durationSec: number): Promise<void> {
  await run('ffmpeg', [
    '-y', '-v', 'error', '-ss', startSec.toFixed(3), '-i', file, '-t', durationSec.toFixed(3),
    '-vn', '-ar', '48000', '-c:a', 'flac', out,
  ]);
}

/** Duração de cada parte enviada à transcrição (APIs na nuvem aceitam 20 min; o Speaches local vai melhor com 10). */
export const SEGMENT_SECONDS = 1200;

/** Extrai o áudio em MP3 mono leve, em partes de 20 min (limite de upload das APIs de transcrição). */
export async function extractAudioSegments(
  file: string,
  dir: string,
  audioFilter?: string,
  segmentSeconds = SEGMENT_SECONDS,
): Promise<string[]> {
  await run('ffmpeg', [
    '-y', '-v', 'error', '-i', file,
    '-vn', ...(audioFilter ? ['-af', audioFilter] : []), '-ac', '1', '-ar', '16000', '-b:a', '32k',
    '-f', 'segment', '-segment_time', String(segmentSeconds), '-reset_timestamps', '1',
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

export const escapeFilterPath = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

export type RenderInput = {
  src: string;
  out: string;
  startSec: number;
  durationSec: number;
  size: { w: number; h: number };
  layout: Layout;
  assPath?: string;
  hasAudio: boolean;
  /** Cadeia de filtros de áudio (tratamento de voz). Aplicada ao áudio tratado (audioFile) quando ele existe. */
  audioFilter?: string;
  /** Áudio já tratado (Auphonic), com o mesmo início e duração do trecho. Substitui o áudio original. */
  audioFile?: string;
  /** Qualidade do x264 (menor = melhor). */
  crf?: number;
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
  // O áudio sempre passa por uma cadeia que termina em estéreo 48 kHz explícito (ver audio.ts).
  if (r.hasAudio && r.audioFilter) chain.push(`[${r.audioFile ? '1:a:0' : '0:a:0'}]${r.audioFilter}[a]`);

  const args = [
    '-y', '-v', 'error',
    '-ss', r.startSec.toFixed(3), '-i', r.src,
    // O áudio tratado entra como segunda entrada, antes do -t (que vale para a saída).
    ...(r.hasAudio && r.audioFile ? ['-i', r.audioFile] : []),
    '-t', r.durationSec.toFixed(3),
    '-filter_complex', chain.join(';'),
    '-map', '[v]',
  ];
  if (r.hasAudio) {
    const audioMap = r.audioFilter ? '[a]' : r.audioFile ? '1:a:0' : '0:a:0';
    args.push('-map', audioMap, '-c:a', 'aac', '-b:a', '160k');
  }
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(r.crf ?? 20), '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    r.out,
  );
  await run('ffmpeg', args);
}

/**
 * Gera o clipe final a partir da versão limpa: recorta [offset, offset+duração] e queima a legenda (se houver).
 * O vídeo limpo já está reenquadrado e com o áudio tratado, então isso é bem mais rápido que o render completo.
 */
export async function burnFromClean(input: {
  clean: string;
  out: string;
  offsetSec: number;
  durationSec: number;
  /** Filtro de enquadramento que leva [0:v] para [base] (ver framing.ts). */
  framing: string;
  assPath?: string;
}): Promise<void> {
  const chain = [input.framing, input.assPath ? `[base]ass='${escapeFilterPath(input.assPath)}'[v]` : `[base]null[v]`];
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-ss', Math.max(0, input.offsetSec).toFixed(3), '-i', input.clean, '-t', input.durationSec.toFixed(3),
    '-filter_complex', chain.join(';'),
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    input.out,
  ]);
}
