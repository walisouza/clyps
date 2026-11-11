import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import PostCaptionModal from '../components/PostCaptionModal';
import { api } from '../lib/api';
import { STAGE_LABEL, STATUS_LABEL, formatDuration, type Clip, type Job } from '../lib/types';

/** Para clipes antigos, gerados antes da legenda automática. */
function fallbackCaption(c: Clip): string {
  return `${c.title}\n\n#cortes #shorts #reels`;
}

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [modal, setModal] = useState<{ clip: Clip; downloading: boolean } | null>(null);

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
        if (data.job.status === 'queued' || data.job.status === 'processing') timer = setTimeout(tick, 3000);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Erro ao carregar.');
      }
    }
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);

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
          <Link to="/" className="link">
            Tentar com outro vídeo
          </Link>
        </section>
      )}

      {clips.length > 0 && (
        <div className="clip-grid">
          {clips.map((c) => (
            <article key={c.id} className="card clip">
              <video src={api.clipUrl(c.id)} controls preload="metadata" playsInline />
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
                {c.reason && <p className="muted small">{c.reason}</p>}
                {c.transcript && (
                  <details>
                    <summary>Transcrição</summary>
                    <p className="small">{c.transcript}</p>
                  </details>
                )}
                <div className="clip-actions">
                  <a
                    className="primary"
                    href={api.clipUrl(c.id, true)}
                    onClick={() => setModal({ clip: c, downloading: true })}
                  >
                    Baixar MP4
                  </a>
                  <button type="button" className="link small" onClick={() => setModal({ clip: c, downloading: false })}>
                    Legenda do post
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
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
