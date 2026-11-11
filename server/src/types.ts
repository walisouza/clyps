export type Word = { word: string; start: number; end: number };

export type Aspect = '9:16' | '1:1' | '4:5' | 'original';
export type Layout = 'fill' | 'blur';
export type CaptionStyle = 'karaoke' | 'bold' | 'minimal' | 'none';
export type CaptionPosition = 'bottom' | 'center' | 'top';
export type ClipLength = 'short' | 'medium' | 'long';
export type CaptionSize = 'small' | 'medium' | 'large';
export const CAPTION_SCALE: Record<CaptionSize, number> = { small: 0.8, medium: 1, large: 1.3 };
export type AudioEnhance = 'off' | 'light' | 'strong' | 'auphonic';

export type JobOptions = {
  language: 'pt' | 'en' | 'es';
  maxClips: number;
  clipLength: ClipLength;
  aspect: Aspect;
  layout: Layout;
  captionStyle: CaptionStyle;
  captionPosition: CaptionPosition;
  highlightColor: string;
  captionSize: CaptionSize;
  audioEnhance: AudioEnhance;
  context?: string;
};

export type Selection = {
  start: number;
  end: number;
  title: string;
  reason: string;
  score: number;
  /** Texto sugerido para o post nas redes sociais. */
  post?: string;
  /** Energia do trecho (0 a 100), calculada pelo áudio. */
  energy?: number;
};

export const LENGTH_RANGES: Record<ClipLength, [number, number]> = {
  short: [15, 40],
  medium: [30, 60],
  long: [45, 90],
};

export function normalizeOptions(raw: unknown): JobOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
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
    captionSize: pick(o.captionSize, ['small', 'medium', 'large'] as const, 'medium'),
    audioEnhance: pick(o.audioEnhance, ['off', 'light', 'strong', 'auphonic'] as const, 'light'),
    context: typeof o.context === 'string' && o.context.trim() ? o.context.trim().slice(0, 1000) : undefined,
  };
}

/** Legenda de um clipe já gerado (editável depois). */
export type CaptionSettings = {
  enabled: boolean;
  style: Exclude<CaptionStyle, 'none'>;
  position: CaptionPosition;
  highlightColor: string;
  size: CaptionSize;
};

export function normalizeCaptions(raw: unknown, fallback?: CaptionSettings): CaptionSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const base: CaptionSettings = fallback ?? { enabled: true, style: 'karaoke', position: 'bottom', highlightColor: '#FFE14D', size: 'medium' };
  const sizes = ['small', 'medium', 'large'] as const;
  const styles = ['karaoke', 'bold', 'minimal'] as const;
  const positions = ['bottom', 'center', 'top'] as const;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : base.enabled,
    style: styles.includes(o.style as any) ? (o.style as CaptionSettings['style']) : base.style,
    position: positions.includes(o.position as any) ? (o.position as CaptionPosition) : base.position,
    highlightColor: /^#[0-9a-fA-F]{6}$/.test(String(o.highlightColor)) ? String(o.highlightColor) : base.highlightColor,
    size: sizes.includes(o.size as any) ? (o.size as CaptionSize) : base.size,
  };
}

/** Configuração inicial da legenda a partir das opções do corte. */
export function captionsFromOptions(opts: JobOptions): CaptionSettings {
  return {
    enabled: opts.captionStyle !== 'none',
    style: opts.captionStyle === 'none' ? 'karaoke' : opts.captionStyle,
    position: opts.captionPosition,
    highlightColor: opts.highlightColor,
    size: opts.captionSize,
  };
}
