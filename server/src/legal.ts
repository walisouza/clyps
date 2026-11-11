import { config } from './config.js';

// Páginas públicas exigidas pela Meta (e úteis para quem usa o Clyps):
// Política de Privacidade, Termos de Uso e Instruções de Exclusão de Dados.
// Quem responde por elas é configurado no .env: LEGAL_NAME e CONTACT_EMAIL.

const UPDATED = '11 de novembro de 2026';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function owner() {
  const name = esc((process.env.LEGAL_NAME ?? '').trim() || 'o responsável pelo Clyps');
  const email = (process.env.CONTACT_EMAIL ?? '').trim();
  const contact = email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : 'pelo contato do administrador da sua conta';
  return { name, contact, site: esc(config.publicUrl || '') };
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · Clyps</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2314130F'/%3E%3Cpath d='M9 23 23 9' stroke='%23FF4D1F' stroke-width='4' stroke-linecap='round'/%3E%3C/svg%3E" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root { --paper: #f4f1ea; --ink: #14130f; --cut: #ff4d1f; --muted: #5d5a52; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 17px/1.65 'Bricolage Grotesque', system-ui, sans-serif; }
  header { border-bottom: 1.5px solid var(--ink); padding: 18px 16px; }
  header div, main, footer div { max-width: 760px; margin: 0 auto; }
  .logo { font-weight: 800; font-size: 26px; letter-spacing: -0.04em; color: var(--ink); text-decoration: none; }
  .logo span { color: var(--cut); }
  main { padding: 40px 16px 64px; }
  h1 { font-size: clamp(32px, 6vw, 48px); line-height: 1.05; letter-spacing: -0.03em; margin: 0 0 8px; }
  h2 { font-size: 22px; letter-spacing: -0.01em; margin: 36px 0 8px; }
  .meta { font: 13px 'IBM Plex Mono', monospace; color: var(--muted); margin: 0 0 28px; }
  p, li { max-width: 68ch; }
  ul { padding-left: 22px; }
  li { margin: 4px 0; }
  a { color: var(--ink); text-underline-offset: 3px; }
  .box { border: 1.5px solid var(--ink); border-radius: 14px; background: #fff; padding: 16px 20px; box-shadow: 4px 4px 0 var(--ink); margin: 20px 0; }
  footer { border-top: 1.5px solid var(--ink); padding: 18px 16px; font: 13px 'IBM Plex Mono', monospace; }
  footer div { display: flex; gap: 18px; flex-wrap: wrap; }
</style>
</head>
<body>
<header><div><a class="logo" href="/">Cl<span>y</span>ps</a></div></header>
<main>
<h1>${title}</h1>
<p class="meta">Atualizado em ${UPDATED}</p>
${body}
</main>
<footer><div>
  <a href="/privacidade">Privacidade</a>
  <a href="/termos">Termos de uso</a>
  <a href="/exclusao-de-dados">Exclusão de dados</a>
</div></footer>
</body>
</html>`;
}

export function privacyPage(): string {
  const { name, contact, site } = owner();
  return page(
    'Política de Privacidade',
    `
<p>Esta política explica quais dados o Clyps${site ? ` (${site})` : ''} coleta, para que usa e como você pode pedir a exclusão. O Clyps é uma ferramenta que transforma vídeos longos em cortes curtos e, se você quiser, publica esses cortes no Instagram e no Facebook. O controlador dos dados é ${name}, que pode ser contatado ${contact}.</p>

<h2>Dados que coletamos</h2>
<ul>
  <li><strong>Conta:</strong> e-mail e senha. A senha é guardada só como hash criptográfico, nunca em texto.</li>
  <li><strong>Vídeos:</strong> os arquivos que você envia ou os links que você informa, os cortes gerados, a transcrição da fala e os textos (títulos e legendas).</li>
  <li><strong>Cookies de acesso:</strong> um cookie de sessão para manter você conectado. Se você enviar um arquivo de cookies para baixar vídeos de outras plataformas, ele fica guardado só para essa finalidade e pode ser apagado a qualquer momento.</li>
  <li><strong>Facebook e Instagram (só se você conectar):</strong> o identificador e o nome das Páginas do Facebook que você autorizar, o identificador e o nome de usuário das contas profissionais do Instagram ligadas a elas, as fotos de perfil dessas contas e os tokens de acesso fornecidos pela Meta. Os tokens são guardados criptografados.</li>
  <li><strong>Publicações:</strong> o que você pediu para publicar ou agendar, quando, em qual conta, o resultado e o link do post.</li>
</ul>

<h2>Como usamos esses dados</h2>
<ul>
  <li>Para gerar os cortes, as legendas e as sugestões de texto.</li>
  <li>Para publicar ou agendar nos seus perfis apenas o que você pedir, com a legenda que você aprovar. O Clyps não publica nada sozinho, não lê mensagens, não acessa dados de seguidores e não usa os dados para anúncios.</li>
  <li>Para manter a segurança da conta e corrigir erros.</li>
</ul>
<p>Os dados da Meta são usados só para essas funções e seguem os <a href="https://developers.facebook.com/terms/">Termos da Plataforma da Meta</a>.</p>

<h2>Com quem compartilhamos</h2>
<p>Não vendemos nem alugamos dados. Eles só saem do servidor do Clyps quando necessário para o serviço:</p>
<ul>
  <li><strong>Meta (Facebook e Instagram):</strong> o vídeo e a legenda que você mandou publicar.</li>
  <li><strong>Serviço de IA de texto, quando configurado (por exemplo, Google Gemini):</strong> o texto da transcrição, para sugerir trechos, títulos e legendas.</li>
  <li><strong>Auphonic, quando você escolhe o tratamento de voz Profissional:</strong> o áudio dos trechos escolhidos.</li>
  <li><strong>Plataforma de origem do vídeo:</strong> quando você informa um link, o servidor baixa o vídeo dessa plataforma.</li>
</ul>
<p>A transcrição da fala é feita no próprio servidor do Clyps.</p>

<h2>Onde e por quanto tempo guardamos</h2>
<p>Os dados ficam no servidor do Clyps. Os cortes, as transcrições e o histórico de publicações ficam guardados até você apagar o corte ou a conta. Vídeos enviados são apagados depois que o corte é concluído; se o corte falhar, ficam até 7 dias para você tentar de novo. Os dados de conexão com a Meta ficam até você desconectar.</p>

<h2>Seus direitos</h2>
<p>Pela Lei Geral de Proteção de Dados (LGPD), você pode pedir acesso, correção, portabilidade e exclusão dos seus dados, e revogar autorizações a qualquer momento. Veja como em <a href="/exclusao-de-dados">Exclusão de dados</a> ou fale ${contact}.</p>

<h2>Segurança</h2>
<p>O acesso ao Clyps é feito por HTTPS, as senhas são guardadas com hash e os tokens da Meta são criptografados. Nenhum sistema é 100% seguro, mas tomamos medidas razoáveis para proteger os dados.</p>

<h2>Mudanças nesta política</h2>
<p>Se esta política mudar, a data no topo da página é atualizada. Mudanças importantes são avisadas no próprio Clyps.</p>
`,
  );
}

export function termsPage(): string {
  const { name, contact } = owner();
  return page(
    'Termos de Uso',
    `
<p>Ao usar o Clyps, você concorda com estes termos. O serviço é oferecido por ${name}, que pode ser contatado ${contact}.</p>

<h2>O serviço</h2>
<p>O Clyps corta vídeos longos em clipes curtos, com transcrição, legendas e reenquadramento, e pode publicar ou agendar esses clipes no Instagram e no Facebook nas contas que você conectar. O acesso é feito por contas criadas pelo administrador.</p>

<h2>Seu conteúdo</h2>
<ul>
  <li>Você continua dono dos vídeos e textos que envia e gera. Você nos autoriza a processá-los só para prestar o serviço.</li>
  <li>Você declara que tem os direitos ou a autorização necessários para usar, cortar e publicar os vídeos que envia ou indica por link, e que respeita os termos das plataformas de origem.</li>
  <li>Você é responsável pelo que publica nas suas contas por meio do Clyps.</li>
</ul>

<h2>Uso permitido</h2>
<p>Não é permitido usar o Clyps para conteúdo ilegal, que viole direitos de terceiros (incluindo direitos autorais), que desrespeite as regras do Instagram e do Facebook, ou para tentar burlar a segurança do serviço. Contas que fizerem isso podem ser suspensas.</p>

<h2>Integração com a Meta</h2>
<p>A publicação usa a API oficial da Meta e depende da sua autorização. Você pode desconectar a qualquer momento na página Conta do Clyps ou nas configurações do Facebook (Integrações comerciais). O Clyps não tem controle sobre a disponibilidade, os limites ou as mudanças da plataforma da Meta.</p>

<h2>Disponibilidade e responsabilidade</h2>
<p>O Clyps é oferecido no estado em que se encontra. Nos esforçamos para que funcione bem, mas não garantimos que fique sempre disponível ou sem erros, nem que todo corte ou publicação dê certo. Guarde cópias do que for importante. Na extensão permitida pela lei, não respondemos por perdas indiretas decorrentes do uso do serviço.</p>

<h2>Encerramento</h2>
<p>Você pode parar de usar o Clyps e pedir a exclusão da conta a qualquer momento. Podemos encerrar contas que violem estes termos.</p>

<h2>Privacidade</h2>
<p>O tratamento de dados segue a <a href="/privacidade">Política de Privacidade</a>.</p>

<h2>Mudanças e lei aplicável</h2>
<p>Estes termos podem ser atualizados; a data no topo indica a versão atual. Aplica-se a lei brasileira.</p>
`,
  );
}

export function deletionPage(): string {
  const { contact } = owner();
  return page(
    'Exclusão de dados',
    `
<p>Você pode apagar seus dados do Clyps a qualquer momento. Escolha o que quer remover:</p>

<h2>Desconectar o Facebook e o Instagram</h2>
<div class="box">
<ol>
  <li>Entre no Clyps e abra a página <strong>Conta</strong>.</li>
  <li>Em <strong>Instagram e Facebook</strong>, clique em <strong>Desconectar</strong>.</li>
</ol>
<p>Os tokens de acesso e os dados das Páginas e perfis são apagados na hora, e os agendamentos pendentes são cancelados.</p>
</div>
<p>Você também pode remover o acesso pelo Facebook: <strong>Configurações e privacidade → Configurações → Integrações comerciais</strong>, selecione o app do Clyps e clique em <strong>Remover</strong>. Depois disso o Clyps perde o acesso às suas contas.</p>

<h2>Apagar cortes e clipes</h2>
<p>No <strong>Histórico</strong>, abra o corte e clique em <strong>Apagar este corte</strong>. Os vídeos, clipes, transcrições e o histórico de publicações daquele corte são apagados do servidor.</p>

<h2>Apagar a conta inteira</h2>
<p>Peça ${contact}, informando o e-mail da sua conta no Clyps. A conta e todos os dados ligados a ela (cortes, clipes, transcrições, conexões com a Meta e publicações) são apagados em até 30 dias, e você recebe a confirmação pelo mesmo canal.</p>

<p>Posts que já foram publicados no Instagram ou no Facebook ficam nas suas contas; para removê-los, apague-os diretamente nessas plataformas.</p>
`,
  );
}
