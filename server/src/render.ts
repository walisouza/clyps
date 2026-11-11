import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clipAudioFilter, passthroughAudioFilter } from './audio.js';
import { buildAss } from './captions.js';
import { config } from './config.js';
import { audioChannels, burnFromClean, outputSize, probe, renderClip, type Probe } from './media.js';
import { CAPTION_SCALE, type CaptionSettings, type JobOptions, type Word } from './types.js';

/** Folga (s) guardada antes e depois de cada clipe na versão limpa, para dar para estender o corte na edição. */
export const CLEAN_PAD = 3;

export type Range = { start: number; end: number };

export function cleanRange(s: Range, videoDuration: number): Range {
  return { start: Math.max(0, s.start - CLEAN_PAD), end: Math.min(videoDuration, s.end + CLEAN_PAD) };
}

/** Palavras dentro do intervalo, com tempos relativos ao início dele. */
export function wordsIn(words: Word[], start: number, end: number): Word[] {
  return words
    .filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05)
    .map((w) => ({ word: w.word, start: Math.max(0, w.start - start), end: w.end - start }));
}

export const transcriptOf = (words: Word[]) => words.map((w) => w.word.trim()).filter(Boolean).join(' ');

/**
 * Versão limpa do clipe: reenquadrada, com o áudio tratado e sem legenda, cobrindo a folga.
 * É a base do clipe final e das edições posteriores.
 */
export async function renderClean(
  src: string,
  info: Probe,
  range: Range,
  opts: JobOptions,
  out: string,
  /** Áudio do intervalo já tratado (Auphonic). Sem ele, aplica o filtro local do modo escolhido. */
  audioFile?: string,
): Promise<void> {
  await renderClip({
    src,
    out,
    startSec: range.start,
    durationSec: range.end - range.start,
    size: outputSize(opts.aspect, info),
    layout: opts.aspect === 'original' ? 'fill' : opts.layout,
    hasAudio: info.hasAudio,
    // Áudio do Auphonic já vem tratado: só padroniza os canais.
    audioFilter: audioFile
      ? passthroughAudioFilter(await audioChannels(audioFile))
      : clipAudioFilter(opts.audioEnhance, info.audioChannels),
    audioFile,
    crf: 18, // um pouco acima do final, porque ainda vai ser recodificado
  });
}

/**
 * Clipe final a partir da versão limpa: recorta [start, end] (tempos absolutos no vídeo original)
 * e queima a legenda conforme `captions`. Grava num arquivo temporário e troca no fim, para o
 * clipe antigo continuar disponível enquanto o novo é gerado.
 */
export async function finalizeFromClean(input: {
  clean: string;
  cleanStart: number;
  words: Word[];
  start: number;
  end: number;
  captions: CaptionSettings;
  out: string;
}): Promise<{ transcript: string }> {
  const clipWords = wordsIn(input.words, input.start, input.end);
  const tmp = `${input.out}.tmp.mp4`;
  const assPath = `${input.out}.ass`;
  let useAss = false;

  if (input.captions.enabled && clipWords.length) {
    const { width, height } = await probe(input.clean);
    await writeFile(
      assPath,
      buildAss({
        words: clipWords,
        style: input.captions.style,
        position: input.captions.position,
        highlightColor: input.captions.highlightColor,
        font: config.captionFont,
        width,
        height,
        scale: CAPTION_SCALE[input.captions.size],
      }),
    );
    useAss = true;
  }

  try {
    await burnFromClean({
      clean: input.clean,
      out: tmp,
      offsetSec: input.start - input.cleanStart,
      durationSec: input.end - input.start,
      assPath: useAss ? assPath : undefined,
    });
    await rename(tmp, input.out);
  } finally {
    await rm(tmp, { force: true });
    await rm(assPath, { force: true });
  }
  return { transcript: transcriptOf(clipWords) };
}

export const cleanFileName = (dir: string, index: number) => path.join(dir, `clean-${index}.mp4`);
export const clipFileName = (dir: string, index: number) => path.join(dir, `clip-${index}.mp4`);
