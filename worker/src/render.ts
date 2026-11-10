import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAss } from './captions.js';
import { config } from './config.js';
import { outputSize, renderClip, type Probe } from './media.js';
import type { JobOptions, Selection, Word } from './types.js';

export type RenderedClip = { file: string; transcript: string; selection: Selection };

/** Renderiza um trecho selecionado: corte + reenquadramento + legenda. Sem dependência de banco. */
export async function renderSelection(
  src: string,
  info: Probe,
  words: Word[],
  selection: Selection,
  opts: JobOptions,
  outDir: string,
  index: number,
): Promise<RenderedClip> {
  const size = outputSize(opts.aspect, info);
  const clipWords = words
    .filter((w) => w.start >= selection.start - 0.05 && w.end <= selection.end + 0.05)
    .map((w) => ({ word: w.word, start: Math.max(0, w.start - selection.start), end: w.end - selection.start }));

  let assPath: string | undefined;
  if (opts.captionStyle !== 'none' && clipWords.length) {
    assPath = path.join(outDir, `clip-${index}.ass`);
    await writeFile(
      assPath,
      buildAss({
        words: clipWords,
        style: opts.captionStyle,
        position: opts.captionPosition,
        highlightColor: opts.highlightColor,
        font: config.captionFont,
        width: size.w,
        height: size.h,
      }),
    );
  }

  const file = path.join(outDir, `clip-${index}.mp4`);
  await renderClip({
    src,
    out: file,
    startSec: selection.start,
    durationSec: selection.end - selection.start,
    size,
    layout: opts.aspect === 'original' ? 'fill' : opts.layout,
    assPath,
    hasAudio: info.hasAudio,
  });

  return { file, transcript: clipWords.map((w) => w.word.trim()).join(' '), selection };
}
