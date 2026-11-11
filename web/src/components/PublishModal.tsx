import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { Clip, MetaStatus, Network } from '../lib/types';
import HashtagChips from './HashtagChips';
import Segmented from './Segmented';

const pad = (n: number) => String(n).padStart(2, '0');
/** Valor para <input type="datetime-local"> no fuso do navegador. */
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function nextHour(): Date {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return d;
}

type Target = { network: Network; pageId: string; label: string };

/** Publicar agora ou agendar o clipe no Instagram e/ou no Facebook. */
export default function PublishModal({ clip, caption, onClose, onDone }: { clip: Clip; caption: string; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [text, setText] = useState(caption);
  const [mode, setMode] = useState<'now' | 'later'>('now');
  const [when, setWhen] = useState(localInput(nextHour()));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.meta
      .status()
      .then((s) => {
        setStatus(s);
        setSelected(new Set(targetsOf(s).map(keyOf)));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Erro ao carregar as contas.'));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const targets = status ? targetsOf(status) : [];
  const seconds = (clip.end_ms - clip.start_ms) / 1000;
  const fbAsVideo = clip.aspect !== '9:16' || seconds < 3 || seconds > 90;

  function toggle(k: string) {
    const next = new Set(selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setSelected(next);
  }

  async function submit() {
    setError(null);
    const chosen = targets.filter((t) => selected.has(keyOf(t)));
    if (!chosen.length) return setError('Escolha pelo menos uma conta.');
    let scheduledAt: string | undefined;
    if (mode === 'later') {
      const d = new Date(when);
      if (Number.isNaN(d.getTime())) return setError('Escolha a data e a hora.');
      if (d.getTime() < Date.now()) return setError('Esse horário já passou.');
      scheduledAt = d.toISOString();
    }
    setBusy(true);
    try {
      await api.meta.publish(clip.id, { targets: chosen.map(({ network, pageId }) => ({ network, pageId })), caption: text, scheduledAt });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível publicar.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="publish-title">
        <div className="modal-head">
          <h2 id="publish-title">Publicar “{clip.title}”</h2>
          <button type="button" className="link" onClick={onClose} aria-label="Fechar">
            Fechar
          </button>
        </div>

        {!status && !error && <p className="muted">Carregando as contas…</p>}
        {status && (!status.configured || targets.length === 0) && (
          <p className="small">
            {status.configured ? 'Nenhuma conta conectada ainda.' : 'A integração com a Meta não está configurada no servidor.'}{' '}
            <Link to="/conta" className="link">
              Ir para Conta
            </Link>
          </p>
        )}

        {targets.length > 0 && (
          <>
            <fieldset className="field">
              <legend>Onde</legend>
              <div className="target-list">
                {targets.map((t) => (
                  <label key={keyOf(t)} className={`target${selected.has(keyOf(t)) ? ' on' : ''}`}>
                    <input type="checkbox" checked={selected.has(keyOf(t))} onChange={() => toggle(keyOf(t))} />
                    <span className={`meta-net ${t.network === 'instagram' ? 'ig' : 'fb'}`}>{t.network === 'instagram' ? 'ig' : 'f'}</span>
                    {t.label}
                  </label>
                ))}
              </div>
              {fbAsVideo && targets.some((t) => t.network === 'facebook') && (
                <p className="muted small">No Facebook este clipe sai como vídeo da Página (Reels lá só em 9:16 e até 90 s).</p>
              )}
            </fieldset>

            <label className="field">
              Legenda
              <textarea rows={6} value={text} maxLength={2200} onChange={(e) => setText(e.target.value)} />
            </label>
            <HashtagChips clipId={clip.id} text={text} onChange={setText} />

            <Segmented
              label="Quando"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'now', label: 'Agora' },
                { value: 'later', label: 'Agendar' },
              ]}
            />
            {mode === 'later' && (
              <label className="field">
                Data e hora
                <input type="datetime-local" value={when} min={localInput(new Date())} onChange={(e) => setWhen(e.target.value)} />
              </label>
            )}
          </>
        )}

        {error && <p className="error">{error}</p>}
        {targets.length > 0 && (
          <div className="row">
            <button type="button" className="primary" onClick={submit} disabled={busy || clip.rerendering}>
              {busy ? 'Enviando…' : mode === 'now' ? 'Publicar agora' : 'Agendar'}
            </button>
            <span className="muted small">{text.length} / 2200</span>
          </div>
        )}
      </div>
    </div>
  );
}

const keyOf = (t: { network: Network; pageId: string }) => `${t.network}:${t.pageId}`;

function targetsOf(s: MetaStatus): Target[] {
  const out: Target[] = [];
  for (const a of s.accounts) {
    if (a.instagram) out.push({ network: 'instagram', pageId: a.pageId, label: `Instagram · @${a.instagram.username ?? a.pageName}` });
  }
  for (const a of s.accounts) out.push({ network: 'facebook', pageId: a.pageId, label: `Facebook · ${a.pageName}` });
  return out;
}
