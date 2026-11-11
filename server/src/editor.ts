import { existsSync } from 'node:fs';
import { db, type ClipRow } from './db.js';
import { UserError } from './errors.js';
import { finalizeFromClean, transcriptOf } from './render.js';
import { normalizeCaptions, type CaptionSettings, type Word } from './types.js';

export type Segment = { start: number; end: number; text: string };

const MIN_CLIP_SECONDS = 2;
const MAX_CLIP_SECONDS = 180;
const MAX_TEXT = 300;

/** Agrupa as palavras em trechos curtos de texto (frases ou pausas), que o editor mostra como campos. */
export function segmentsOf(words: Word[]): Segment[] {
  const out: Segment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) {
      out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: transcriptOf(cur) });
    }
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 0.6 || cur.length >= 8)) flush();
    cur.push(w);
    if (/[.!?…]["”']?$/.test(w.word.trim())) flush();
  }
  flush();
  return out;
}

/**
 * Remonta as palavras a partir dos textos editados. Trecho sem alteração mantém os tempos exatos
 * de cada palavra; trecho alterado distribui as palavras novas ao longo do mesmo intervalo,
 * proporcional ao tamanho de cada uma. Trecho apagado some da legenda.
 */
export function applyTexts(words: Word[], texts: string[]): Word[] {
  const segs = segmentsOf(words);
  if (texts.length !== segs.length) throw new UserError('O texto da legenda mudou desde que o editor foi aberto. Recarregue a página.');
  const out: Word[] = [];
  segs.forEach((seg, i) => {
    const text = String(texts[i] ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    const original = words.filter((w) => w.start >= seg.start - 1e-6 && w.end <= seg.end + 1e-6);
    if (text === seg.text) {
      out.push(...original);
      return;
    }
    const tokens = text ? text.split(' ') : [];
    if (!tokens.length) return;
    const total = tokens.reduce((a, t) => a + t.length + 1, 0);
    const span = Math.max(0.2, seg.end - seg.start);
    let t = seg.start;
    for (const tok of tokens) {
      const d = (span * (tok.length + 1)) / total;
      out.push({ word: ` ${tok}`, start: t, end: t + d * 0.92 });
      t += d;
    }
  });
  return out;
}

export function clipWords(clip: ClipRow): Word[] {
  try {
    const w = JSON.parse(clip.words_json ?? '[]');
    return Array.isArray(w) ? w : [];
  } catch {
    return [];
  }
}

export function clipCaptions(clip: ClipRow): CaptionSettings {
  try {
    return normalizeCaptions(JSON.parse(clip.captions_json ?? '{}'));
  } catch {
    return normalizeCaptions({});
  }
}

export const isEditable = (clip: ClipRow) => Boolean(clip.clean_path && clip.clean_start_ms !== null && existsSync(clip.clean_path));

export type EditInput = {
  version: number;
  startMs: number;
  endMs: number;
  title?: string;
  postCaption?: string;
  captions?: unknown;
  texts?: string[];
};

/** Valida e grava a edição; a re-renderização vai para a fila. */
export function saveEdit(clip: ClipRow, input: EditInput): void {
  if (!isEditable(clip)) {
    throw new UserError('Este clipe foi gerado antes do editor existir. Use "Tentar novamente" ou crie o corte de novo para poder editar.');
  }
  if (clip.rerendering) throw new UserError('Este clipe ainda está sendo atualizado. Aguarde terminar para editar de novo.');
  if (Number(input.version) !== clip.version) {
    throw new UserError('Este clipe foi alterado em outra janela. Recarregue a página para ver a versão atual.');
  }

  const cleanStart = clip.clean_start_ms!;
  const cleanEnd = clip.clean_end_ms!;
  const startMs = Math.round(Number(input.startMs));
  const endMs = Math.round(Number(input.endMs));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new UserError('Início ou fim inválido.');
  if (startMs < cleanStart || endMs > cleanEnd) {
    throw new UserError('O corte só pode ir até alguns segundos antes e depois do trecho original.');
  }
  const dur = (endMs - startMs) / 1000;
  if (dur < MIN_CLIP_SECONDS) throw new UserError(`O clipe precisa ter pelo menos ${MIN_CLIP_SECONDS} segundos.`);
  if (dur > MAX_CLIP_SECONDS) throw new UserError(`O clipe pode ter no máximo ${MAX_CLIP_SECONDS} segundos.`);

  const words = Array.isArray(input.texts) ? applyTexts(clipWords(clip), input.texts.map(String)) : clipWords(clip);
  const captions = normalizeCaptions(input.captions, clipCaptions(clip));
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 120) : clip.title;
  const post = typeof input.postCaption === 'string' ? input.postCaption.slice(0, 2200) : clip.post_caption;

  db()
    .prepare(
      `update clips set start_ms = ?, end_ms = ?, title = ?, post_caption = ?, words_json = ?, captions_json = ?,
         rerendering = 1, render_error = null
       where id = ?`,
    )
    .run(startMs, endMs, title, post, JSON.stringify(words), JSON.stringify(captions), clip.id);
  enqueue(clip.id);
}

// ── Fila de re-renderização: um clipe por vez, para não disputar CPU além do necessário. ──
const queue: string[] = [];
let running = false;

export function enqueue(clipId: string): void {
  if (!queue.includes(clipId)) queue.push(clipId);
  void drain();
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      await rerender(id);
    }
  } finally {
    running = false;
  }
}

async function rerender(id: string): Promise<void> {
  const clip = db().prepare('select * from clips where id = ?').get(id) as ClipRow | undefined;
  if (!clip) return;
  try {
    if (!isEditable(clip)) throw new UserError('A versão limpa deste clipe não está mais no servidor.');
    const { transcript } = await finalizeFromClean({
      clean: clip.clean_path!,
      cleanStart: clip.clean_start_ms! / 1000,
      words: clipWords(clip),
      start: clip.start_ms / 1000,
      end: clip.end_ms / 1000,
      captions: clipCaptions(clip),
      out: clip.file_path,
    });
    db()
      .prepare('update clips set transcript = ?, rerendering = 0, render_error = null, version = version + 1 where id = ?')
      .run(transcript, id);
  } catch (err) {
    console.error(`[clipe ${id}] falha ao atualizar:`, err);
    const msg = err instanceof UserError ? err.message : `Falha ao atualizar o clipe: ${String((err as Error)?.message ?? err).split('\n')[0].slice(0, 200)}`;
    db().prepare('update clips set rerendering = 0, render_error = ?, version = version + 1 where id = ?').run(msg, id);
  }
}

/** Clipes que estavam sendo atualizados quando o servidor caiu voltam para a fila. */
export function resumePendingRerenders(): void {
  const pending = db().prepare('select id from clips where rerendering = 1').all() as { id: string }[];
  pending.forEach((p) => enqueue(p.id));
}

/** Dados que a tela de edição precisa. */
export function editorData(clip: ClipRow) {
  const words = clipWords(clip);
  return {
    clip: {
      id: clip.id,
      jobId: clip.job_id,
      title: clip.title,
      postCaption: clip.post_caption,
      startMs: clip.start_ms,
      endMs: clip.end_ms,
      version: clip.version,
      rerendering: Boolean(clip.rerendering),
      aspect: clip.aspect,
    },
    clean: { startMs: clip.clean_start_ms, endMs: clip.clean_end_ms },
    captions: clipCaptions(clip),
    segments: segmentsOf(words),
    words,
  };
}
