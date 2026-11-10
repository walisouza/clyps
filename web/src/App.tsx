import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, type User } from './lib/api';
import History from './pages/History';
import JobDetail from './pages/JobDetail';
import Login from './pages/Login';
import NewClip from './pages/NewClip';

export function Logo() {
  return (
    <span className="logo" aria-label="Clyps">
      Cl<span className="logo-cut">y</span>ps
    </span>
  );
}

type Session = { user: User | null; signupOpen: boolean };

export default function App() {
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.me().then(setSession).catch(() => setError(true));
  }, []);

  if (error) return <main className="center-screen error">Não foi possível falar com o servidor.</main>;
  if (!session) return <main className="center-screen muted">Carregando…</main>;
  if (!session.user) {
    return <Login signupOpen={session.signupOpen} onAuth={(user) => setSession({ user, signupOpen: false })} />;
  }

  const user = session.user;
  async function logout() {
    await api.logout().catch(() => {});
    setSession({ user: null, signupOpen: false });
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
        </nav>
        <div className="account">
          <span className="muted mono">{user.email}</span>
          <button className="link" onClick={logout}>
            Sair
          </button>
        </div>
      </header>
      <main className="page">
        <Routes>
          <Route path="/" element={<NewClip />} />
          <Route path="/historico" element={<History />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
