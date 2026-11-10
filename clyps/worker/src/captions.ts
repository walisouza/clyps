import type { CaptionPosition, CaptionStyle, Word } from './types.js';

type CaptionInput = {
  words: Word[]; // tempos relativos ao início do clipe, em segundos
  style: Exclude<CaptionStyle, 'none'>;
  position: CaptionPosition;
  highlightColor: string; // #RRGGBB
  font: string;
  width: number;
  height: number;
};

const PRESETS = {
  karaoke: { maxWords: 4, sizeRatio: 0.058, upper: false, highlight: true, outline: 0.09 },
  bold: { maxWords: 2, sizeRatio: 0.085, upper: true, highlight: true, outline: 0.1 },
  minimal: { maxWords: 7, sizeRatio: 0.04, upper: false, highlight: false, outline: 0.07 },
} as const;

/** #RRGGBB → &H00BBGGRR (formato de cor do ASS). */
function assColor(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '&H00FFFFFF';
  return `&H00${m[3]}${m[2]}${m[1]}`.toUpperCase();
}

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

const clean = (t: string) => t.replace(/[{}\\\r\n]/g, '').trim();

/** Agrupa palavras em blocos curtos, quebrando em pausas e no fim de frases. */
export function groupWords(words: Word[], maxWords: number): Word[][] {
  const blocks: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const pause = prev ? w.start - prev.end > 0.6 : false;
    const sentenceEnd = prev ? /[.!?…]$/.test(prev.word.trim()) : false;
    if (cur.length >= maxWords || pause || (sentenceEnd && cur.length >= 2)) {
      blocks.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

export function buildAss(input: CaptionInput): string {
  const preset = PRESETS[input.style];
  const base = Math.min(input.width, input.height * 0.75);
  const fontSize = Math.round(base * preset.sizeRatio * 1.6);
  const outline = Math.max(2, Math.round(fontSize * preset.outline));
  const alignment = input.position === 'top' ? 8 : input.position === 'center' ? 5 : 2;
  const marginV = Math.round(input.height * (input.position === 'center' ? 0 : 0.14));
  const marginH = Math.round(input.width * 0.07);
  const primary = '&H00FFFFFF';
  const highlight = assColor(input.highlightColor);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${input.width}`,
    `PlayResY: ${input.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${input.font},${fontSize},${primary},${primary},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},${Math.round(outline / 2)},${alignment},${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  const text = (w: Word) => {
    const t = clean(w.word);
    return preset.upper ? t.toUpperCase() : t;
  };
  const blocks = groupWords(input.words.filter((w) => clean(w.word)), preset.maxWords);

  blocks.forEach((block, bi) => {
    const next = blocks[bi + 1];
    const blockEnd = Math.min(block[block.length - 1].end + 0.25, next ? next[0].start : Infinity);

    if (!preset.highlight) {
      events.push(`Dialogue: 0,${assTime(block[0].start)},${assTime(blockEnd)},Default,,0,0,0,,${block.map(text).join(' ')}`);
      return;
    }
    // Um evento por palavra: o bloco inteiro fica na tela e a palavra falada muda de cor.
    block.forEach((w, wi) => {
      const start = wi === 0 ? block[0].start : w.start;
      const end = wi === block.length - 1 ? blockEnd : block[wi + 1].start;
      if (end <= start) return;
      const line = block
        .map((x, xi) => (xi === wi ? `{\\c${highlight}&}${text(x)}{\\c${primary}&}` : text(x)))
        .join(' ');
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${line}`);
    });
  });

  return [...header, ...events, ''].join('\n');
}
