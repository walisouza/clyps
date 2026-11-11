import { useEffect, useState, type FormEvent } from 'react';
import { api, type User } from '../lib/api';

type Account = { id: string; email: string; createdAt: string; isAdmin: boolean };

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next !== confirm) return setMsg({ ok: false, text: 'A confirmação não bate com a nova senha.' });
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setMsg({ ok: true, text: 'Senha alterada. As outras sessões abertas desta conta foram encerradas.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'Não foi possível alterar.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Trocar senha</h2>
      <label className="field">
        Senha atual
        <input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="field">
        Nova senha
        <input type="password" required minLength={8} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label className="field">
        Repita a nova senha
        <input type="password" required minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      {msg && <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
      <button className="primary" disabled={busy}>
        {busy ? 'Salvando…' : 'Trocar senha'}
      </button>
    </form>
  );
}

function Users({ me }: { me: User }) {
  const [users, setUsers] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPwd, setResetPwd] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = () =>
    api
      .listUsers()
      .then((r) => setUsers(r.users))
      .catch((e) => setError(e instanceof Error ? e.message : 'Erro ao carregar.'));
  useEffect(() => {
    load();
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.createUser(email.trim(), password);
      setMsg({ ok: true, text: `Conta ${email.trim()} criada. Passe o e-mail e a senha para a pessoa.` });
      setEmail('');
      setPassword('');
      load();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'Não foi possível criar.' });
    } finally {
      setBusy(false);
    }
  }

  async function reset(id: string) {
    try {
      await api.resetUserPassword(id, resetPwd);
      setMsg({ ok: true, text: 'Senha redefinida. As sessões dessa conta foram encerradas.' });
      setResetFor(null);
      setResetPwd('');
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'Não foi possível redefinir.' });
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteUser(id);
      setConfirmDelete(null);
      load();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'Não foi possível apagar.' });
    }
  }

  return (
    <section className="card">
      <h2>Contas</h2>
      <p className="muted small">Só você, como administrador, cria e remove contas. O cadastro pela tela de login fica fechado.</p>
      {error && <p className="error">{error}</p>}
      {users && (
        <ul className="user-list">
          {users.map((u) => (
            <li key={u.id}>
              <div className="user-row">
                <span className="user-email">{u.email}</span>
                {u.isAdmin && <span className="badge completed">admin</span>}
                {u.id === me.id && <span className="muted small">(você)</span>}
                <span className="spacer" />
                {u.id !== me.id && (
                  <>
                    <button type="button" className="link small" onClick={() => setResetFor(resetFor === u.id ? null : u.id)}>
                      Nova senha
                    </button>
                    {confirmDelete === u.id ? (
                      <>
                        <button type="button" className="link small error" onClick={() => remove(u.id)}>
                          Confirmar
                        </button>
                        <button type="button" className="link small" onClick={() => setConfirmDelete(null)}>
                          Cancelar
                        </button>
                      </>
                    ) : (
                      <button type="button" className="link small muted" onClick={() => setConfirmDelete(u.id)}>
                        Apagar
                      </button>
                    )}
                  </>
                )}
              </div>
              {confirmDelete === u.id && (
                <p className="small error">Apaga a conta e todos os cortes dela. Não dá para desfazer.</p>
              )}
              {resetFor === u.id && (
                <div className="row">
                  <input
                    type="password"
                    placeholder="Nova senha (mín. 8)"
                    minLength={8}
                    autoComplete="new-password"
                    value={resetPwd}
                    onChange={(e) => setResetPwd(e.target.value)}
                  />
                  <button type="button" className="primary" onClick={() => reset(u.id)}>
                    Salvar
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <form className="stack" onSubmit={add}>
        <h2>Nova conta</h2>
        <label className="field">
          E-mail
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          Senha (mínimo 8 caracteres)
          <input type="text" required minLength={8} autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {msg && <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Criando…' : 'Criar conta'}
        </button>
      </form>
    </section>
  );
}

export default function AccountPage({ user }: { user: User }) {
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Conta</h1>
        <p className="muted mono">{user.email}</p>
      </div>
      <ChangePassword />
      {user.isAdmin && <Users me={user} />}
    </div>
  );
}
