import type { Aspect, Layout } from './types.js';

/**
 * Enquadramento do clipe: como o vídeo limpo é colocado na moldura final.
 * - layout `fill`: o vídeo cobre a moldura inteira (corta o que sobra).
 * - layout `blur`: o vídeo aparece inteiro, sobre um fundo desfocado dele mesmo.
 * - zoom: 1 a 3, a partir do tamanho base do layout.
 * - x, y: 0 a 1, qual parte do vídeo fica visível (0,5 = centro).
 * A mesma conta roda no editor (web/src/lib/framing.ts) para a prévia bater com o resultado.
 */
export type Framing = { layout: Layout; zoom: number; x: number; y: number };

/** 'source': versão limpa no formato do vídeo original (clipes novos). 'framed': já reenquadrada (clipes antigos). */
export type CleanKind = 'source' | 'framed';

export const MAX_ZOOM = 3;

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function normalizeFraming(raw: unknown, fallback?: Framing): Framing {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const base = fallback ?? { layout: 'fill', zoom: 1, x: 0.5, y: 0.5 };
  return {
    layout: o.layout === 'fill' || o.layout === 'blur' ? o.layout : base.layout,
    zoom: Math.round(clamp(num(o.zoom, base.zoom), 1, MAX_ZOOM) * 100) / 100,
    x: Math.round(clamp(num(o.x, base.x), 0, 1) * 1000) / 1000,
    y: Math.round(clamp(num(o.y, base.y), 0, 1) * 1000) / 1000,
  };
}

export const defaultFraming = (aspect: Aspect, layout: Layout): Framing => ({
  layout: aspect === 'original' ? 'fill' : layout,
  zoom: 1,
  x: 0.5,
  y: 0.5,
});

type Size = { w: number; h: number };
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Tamanho da moldura final a partir do formato e do tamanho do vídeo limpo. */
export function targetSize(aspect: Aspect, kind: CleanKind, clean: Size): Size {
  if (kind === 'framed') return clean;
  if (aspect === '9:16') return { w: 1080, h: 1920 };
  if (aspect === '1:1') return { w: 1080, h: 1080 };
  if (aspect === '4:5') return { w: 1080, h: 1350 };
  const s = Math.min(1, 1920 / Math.max(clean.w, clean.h));
  return { w: even(clean.w * s), h: even(clean.h * s) };
}

/** Onde o vídeo fica na moldura: tamanho (fw, fh) e posição do canto (ox, oy), em pixels da moldura. */
export function placement(src: Size, target: Size, f: Framing) {
  const base = f.layout === 'fill' ? Math.max(target.w / src.w, target.h / src.h) : Math.min(target.w / src.w, target.h / src.h);
  const k = base * f.zoom;
  const fw = src.w * k;
  const fh = src.h * k;
  return { k, fw, fh, ox: f.x * (target.w - fw), oy: f.y * (target.h - fh) };
}

/**
 * Filtro do FFmpeg que leva `[in]` (vídeo limpo) para `[out]` (moldura final).
 * Recorta só a parte visível antes de escalar, para o zoom não criar quadros enormes.
 */
export function framingFilter(src: Size, target: Size, f: Framing, input = '0:v', output = 'base'): string {
  const { w: W, h: H } = target;
  const { k, fw, fh, ox, oy } = placement(src, target, f);
  const vx0 = Math.max(0, ox), vx1 = Math.min(W, ox + fw);
  const vy0 = Math.max(0, oy), vy1 = Math.min(H, oy + fh);

  const cx = clamp(Math.floor((vx0 - ox) / k), 0, src.w - 2);
  const cy = clamp(Math.floor((vy0 - oy) / k), 0, src.h - 2);
  const cw = clamp(Math.round((vx1 - vx0) / k), 2, src.w - cx);
  const ch = clamp(Math.round((vy1 - vy0) / k), 2, src.h - cy);
  const dw = Math.min(W, even(vx1 - vx0));
  const dh = Math.min(H, even(vy1 - vy0));
  const fg = `crop=${cw}:${ch}:${cx}:${cy},scale=${dw}:${dh}`;

  if (dw >= W && dh >= H) return `[${input}]${fg},setsar=1[${output}]`;
  const px = Math.round(clamp(vx0, 0, W - dw));
  const py = Math.round(clamp(vy0, 0, H - dh));
  return [
    `[${input}]split=2[fr_bg][fr_fg]`,
    `[fr_bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2[fr_b]`,
    `[fr_fg]${fg}[fr_f]`,
    `[fr_b][fr_f]overlay=${px}:${py},setsar=1[${output}]`,
  ].join(';');
}
