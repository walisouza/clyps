import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { MetaStatus } from '../lib/types';

/** Conexão com o Facebook/Instagram, na página Conta. */
export default function MetaCard() {
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    // Volta do Facebook: /conta?meta=ok&n=2 ou ?meta=erro&msg=...
    const q = new URLSearchParams(window.location.search);
    if (q.get('meta') === 'ok') setNotice({ ok: true, text: `Conectado. ${q.get('n') ?? ''} Página(s) liberada(s).` });
    if (q.get('meta') === 'erro') setNotice({ ok: false, text: q.get('msg') || 'A conexão falhou.' });
    if (q.get('meta')) window.history.replaceState(null, '', window.location.pathname);
    api.meta.status().then(setStatus).catch((e) => setError(e instanceof Error ? e.message : 'Erro ao carregar.'));
  }, []);

  async function disconnect() {
    await api.meta.disconnect();
    setConfirm(false);
    setStatus(await api.meta.status());
    setNotice({ ok: true, text: 'Desconectado. Os agendamentos pendentes foram cancelados.' });
  }

  return (
    <section className="card">
      <h2>Instagram e Facebook</h2>
      {error && <p className="error">{error}</p>}
      {notice && <p className={notice.ok ? 'ok' : 'error'}>{notice.text}</p>}
      {status && !status.configured && (
        <p className="muted small">
          A integração com a Meta não está configurada no servidor. Na VPS, rode <code>./scripts/meta.sh</code> com o App ID e o
          App Secret do seu app em developers.facebook.com.
        </p>
      )}
      {status?.configured && (
        <>
          {status.accounts.length === 0 ? (
            <p className="muted small">
              Conecte para publicar e agendar os clipes nos Reels do Instagram e da sua Página do Facebook. O Instagram precisa ser
              uma conta profissional (Criador ou Empresa) ligada a uma Página.
            </p>
          ) : (
            <ul className="meta-list">
              {status.accounts.map((a) => (
                <li key={a.pageId}>
                  <span className="meta-net fb">f</span>
                  <span>{a.pageName}</span>
                  {a.instagram ? (
                    <>
                      <span className="meta-net ig">ig</span>
                      <span>@{a.instagram.username}</span>
                    </>
                  ) : (
                    <span className="muted small">sem Instagram ligado</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            <a className="primary" href={api.meta.connectUrl}>
              {status.accounts.length ? 'Reconectar / mudar Páginas' : 'Conectar com o Facebook'}
            </a>
            {status.accounts.length > 0 &&
              (confirm ? (
                <>
                  <span className="small">Desconectar e cancelar os agendamentos?</span>
                  <button type="button" className="link error" onClick={disconnect}>
                    Sim
                  </button>
                  <button type="button" className="link" onClick={() => setConfirm(false)}>
                    Não
                  </button>
                </>
              ) : (
                <button type="button" className="link" onClick={() => setConfirm(true)}>
                  Desconectar
                </button>
              ))}
          </div>
          <p className="muted small">
            Endereço de retorno para cadastrar no app da Meta: <code>{status.callbackUrl}</code>
          </p>
          <p className="muted small">
            Páginas públicas para o app: <a href="/privacidade">Privacidade</a> · <a href="/termos">Termos</a> ·{' '}
            <a href="/exclusao-de-dados">Exclusão de dados</a>
          </p>
        </>
      )}
    </section>
  );
}
