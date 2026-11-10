import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

type Status = { hasCookies: boolean; uploadedAt?: string; size?: number };

/** Painel que envia e remove o cookies.txt do yt-dlp (opcional, para links privados/logados). */
export default function CookiesPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.cookies.status().then(setStatus).catch(() => setStatus({ hasCookies: false }));
  }, []);

  async function send(file: File) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.cookies.upload(file));
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao enviar.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.cookies.remove();
      setStatus({ hasCookies: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao remover.');
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  const date = status.uploadedAt ? new Date(status.uploadedAt).toLocaleDateString('pt-BR') : null;

  return (
    <div className="cookies-panel">
      <div className="cookies-row">
        <span className="mono muted small">
          Cookies do navegador:{' '}
          {status.hasCookies ? <>ativos desde {date}</> : <>não enviados</>}
        </span>
        {status.hasCookies ? (
          <>
            <button type="button" className="link small" onClick={() => setOpen((v) => !v)} disabled={busy}>
              Trocar
            </button>
            <button type="button" className="link small error" onClick={remove} disabled={busy}>
              Remover
            </button>
          </>
        ) : (
          <button type="button" className="link small" onClick={() => setOpen((v) => !v)} disabled={busy}>
            Enviar cookies
          </button>
        )}
      </div>

      {open && (
        <div className="cookies-help small">
          <p className="muted">
            Permite baixar vídeos privados ou que exigem login (Facebook, Instagram, YouTube…). Exporte o{' '}
            <code>cookies.txt</code> do seu navegador com uma extensão como{' '}
            <em>Get cookies.txt LOCALLY</em> estando logado no site, e envie aqui.
          </p>
          <input
            ref={inputRef}
            type="file"
            accept=".txt,text/plain"
            onChange={(e) => e.target.files?.[0] && send(e.target.files[0])}
            disabled={busy}
          />
          {busy && <p className="muted">Enviando…</p>}
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </div>
  );
}
