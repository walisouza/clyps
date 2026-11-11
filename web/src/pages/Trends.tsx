import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { TrendsData } from '../lib/types';

function ago(iso: string | null): string {
  if (!iso) return '';
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `há ${h} h` : `há ${Math.round(h / 24)} d`;
}

function CopyTag({ tag }: { tag: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className={`tag-chip${ok ? ' on' : ''}`}
      onClick={async () => {
        await navigator.clipboard?.writeText(tag).catch(() => {});
        setOk(true);
        setTimeout(() => setOk(false), 1500);
      }}
      title="Copiar hashtag"
    >
      {ok ? 'copiada' : tag}
    </button>
  );
}

export default function Trends() {
  const [data, setData] = useState<TrendsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(refresh = false) {
    setLoading(true);
    setError(null);
    try {
      setData(await api.trends(refresh));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const rising = data?.nicheQueries.filter((q) => q.kind === 'rising') ?? [];
  const top = data?.nicheQueries.filter((q) => q.kind === 'top') ?? [];

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Em alta</h1>
        <p className="muted">
          Trend Scanner: o que está sendo buscado no Google agora, com foco em {data?.niche.name.toLowerCase() ?? 'gospel e igreja'}. As
          hashtags daqui aparecem como sugestão na legenda de cada clipe.
        </p>
        <div className="row">
          <button type="button" className="chip strong" onClick={() => load(true)} disabled={loading}>
            {loading ? 'Atualizando…' : 'Atualizar'}
          </button>
          {data && <span className="muted small mono">Google Trends · {data.geo} · lido {ago(data.trendingAt)}</span>}
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Lendo o Google Trends…</p>}

      {data && (
        <>
          <section className="card">
            <h2>Subindo no nicho</h2>
            <p className="muted small">
              Buscas que mais cresceram nos últimos 7 dias junto com: {data.niche.seeds.join(', ')}.
              {data.nicheAt && ` Lido ${ago(data.nicheAt)}.`}
            </p>
            {data.nicheError && <p className="notice-box small">{data.nicheError}</p>}
            {rising.length === 0 && !data.nicheError && <p className="muted small">Nada subindo agora.</p>}
            {rising.length > 0 && (
              <ul className="trend-queries">
                {rising.map((q) => (
                  <li key={`${q.seed}-${q.query}`}>
                    <span className="trend-q">{q.query}</span>
                    <span className="badge processing mono">{q.value === 'Aumento repentino' || /breakout/i.test(q.value) ? 'explodindo' : q.value}</span>
                    <CopyTag tag={q.hashtag} />
                  </li>
                ))}
              </ul>
            )}
            {top.length > 0 && (
              <details>
                <summary>Mais buscadas no nicho</summary>
                <ul className="trend-queries">
                  {top.map((q) => (
                    <li key={`${q.seed}-${q.query}`}>
                      <span className="trend-q">{q.query}</span>
                      <CopyTag tag={q.hashtag} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="stack">
            <h2>Em alta no Brasil agora</h2>
            {data.trendingError && <p className="notice-box small">{data.trendingError}</p>}
            <div className="trend-grid">
              {data.trending.map((t) => (
                <article key={t.title} className={`card trend${t.niche ? ' niche' : ''}`}>
                  {t.picture && (
                    <img src={t.picture} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />
                  )}
                  <div className="trend-body">
                    <div className="row">
                      {t.niche && <span className="badge completed">{data.niche.name.split(' ')[0].toLowerCase()}</span>}
                      <span className="mono small muted">
                        {t.traffic} buscas{t.startedAt ? ` · ${ago(t.startedAt)}` : ''}
                      </span>
                    </div>
                    <h3>{t.title}</h3>
                    {t.news[0] && (
                      <a className="small link" href={t.news[0].url} target="_blank" rel="noreferrer">
                        {t.news[0].title} · {t.news[0].source}
                      </a>
                    )}
                    <CopyTag tag={t.hashtag} />
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
