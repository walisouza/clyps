// Mesma conta do servidor (server/src/framing.ts), para a prévia do editor bater com o clipe gerado.
export type Layout = 'fill' | 'blur';
export type Framing = { layout: Layout; zoom: number; x: number; y: number };
export type CleanKind = 'source' | 'framed';
type Size = { w: number; h: number };

export const MAX_ZOOM = 3;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function targetSize(aspect: string, kind: CleanKind, clean: Size): Size {
  if (kind === 'framed') return clean;
  if (aspect === '9:16') return { w: 1080, h: 1920 };
  if (aspect === '1:1') return { w: 1080, h: 1080 };
  if (aspect === '4:5') return { w: 1080, h: 1350 };
  const s = Math.min(1, 1920 / Math.max(clean.w, clean.h));
  return { w: even(clean.w * s), h: even(clean.h * s) };
}

export function placement(src: Size, target: Size, f: Framing) {
  const base = f.layout === 'fill' ? Math.max(target.w / src.w, target.h / src.h) : Math.min(target.w / src.w, target.h / src.h);
  const k = base * f.zoom;
  const fw = src.w * k;
  const fh = src.h * k;
  return { fw, fh, ox: f.x * (target.w - fw), oy: f.y * (target.h - fh) };
}
