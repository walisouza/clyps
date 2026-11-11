# Clyps

Vídeos longos viram cortes prontos para postar: o Clyps transcreve a fala, usa IA para escolher os melhores trechos e entrega cada clipe já reenquadrado (9:16, 1:1 ou 4:5) e com legenda queimada.

Roda inteiro numa VPS: login, banco (SQLite), arquivos e transcrição (Speaches/Whisper) ficam no próprio servidor. APIs externas de IA são opcionais.

## Como funciona

```
navegador ──► Caddy (HTTPS) ──► servidor Node (app web + API + fila de cortes)
                                   └── /data: banco SQLite, uploads e clipes
```

1. O app cria um job (link ou arquivo enviado).
2. A fila processa um job por vez: baixar o vídeo (yt-dlp, se for link) → extrair áudio → transcrever com tempo por palavra → LLM escolhe os trechos → FFmpeg corta, reenquadra e queima a legenda.
3. O app acompanha o progresso e mostra os clipes com player, transcrição e download.

| Pasta | O que é |
|---|---|
| `server` | API, login, fila e processamento de vídeo (Node 22, TypeScript, SQLite, FFmpeg, yt-dlp) |
| `web` | Interface (React + Vite), servida pelo próprio servidor |

## Subir na VPS

```bash
# na VPS (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
git clone https://github.com/walisouza/clyps && cd clyps
cp .env.example .env
docker compose up -d --build
docker compose logs -f app            # deve mostrar "Clyps no ar"
```

Abra `http://IP-DA-VPS`. A primeira conta criada é a de administrador; depois dela o cadastro pela tela de login fecha sozinho. Outras contas são criadas pelo administrador na página **Conta** (que também troca a senha). Se alguém esquecer a senha: `docker compose exec app npx tsx src/reset-password.ts email@da.conta`.

O `.env.example` já vem com `MOCK_AI=1`: tudo funciona, mas a transcrição e a escolha dos trechos são simuladas. Para usar de verdade, apague essa linha do `.env` e rode `docker compose up -d --force-recreate app`.

