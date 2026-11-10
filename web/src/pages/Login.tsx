import { useState, type FormEvent } from 'react';
import { Logo } from '../App';
import { api, type User } from '../lib/api';

export default function Login({ signupOpen, onAuth }: { signupOpen: boolean; onAuth: (user: User) => void }) {
  const [mode, setMode] = useState<'in' | 'up'>(signupOpen ? 'up' : 'in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = mode === 'in' ? await api.login(email, password) : await api.signup(email, password);
      onAuth(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Algo deu errado.');
      setBusy(false);
    }
  }

  return (
    <main className="center-screen">
      <form className="card auth" onSubmit={submit}>
        <Logo />
        <p className="muted">
          {mode === 'up'
            ? 'Crie a conta de administrador para começar.'
            : 'Vídeos longos viram cortes prontos para postar.'}
        </p>
        <label>
          E-mail
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Senha
          <input
            type="password"
            required
            minLength={8}
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Aguarde…' : mode === 'in' ? 'Entrar' : 'Criar conta'}
        </button>
        {signupOpen && (
          <button type="button" className="link" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
            {mode === 'in' ? 'Criar uma conta' : 'Já tenho conta'}
          </button>
        )}
      </form>
    </main>
  );
}
