import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { STAGE_LABEL, STATUS_LABEL, formatDuration, type Clip, type Job } from '../lib/types';

type ClipWithUrls = Clip & { playUrl: string | null; downloadUrl: string | null };

const slug = (t: string) =>
  t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60) || 'clipe';

async function loadClips(jobId: string): Promise<ClipWithUrls[]> {
  const { data, error } = await supabase.from('clips').select('*').eq('job_id', jobId).order('idx');
  if (error) throw new Error(error.message);
  const clips = data as Clip[];
  const bucket = supabase.storage.from('clips');
  return Promise.all(
    clips.map(async (c) => {
      const [play, download] = await Promise.all([
        bucket.createSignedUrl(c.storage_key, 3600),
        bucket.createSignedUrl(c.storage_key, 3600, { download: `${slug(c.title)}.mp4` }),
      ]);
      return { ...c, playUrl: play.data?.signedUrl ?? null, downloadUrl: download.data?.signedUrl ?? null };
    }),
  );
}

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [clips, setClips] = useState<ClipWithUrls[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      const { data, error: e } = await supabase.from('jobs').select('*').eq('id', id).maybeSingle();
      if (!alive) return;
      if (e) return setError(e.message);
      if (!data) return setError('Corte não encontrado.');
      const j = data as Job;
      setJob(j);
      if (j.status === 'completed') {
        loadClips(j.id)
          .then((c) => alive && setClips(c))
          .catch((err) => alive && setError(err.message));
      } else if (j.status === 'queued' || j.status === 'processing') {
        timer = setTimeout(tick, 3000);
      }
    }
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);

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

      {job.status === 'failed' && (
        <section className="card">
          <p className="error">{job.error || 'O processamento falhou.'}</p>
          <Link to="/" className="link">
            Tentar com outro vídeo
          </Link>
        </section>
      )}

      {job.status === 'completed' && clips === null && <p className="muted">Carregando clipes…</p>}

      {clips && (
        <div className="clip-grid">
          {clips.map((c) => (
            <article key={c.id} className="card clip">
              {c.playUrl ? (
                <video src={c.playUrl} controls preload="metadata" playsInline />
              ) : (
                <div className="video-missing muted">Arquivo indisponível</div>
              )}
              <div className="clip-body">
                <div className="clip-meta mono">
                  <span className="score">{c.score ?? '—'}</span>
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
                {c.downloadUrl && (
                  <a className="primary" href={c.downloadUrl}>
                    Baixar MP4
                  </a>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
