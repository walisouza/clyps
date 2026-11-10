import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { STATUS_LABEL, formatDuration, type Job } from '../lib/types';

export default function History() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data, error: e }) => {
        if (e) setError(e.message);
        else setJobs(data as Job[]);
      });
  }, []);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Histórico</h1>
      </div>
      {error && <p className="error">{error}</p>}
      {jobs === null && !error && <p className="muted">Carregando…</p>}
      {jobs?.length === 0 && (
        <p className="card muted">
          Nenhum corte ainda. <Link to="/">Criar o primeiro</Link>.
        </p>
      )}
      {jobs && jobs.length > 0 && (
        <ul className="job-list">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link to={`/jobs/${j.id}`} className="job-row">
                <span className="job-title">{j.title || j.source_url || 'Vídeo enviado'}</span>
                <span className="mono muted">
                  {j.duration_seconds ? formatDuration(Number(j.duration_seconds)) : '—'}
                </span>
                <span className="mono muted">{new Date(j.created_at).toLocaleDateString('pt-BR')}</span>
                <span className={`badge ${j.status}`}>{STATUS_LABEL[j.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