- **Transcrição (Speaches):** o `docker compose` sobe junto um container do [Speaches](https://speaches.ai), que roda o Whisper na própria VPS, sem chave e sem custo por minuto. O modelo padrão é `Systran/faster-whisper-small` (troque com `SPEACHES_MODEL`); ele é baixado na primeira subida. Em CPU a transcrição é mais lenta que nas APIs pagas; o tempo depende da VPS e do modelo.
- **IA de texto (opcional):** com `LLM_API_KEY`, `LLM_BASE_URL` e `LLM_MODEL` (qualquer serviço no padrão OpenAI), a IA escolhe os trechos e escreve títulos e legendas do post. Sem ela, ou se ela falhar, o Clyps escolhe os trechos pela energia da fala e pelas frases completas, e o corte mostra um aviso.
- **Auphonic (opcional):** com `AUPHONIC_API_KEY`, aparece o tratamento de voz "Profissional", que manda cada clipe ao Auphonic (remoção de ruído e eco com IA, -14 LUFS). Se ele falhar, o clipe sai com o tratamento Forte local.
- **Diagnóstico:** `docker compose exec app npx tsx src/check-ai.ts` mostra o que está configurado e se cada serviço responde.

- **Domínio e HTTPS:** aponte o domínio para o IP da VPS e coloque-o em `SITE_ADDRESS`. O certificado é emitido sozinho. Use HTTPS antes de usar para valer: sem ele, a senha trafega sem criptografia.
- **Portas ocupadas:** se a VPS já tem outro site nas portas 80/443, mude `HTTP_PORT` e `HTTPS_PORT`.
- **Atualizar:** `./scripts/update.sh` (busca a versão nova no GitHub e reconstrói só se mudou). Para atualizar sozinho a cada 5 minutos, adicione ao `crontab -e`:
  `*/5 * * * * /root/clyps/scripts/update.sh >> /root/clyps-update.log 2>&1`
- **Backup:** tudo fica no volume `clyps_data` (banco e clipes).
- **Recursos:** 2 vCPU e 4 GB de RAM ou mais (o Speaches usa ~1 GB com o modelo small), e espaço em disco para a imagem do Speaches, o modelo e os vídeos durante o processamento.

## Desenvolvimento local

Precisa de Node 22, `ffmpeg` e `yt-dlp` instalados.

```bash
cd server && npm install && MOCK_AI=1 npm run dev     # API em :3000
cd web && npm install && npm run dev                   # app em :5173 (proxy para /api)
cd server && npm run smoke                             # testa só a renderização
```

## Opções de um job

| Opção | Valores |
|---|---|
| `language` | `pt`, `en`, `es` |
| `maxClips` | 1 a 20 |
| `clipLength` | `short` (15–40s), `medium` (30–60s), `long` (45–90s) |
| `aspect` | `9:16`, `1:1`, `4:5`, `original` |
| `layout` | `fill` (corta as laterais), `blur` (vídeo inteiro com fundo desfocado) |
| `captionStyle` | `karaoke`, `bold`, `minimal`, `none` |
| `captionPosition` | `bottom`, `center`, `top` |
| `highlightColor` | cor em `#RRGGBB` |
| `context` | texto livre para orientar a IA |

## Créditos (preparado para virar SaaS)

O banco já tem `users.credits` e `credit_ledger`. Cada job grava o custo em `jobs.credit_cost` (`CREDITS_PER_MINUTE` por minuto de vídeo). Por padrão nada é cobrado; com `ENFORCE_CREDITS=1` o servidor debita antes de processar e estorna se o job falhar. Falta, para vender: checkout, tela de planos e uma rota que credite o saldo.

## Editar um clipe

Cada clipe pronto tem um botão **Editar**: ajustar início e fim (com marcação pelo player), enquadrar o vídeo (zoom de 1× a 3×, arrastar para escolher o que aparece, alternar entre preencher a tela e vídeo inteiro com fundo desfocado), ligar ou desligar a legenda, trocar estilo, tamanho, posição e cor, corrigir o texto da legenda trecho a trecho e editar o título e a legenda do post. Ao salvar, o clipe é gerado de novo a partir de uma versão limpa guardada no servidor (no formato do vídeo original e com o áudio tratado, sem legenda, com 3 s de folga antes e depois), o que é bem mais rápido que o processamento completo.

## Publicar no Instagram e no Facebook

Cada clipe tem o botão **Publicar**: escolhe as contas (Reels do Instagram e da Página do Facebook), edita a legenda e publica na hora ou agenda. O agendamento fica no próprio Clyps, que publica no horário; a lista embaixo do clipe mostra o status, o link do post e permite cancelar ou tentar de novo.

1. Em developers.facebook.com, no seu app, adicione os casos de uso **Gerenciar tudo na sua Página** e **Gerenciar mensagens e conteúdo no Instagram** (ou o produto Login do Facebook), com as permissões `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`, `instagram_basic` e `instagram_content_publish`.
2. Em Login do Facebook → Configurações, cadastre o URI de redirecionamento `https://SEU-DOMINIO/api/meta/callback`.
3. Na VPS: `./scripts/meta.sh` (pede o App ID e o App Secret, confere com a Meta e reinicia o app).
4. No Clyps, em **Conta**, clique em **Conectar com o Facebook** e libere as Páginas e os Instagrams.

Páginas públicas para cadastrar no app (Configurações do app → Básico): `/privacidade`, `/termos` e `/exclusao-de-dados`. O nome e o e-mail de contato que aparecem nelas vêm de `LEGAL_NAME` e `CONTACT_EMAIL` no `.env`.

Com o app em modo de desenvolvimento, funciona para as contas de quem tem função no app (administrador, desenvolvedor ou testador). O Instagram precisa ser profissional (Criador ou Empresa) e ligado a uma Página. A Meta baixa o vídeo por um link temporário assinado do próprio Clyps, então o site precisa estar em HTTPS. No Facebook, clipes 9:16 de 3 a 90 s saem como Reels; os outros saem como vídeo da Página.

## Limitações conhecidas

- O enquadramento começa pelo centro e é ajustado à mão no editor; ainda não segue o rosto de quem fala.
- Clipes gerados antes do enquadramento guardaram a versão limpa já recortada: neles o zoom só mostra o que já estava na tela.
- Um job por vez e sem cancelamento no meio do processamento.
- O editor só estende o corte até 3 s antes e depois do trecho escolhido (a folga guardada na versão limpa); clipes gerados antes do editor existir não podem ser editados.
- Banco SQLite num único servidor: ótimo para uso interno, mas para um SaaS com muitos usuários vale migrar para Postgres e separar a fila.

## Uso responsável

Baixe e recorte apenas vídeos seus ou que você tem autorização para usar, respeitando os termos da plataforma de origem.
