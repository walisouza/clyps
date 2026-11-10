import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { configured, supabase } from './lib/supabase';
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

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    if (!configured) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!configured) {
    return (
      <main className="center-screen">
        <Logo />
        <p className="notice">
          Falta configurar o Supabase. Copie <code>web/.env.example</code> para <code>web/.env</code> e preencha{' '}
          <code>VITE_SUPABASE_URL</code> e <code>VITE_SUPABASE_ANON_KEY</code>.
        </p>
      </main>
    );
  }
  if (session === undefined) return <main className="center-screen muted">Carregando…</main>;
  if (!session) return <Login />;

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
          <span className="muted mono">{session.user.email}</span>
          <button className="link" onClick={() => supabase.auth.signOut()}>
            Sair
          </button>
        </div>
      </header>
      <main className="page">
        <Routes>
          <Route path="/" element={<NewClip userId={session.user.id} />} />
          <Route path="/historico" element={<History />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
