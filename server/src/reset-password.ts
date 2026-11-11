// Redefine a senha de uma conta direto na VPS (quando alguém esquece a senha). Uso:
//   docker compose exec app npx tsx src/reset-password.ts email@exemplo.com
// A nova senha é pedida sem aparecer na tela. Encerra as sessões abertas dessa conta.
import { createInterface } from 'node:readline';
import { MIN_PASSWORD, setPassword } from './auth.js';
import { db } from './db.js';

const email = (process.argv[2] ?? '').trim().toLowerCase();
const users = db().prepare('select id, email from users order by created_at').all() as { id: string; email: string }[];
const user = users.find((u) => u.email.toLowerCase() === email);
if (!user) {
  console.log(email ? `Não existe conta com o e-mail ${email}.` : 'Informe o e-mail da conta.');
  console.log('Contas existentes:', users.map((u) => u.email).join(', ') || '(nenhuma)');
  process.exit(1);
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = (rl as any).output as NodeJS.WriteStream;
    (rl as any)._writeToOutput = (s: string) => {
      if (s.includes(question)) out.write(s); // não mostra o que é digitado
    };
    rl.question(question, (answer) => {
      rl.close();
      out.write('\n');
      resolve(answer);
    });
  });
}

const password = await askHidden(`Nova senha para ${user.email} (mínimo ${MIN_PASSWORD} caracteres): `);
if (password.length < MIN_PASSWORD) {
  console.log('Senha curta demais. Nada foi alterado.');
  process.exit(1);
}
setPassword(user.id, password);
console.log(`Senha de ${user.email} redefinida. As sessões abertas dessa conta foram encerradas.`);
