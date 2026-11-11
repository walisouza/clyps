import { avgEnergy, segmentEnergyScore } from './energy.js';
import { refine } from './select.js';
import { LENGTH_RANGES, type JobOptions, type Selection, type Word } from './types.js';
import { suggestHashtags } from './trends.js';

type Sentence = { start: number; end: number; text: string; words: number };

/** Frases a partir das palavras: quebra em pontuação final ou pausa longa. */
function sentences(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) {
      out.push({
        start: cur[0].start,
        end: cur[cur.length - 1].end,
        text: cur.map((w) => w.word.trim()).join(' ').replace(/\s+([,.!?…])/g, '$1'),
        words: cur.length,
      });
    }
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 0.9 || cur.length >= 60)) flush();
    cur.push(w);
    if (/[.!?…]["”']?$/.test(w.word.trim())) flush();
  }
  flush();
  return out;
}

// Palavras de gancho comuns no início de cortes que prendem (pt/en/es).
const HOOK = /^(por que|porque|como|o que|quem|quando|sabe|olha|gente|cara|imagina|nunca|ninguém|todo mundo|a verdade|o segredo|o maior|o erro|why|how|what|nobody|never|the truth|the secret|por qué|cómo|qué|nadie|nunca|la verdad)\b/i;

function hookBonus(s: Sentence): number {
  let b = 0;
  if (/\?$/.test(s.text)) b += 8; // pergunta
  if (/!$/.test(s.text)) b += 6; // exclamação
  if (HOOK.test(s.text)) b += 8;
  if (/\d/.test(s.text)) b += 4; // número concreto
  return b;
}

const cut = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…`);

/**
 * Escolhe os trechos sem IA de texto: começa sempre no início de uma frase, termina no fim de uma frase,
 * respeita a duração pedida e dá preferência a energia alta (com peso no gancho), fala acelerada e
 * aberturas fortes (pergunta, exclamação, número, palavras de gancho).
 */
export function heuristicSelect(words: Word[], opts: JobOptions, videoDuration: number, norm: number[]): Selection[] {
  const sents = sentences(words);
  const [min, max] = LENGTH_RANGES[opts.clipLength];
  const rates = sents.map((s) => s.words / Math.max(0.5, s.end - s.start));
  const avgRate = rates.reduce((a, b) => a + b, 0) / Math.max(1, rates.length);

  const candidates: Selection[] = [];
  for (let i = 0; i < sents.length; i++) {
    const first = sents[i];
    // Evita começar em frase solta de uma palavra ("É.", "Então.").
    if (first.words < 3) continue;
    for (let j = i; j < sents.length; j++) {
      const len = sents[j].end - first.start;
      if (len > max) break;
      if (len < min) continue;
      const slice = sents.slice(i, j + 1);
      const wordsIn = slice.reduce((a, s) => a + s.words, 0);
      const rate = wordsIn / Math.max(1, len);
      const energy = segmentEnergyScore(norm, first.start, sents[j].end);
      const paceBonus = Math.max(-10, Math.min(10, ((rate - avgRate) / Math.max(0.5, avgRate)) * 20));
      const endsClean = /[.!?…]$/.test(sents[j].text) ? 4 : 0;
      const score = Math.round(Math.max(0, Math.min(100, energy * 0.75 + hookBonus(first) + paceBonus + endsClean)));
      candidates.push({
        start: first.start,
        end: sents[j].end,
        title: cut(first.text.replace(/[.!…]$/, ''), 70),
        reason: `Escolhido sem IA de texto: energia da fala ${energy}/100${hookBonus(first) ? ', abertura forte' : ''}.`,
        post: '',
        score,
      });
    }
  }

  // Pré-seleção gulosa sem sobreposição; o refine ajusta tempos, mede energia e limita a quantidade.
  const shortlist: Selection[] = [];
  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    if (shortlist.length >= opts.maxClips * 2) break;
    if (shortlist.every((k) => c.end <= k.start || c.start >= k.end)) shortlist.push(c);
  }

  return refine(shortlist, words, opts, videoDuration, norm).map((s) => {
    const opening = sents.filter((x) => x.start >= s.start - 0.2 && x.end <= s.end + 0.2).slice(0, 2);
    const text = cut(opening.map((x) => x.text).join(' '), 220);
    const tags =
      opts.language === 'en'
        ? '#shorts #reels #clips'
        : opts.language === 'es'
          ? '#shorts #reels #cortes'
          : [...suggestHashtags(text, 5).map((h) => h.tag), '#cortes'].join(' ');
    return { ...s, post: `${text}\n\n${tags}`, energy: s.energy ?? Math.round(100 * avgEnergy(norm, s.start, s.end)) };
  });
}
