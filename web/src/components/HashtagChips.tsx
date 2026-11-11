import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { HashtagSuggestion } from '../lib/types';

const LABEL: Record<HashtagSuggestion['reason'], string> = { 'em alta': 'em alta', 'nicho em alta': 'subindo no nicho', nicho: 'nicho' };

/** Hashtags sugeridas pelo Trend Scanner; um toque acrescenta (ou tira) a hashtag do texto. */
export default function HashtagChips({ clipId, text, onChange }: { clipId: string; text: string; onChange: (t: string) => void }) {
  const [tags, setTags] = useState<HashtagSuggestion[] | null>(null);

  useEffect(() => {
    api
      .hashtags(clipId)
      .then((r) => setTags(r.hashtags))
      .catch(() => setTags([]));
  }, [clipId]);

  if (!tags?.length) return null;
  const present = (t: string) => new RegExp(`(^|\\s)${t}(?=\\s|$)`, 'i').test(text);

  function toggle(t: string) {
    if (present(t)) {
      onChange(text.replace(new RegExp(`(^|\\s)${t}(?=\\s|$)`, 'i'), '').replace(/[ \t]{2,}/g, ' ').trimEnd());
    } else {
      const trimmed = text.trimEnd();
      onChange(/#[\p{L}\p{N}_]+$/u.test(trimmed) ? `${trimmed} ${t}` : `${trimmed}\n\n${t}`);
    }
  }

  return (
    <div className="hashtag-chips">
      <span className="muted small">Hashtags do Trend Scanner</span>
      <div className="chips-row">
        {tags.map((t) => (
          <button
            key={t.tag}
            type="button"
            className={`tag-chip ${t.reason === 'nicho' ? '' : 'hot'}${present(t.tag) ? ' on' : ''}`}
            title={LABEL[t.reason]}
            onClick={() => toggle(t.tag)}
          >
            {t.reason !== 'nicho' && <span aria-hidden>↑</span>}
            {t.tag}
          </button>
        ))}
      </div>
    </div>
  );
}
