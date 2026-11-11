import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import PostCaptionModal from '../components/PostCaptionModal';
import PublishModal from '../components/PublishModal';
import { api } from '../lib/api';
import { STAGE_LABEL, STATUS_LABEL, formatDuration, type Clip, type Job, type Post } from '../lib/types';

/** Para clipes antigos, gerados antes da legenda automática. */
const POST_STATUS: Record<Post['status'], string> = {
  scheduled: 'Agendado',
  publishing: 'Publicando…',
  published: 'Publicado',
  failed: 'Falhou',
  cancelled: 'Cancelado',
};

function PostRow({ p, onChange }: { p: Post; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Falhou.');
    } finally {
      setBusy(false);
    }
  }
  const when = new Date(p.publishedAt ?? p.scheduledAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  return (
    <li className={`post-row ${p.status}`}>
      <span className={`meta-net ${p.network === 'instagram' ? 'ig' : 'fb'}`}>{p.network === 'instagram' ? 'ig' : 'f'}</span>
      <span>
        <strong>{POST_STATUS[p.status]}</strong> {p.account && <span>{p.account}</span>} <span className="muted">{when}</span>
      </span>
      {p.permalink && (
        <a className="link" href={p.permalink} target="_blank" rel="noreferrer">
          Ver
        </a>
      )}
      {p.status === 'scheduled' && (
        <button type="button" className="link" disabled={busy} onClick={() => act(() => api.meta.cancel(p.id))}>
          Cancelar
        </button>
      )}
      {p.status === 'failed' && (
        <button type="button" className="link" disabled={busy} onClick={() => act(() => api.meta.retry(p.id))}>
          Tentar de novo
        </button>
      )}
      {(p.error || err) && p.status !== 'cancelled' && <span className="error small post-error">{err || p.error}</span>}
    </li>
  );
}

