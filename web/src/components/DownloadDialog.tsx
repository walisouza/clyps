import { useEffect, useRef, useState } from 'react';
import { api, type Publication } from '../lib/api';
import type { Clip } from '../lib/types';

const LABELS: Record<string, string> = {
  queued: 'Agendado / na fila', processing: 'Preparando no Instagram', publishing: 'Publicando',
  published: 'Publicado', failed: 'Falhou', uncertain: 'Confira o Instagram', cancelled: 'Cancelado',
};

export default function DownloadDialog({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [caption, setCaption] = useState('');
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState('');
  const [available, setAvailable] = useState(false);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [scheduledAt, setScheduledAt] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); previous?.focus(); };
  }, []);

  useEffect(() => {
    let alive = true;
    api.caption(clip.id).then(result => {
      if (alive) { setCaption(result.caption); setSource(result.source); }
    }).catch(e => { if (alive) { setError(e.message); setCaption(clip.transcript?.slice(0, 280) ?? ''); } })
      .finally(() => { if (alive) setLoading(false); });
    api.metaStatus().then(result => { if (alive) setAvailable(result.available); }).catch(() => {});
    const refresh = () => api.publications(clip.id).then(result => { if (alive) setPublications(result.publications); }).catch(() => {});
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => { alive = false; clearInterval(timer); };
  }, [clip.id, clip.transcript]);

  async function copy() {
    try { await navigator.clipboard.writeText(caption); setMessage('Legenda copiada!'); }
    catch { setError('Não foi possível copiar automaticamente. Selecione o texto e copie.'); }
  }
  async function publish() {
    setBusy(true); setError(''); setMessage('');
    try {
      const when = scheduledAt ? new Date(scheduledAt).toISOString() : undefined;
      await api.publish(clip.id, caption, when);
      setPublications((await api.publications(clip.id)).publications);
      setMessage(when ? 'Publicação agendada. O servidor precisa permanecer ligado.' : 'Envio para o Instagram entrou na fila.');
      setConfirmPublish(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Falha ao enviar.'); }
    finally { setBusy(false); }
  }
  async function cancel(id: string) {
    setBusy(true); setError('');
    try { await api.cancelPublication(id); setPublications((await api.publications(clip.id)).publications); }
    catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível cancelar.'); }
    finally { setBusy(false); }
  }
  const pending = publications.some(p => ['queued', 'processing', 'publishing', 'uncertain'].includes(p.status));
  return (
    <dialog ref={dialog} className="download-dialog" aria-labelledby="download-title" onCancel={onClose}>
      <div className="stack">
        <div className="row dialog-head"><h2 id="download-title">Seu clipe, pronto para postar</h2><button type="button" onClick={onClose} aria-label="Fechar">×</button></div>
        <p className="muted small">{clip.title}</p>
        <a className="primary" href={api.clipUrl(clip.id, true)}>Baixar MP4</a>
        <label className="field">Legenda do post
          <textarea rows={5} maxLength={2200} value={caption} disabled={loading || busy} onChange={e => { setCaption(e.target.value); setConfirmPublish(false); }} placeholder={loading ? 'Preparando uma sugestão…' : 'Escreva sua legenda'} />
        </label>
        <p className="muted small">{loading ? 'O download já está disponível enquanto preparamos o texto.' : source === 'ai' ? 'Sugestão baseada na fala do clipe. Revise e ajuste antes de postar.' : 'Trecho da transcrição para você adaptar; o resumo automático não está disponível.'}</p>
        <button type="button" onClick={copy} disabled={loading || !caption}>Copiar legenda</button>
        {available ? <section className="stack">
          <h3>Publicar no Instagram</h3>
          <label className="field">Agendar (opcional)
            <input type="datetime-local" value={scheduledAt} disabled={busy || pending} onChange={e => { setScheduledAt(e.target.value); setConfirmPublish(false); }} />
            <small className="muted">Horário local: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Sem data, o envio começa agora.</small>
          </label>
          {confirmPublish ? <div className="stack">
            <p>Publicar este vídeo e a legenda acima na conta Instagram conectada{scheduledAt ? ` em ${new Date(scheduledAt).toLocaleString()}` : ' agora'}?</p>
            <div className="row"><button type="button" className="primary" disabled={busy || pending} onClick={publish}>{busy ? 'Enviando…' : 'Confirmar publicação'}</button><button type="button" disabled={busy} onClick={() => setConfirmPublish(false)}>Voltar</button></div>
          </div> : <button type="button" className="primary" disabled={loading || busy || pending} onClick={() => setConfirmPublish(true)}>{scheduledAt ? 'Agendar Reel' : 'Publicar Reel'}</button>}
        </section> : <p className="muted small">Publicação direta disponível após configurar a integração Instagram da sua conta no servidor.</p>}
        {publications.length > 0 && <ul className="publication-list">{publications.map(p => <li key={p.id}>
          <strong>{LABELS[p.status] ?? p.status}</strong> · {new Date(p.scheduled_at).toLocaleString()}
          {p.error && <p className="error small">{p.error}</p>}
          {p.status === 'queued' && <button type="button" disabled={busy} onClick={() => cancel(p.id)}>Cancelar agendamento</button>}
        </li>)}</ul>}
        <div aria-live="polite">{message && <p>{message}</p>}{error && <p className="error">{error}</p>}</div>
      </div>
    </dialog>
  );
}
