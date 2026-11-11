import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatDuration, type VideoPreview } from '../lib/types';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: VideoPreview }
  | { kind: 'error'; message: string };

const looksLikeUrl = (u: string) => /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(u);

/** Busca título, miniatura e duração do link (com atraso curto enquanto a pessoa digita). */
export default function LinkPreview({ url, onTooLong }: { url: string; onTooLong: (tooLong: boolean) => void }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [thumbFailed, setThumbFailed] = useState(false);

  useEffect(() => {
    const u = url.trim();
    setThumbFailed(false);
    onTooLong(false);
    if (!looksLikeUrl(u)) {
      setState({ kind: 'idle' });
      return;
    }
    let alive = true;
    setState({ kind: 'loading' });
    const timer = setTimeout(() => {
      api
        .preview(u)
        .then((data) => {
          if (!alive) return;
          setState({ kind: 'ready', data });
          onTooLong(data.tooLong);
        })
        .catch((err) => alive && setState({ kind: 'error', message: err instanceof Error ? err.message : 'Erro.' }));
    }, 700);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // onTooLong é estável o suficiente para este uso; só a URL dispara nova busca.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (state.kind === 'idle') return null;
  if (state.kind === 'loading') {
    return (
      <div className="preview preview-loading" aria-live="polite">
        <div className="preview-thumb skeleton" />
        <span className="muted small">Buscando o vídeo…</span>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <p className="preview-error small" role="alert">
        {state.message}
      </p>
    );
  }

  const d = state.data;
  return (
    <div className="preview" aria-live="polite">
      {d.thumbnail && !thumbFailed ? (
        <img
          className="preview-thumb"
          src={d.thumbnail}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setThumbFailed(true)}
        />
      ) : (
        <div className="preview-thumb preview-thumb-empty muted small">sem miniatura</div>
      )}
      <div className="preview-body">
        <strong className="preview-title">{d.title}</strong>
        <span className="mono muted small">
          {[d.uploader, d.duration ? formatDuration(d.duration) : null, d.site].filter(Boolean).join(' · ')}
        </span>
        {d.tooLong && <span className="error small">Passa do limite de duração. Recorte um trecho antes de enviar.</span>}
      </div>
    </div>
  );
}
