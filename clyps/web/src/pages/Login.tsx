import { useState, type FormEvent } from 'react';
import { Logo } from '../App';
import { supabase } from '../lib/supabase';

export default function Login() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const { data, error } =
      mode === 'in'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (error) {
      setMessage({ kind: 'error', text: mode === 'in' ? 'E-mail ou senha incorretos.' : error.message });
    } else if (mode === 'up' && !data.session) {
      setMessage({ kind: 'ok', text: 'Conta criada. Confirme pelo link que enviamos para o seu e-mail.' });
    }
  }

  return (
    <main className="center-screen">
      <form className="card auth" onSubmit={submit}>
        <Logo />
        <p className="muted">Vídeos longos viram cortes prontos para postar.</p>
        <label>
          E-mail
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Senha
          <input
            type="password"
            required
            minLength={6}
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {message && <p className={message.kind === 'error' ? 'error' : 'ok'}>{message.text}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Aguarde…' : mode === 'in' ? 'Entrar' : 'Criar conta'}
        </button>
        <button type="button" className="link" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
          {mode === 'in' ? 'Criar uma conta' : 'Já tenho conta'}
        </button>
      </form>
    </main>
  );
}