function fallbackCaption(c: Clip): string {
  return `${c.title}\n\n#cortes #shorts #reels`;
}

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [publishing, setPublishing] = useState<Clip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [modal, setModal] = useState<{ clip: Clip; downloading: boolean } | null>(null);
  // Muda a cada nova tentativa, para reiniciar o acompanhamento do progresso.
  const [reload, setReload] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      try {
        const data = await api.getJob(id!);
        if (!alive) return;
        setJob(data.job);
        setClips(data.clips);
        setPosts(data.posts ?? []);
        // Também acompanha publicações em andamento ou que vencem nos próximos minutos.
        const soon = Date.now() + 3 * 60 * 1000;
        const posting = (data.posts ?? []).some(
          (p) => p.status === 'publishing' || (p.status === 'scheduled' && new Date(p.scheduledAt).getTime() < soon),
        );
        const busy = data.job.status === 'queued' || data.job.status === 'processing' || data.clips.some((c) => c.rerendering) || posting;
        if (busy) timer = setTimeout(tick, 3000);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Erro ao carregar.');
      }
    }
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, reload]);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      await api.retryJob(id!);
      setClips([]);
      setReload((n) => n + 1);
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : 'Não foi possível tentar de novo.');
    } finally {
      setRetrying(false);
    }
  }

  async function remove() {
    try {
      await api.deleteJob(id!);
      navigate('/historico');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível apagar.');
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!job) return <p className="muted">Carregando…</p>;

  const running = job.status === 'queued' || job.status === 'processing';

  return (
    <div className="stack">
      <div className="page-head">
        <Link to="/historico" className="link">
          ← Histórico
        </Link>
        <h1>{job.title || job.source_url || 'Vídeo enviado'}</h1>
        <p className="mono muted">
          <span className={`badge ${job.status}`}>{STATUS_LABEL[job.status]}</span>
          {job.duration_seconds ? ` · ${formatDuration(Number(job.duration_seconds))}` : ''}
          {` · ${new Date(job.created_at).toLocaleString('pt-BR')}`}
        </p>
      </div>

      {running && (
        <section className="card">
          <div className="progress-head">
            <span>{job.status === 'queued' ? 'Aguardando na fila' : STAGE_LABEL[job.stage ?? ''] ?? 'Processando'}</span>
            <span className="mono">{job.progress}%</span>
          </div>
          <div className="progress" role="progressbar" aria-valuenow={job.progress} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${job.progress}%` }} />
          </div>
          <p className="muted small">Pode fechar esta página; o processamento continua e o resultado fica no Histórico.</p>
        </section>
      )}

      {job.notice && (
        <p className="notice-box small" role="status">
          {job.notice}
        </p>
      )}

      {job.status === 'failed' && (
        <section className="card">
          <p className="error">{job.error || 'O processamento falhou.'}</p>
          {retryError && <p className="error small">{retryError}</p>}
          <div className="row">
            <button type="button" className="primary" onClick={retry} disabled={retrying}>
              {retrying ? 'Recolocando na fila…' : 'Tentar novamente'}
            </button>
            <Link to="/" className="link">
              Usar outro vídeo
            </Link>
          </div>
          <p className="muted small">Tenta de novo o mesmo vídeo, com as mesmas opções.</p>
        </section>
      )}

      {clips.length > 0 && (
        <div className="clip-grid">
          {clips.map((c) => (
            <article key={c.id} className="card clip">
              <div className="clip-video">
                <video src={api.clipUrl(c.id, false, c.version)} controls preload="metadata" playsInline />
                {c.rerendering && <div className="clip-updating">Atualizando o clipe…</div>}
              </div>
              <div className="clip-body">
                <div className="clip-meta mono">
                  <span className="score" title="Nota final (IA + energia)">{c.score ?? '—'}</span>
                  {c.energy !== null && (
                    <span className="energy" title="Energia do áudio no trecho">
                      ⚡ {c.energy}
                    </span>
                  )}
                  <span className="muted">
                    {formatDuration(c.start_ms / 1000)} → {formatDuration(c.end_ms / 1000)} ·{' '}
                    {Math.round((c.end_ms - c.start_ms) / 1000)}s
                  </span>
                </div>
                <h3>{c.title}</h3>
                {c.render_error && <p className="error small">{c.render_error}</p>}
                {c.reason && <p className="muted small">{c.reason}</p>}
                {c.transcript && (
                  <details>
                    <summary>Transcrição</summary>
                    <p className="small">{c.transcript}</p>
                  </details>
                )}
                <div className="clip-actions">
                  <a
                    className={`primary${c.rerendering ? ' disabled' : ''}`}
                    href={c.rerendering ? undefined : api.clipUrl(c.id, true, c.version)}
                    aria-disabled={c.rerendering}
                    onClick={() => !c.rerendering && setModal({ clip: c, downloading: true })}
                  >
                    Baixar MP4
                  </a>
                  {c.editable && !c.rerendering && (
                    <Link to={`/clips/${c.id}/editar`} className="link small">
                      Editar
                    </Link>
                  )}
                  <button type="button" className="link small" onClick={() => setModal({ clip: c, downloading: false })}>
                    Legenda do post
                  </button>
                  {!c.rerendering && (
                    <button type="button" className="chip strong" onClick={() => setPublishing(c)}>
                      Publicar
                    </button>
                  )}
                </div>
                {posts.some((p) => p.clipId === c.id && p.status !== 'cancelled') && (
                  <ul className="post-list">
                    {posts
                      .filter((p) => p.clipId === c.id && p.status !== 'cancelled')
                      .map((p) => (
                        <PostRow key={p.id} p={p} onChange={() => setReload((n) => n + 1)} />
                      ))}
                  </ul>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {publishing && (
        <PublishModal
          clip={publishing}
          caption={publishing.post_caption || fallbackCaption(publishing)}
          onClose={() => setPublishing(null)}
          onDone={() => {
            setPublishing(null);
            setReload((n) => n + 1);
          }}
        />
      )}

      {modal && (
        <PostCaptionModal
          title={modal.clip.title}
          caption={modal.clip.post_caption || fallbackCaption(modal.clip)}
          downloading={modal.downloading}
          onClose={() => setModal(null)}
        />
      )}

      {job.status !== 'processing' && (
        <div className="row">
          {confirmDelete ? (
            <>
              <span className="small">Apagar este corte e todos os clipes? Não dá para desfazer.</span>
              <button className="link error" onClick={remove}>
                Sim, apagar
              </button>
              <button className="link" onClick={() => setConfirmDelete(false)}>
                Cancelar
              </button>
            </>
          ) : (
            <button className="link muted" onClick={() => setConfirmDelete(true)}>
              Apagar este corte
            </button>
          )}
        </div>
      )}
    </div>
  );
}
