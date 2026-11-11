import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, type User } from './lib/api';
import type { Features } from './lib/types';
import AccountPage from './pages/Account';
import ClipEditor from './pages/ClipEditor';
import History from './pages/History';
import JobDetail from './pages/JobDetail';
import Login from './pages/Login';
import NewClip from './pages/NewClip';
import Trends from './pages/Trends';

export function Logo() {
  return (
    <span className="logo" aria-label="Clyps">
      Cl<span className="logo-cut">y</span>ps
    </span>
  );
}

type Session = { user: User | null; signupOpen: boolean; mock?: boolean; features?: Features };

export default function App() {
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.me().then(setSession).catch(() => setError(true));
  }, []);

  if (error) return <main className="center-screen error">Não foi possível falar com o servidor.</main>;
  if (!session) return <main className="center-screen muted">Carregando…</main>;
  if (!session.user) {
    return <Login signupOpen={session.signupOpen} onAuth={(user) => setSession({ ...session, user, signupOpen: false })} />;
  }

  const user = session.user;
  async function logout() {
    await api.logout().catch(() => {});
    setSession({ ...session, user: null, signupOpen: false });
  }

  return (
    <div className="shell">
      <header className="topbar">
        <Logo />
        <nav>
          <NavLink to="/" end>
            Novo corte
          </NavLink>
          <NavLink to="/historico">Histórico</NavLink>
          <NavLink to="/em-alta">Em alta</NavLink>
          <NavLink to="/conta">Conta</NavLink>
        </nav>
        <div className="account">
          <span className="muted mono">{user.email}</span>
          <button className="link" onClick={logout}>
            Sair
          </button>
        </div>
      </header>
      {session.mock && (
        <div className="mock-banner" role="status">
          <strong>Modo de teste.</strong> A transcrição e a escolha dos trechos são simuladas, por isso a legenda mostra
          sempre a mesma frase. Para cortes reais, configure as chaves de IA no <code>.env</code> da VPS e remova{' '}
          <code>MOCK_AI=1</code>.
        </div>
      )}
      {!session.mock && session.features && !session.features.transcription && (
        <div className="mock-banner" role="alert">
          <strong>Transcrição não configurada.</strong> O servidor não encontrou o Speaches nem uma chave de transcrição; os cortes vão falhar até isso ser configurado e o
          app reiniciado.
        </div>
      )}
      <main className="page">
        <Routes>
          <Route path="/" element={<NewClip features={session.features} />} />
          <Route path="/historico" element={<History />} />
          <Route path="/em-alta" element={<Trends />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="/clips/:id/editar" element={<ClipEditor />} />
          <Route path="/conta" element={<AccountPage user={user} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
