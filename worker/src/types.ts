export type Word = { word: string; start: number; end: number };

export type Aspect = '9:16' | '1:1' | '4:5' | 'original';
export type Layout = 'fill' | 'blur';
export type CaptionStyle = 'karaoke' | 'bold' | 'minimal' | 'none';
export type CaptionPosition = 'bottom' | 'center' | 'top';
export type ClipLength = 'short' | 'medium' | 'long';

export type JobOptions = {
  language: 'pt' | 'en' | 'es';
  maxClips: number;
  clipLength: ClipLength;
  aspect: Aspect;
  layout: Layout;
  captionStyle: CaptionStyle;
  captionPosition: CaptionPosition;
  highlightColor: string;
  context?: string;
};

export type Job = {
  id: string;
  user_id: string;
  status: string;
  source_type: 'url' | 'upload';
  source_url: string | null;
  storage_key: string | null;
  title: string | null;
  options: Partial<JobOptions>;
};

export type Selection = {
  start: number;
  end: number;
  title: string;
  reason: string;
  score: number;
};

export const LENGTH_RANGES: Record<ClipLength, [number, number]> = {
  short: [15, 40],
  medium: [30, 60],
  long: [45, 90],
};

export function normalizeOptions(raw: Partial<JobOptions> | null | undefined): JobOptions {
  const o = raw ?? {};
  const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
    allowed.includes(v as T) ? (v as T) : d;
  const maxClips = Math.round(Number(o.maxClips));
  return {
    language: pick(o.language, ['pt', 'en', 'es'] as const, 'pt'),
    maxClips: Number.isFinite(maxClips) ? Math.min(20, Math.max(1, maxClips)) : 6,
    clipLength: pick(o.clipLength, ['short', 'medium', 'long'] as const, 'medium'),
    aspect: pick(o.aspect, ['9:16', '1:1', '4:5', 'original'] as const, '9:16'),
    layout: pick(o.layout, ['fill', 'blur'] as const, 'fill'),
    captionStyle: pick(o.captionStyle, ['karaoke', 'bold', 'minimal', 'none'] as const, 'karaoke'),
    captionPosition: pick(o.captionPosition, ['bottom', 'center', 'top'] as const, 'bottom'),
    highlightColor: /^#[0-9a-fA-F]{6}$/.test(String(o.highlightColor)) ? String(o.highlightColor) : '#FFE14D',
    context: typeof o.context === 'string' ? o.context.slice(0, 1000) : undefined,
  };
}
