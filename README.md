# Clyps

Vídeos longos viram cortes prontos para postar: o Clyps transcreve a fala, usa IA para escolher os melhores trechos e entrega cada clipe já reenquadrado (9:16, 1:1 ou 4:5) e com legenda queimada.

Roda inteiro numa VPS, sem serviços externos além das APIs de IA: login, banco (SQLite) e arquivos ficam no próprio servidor.

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

Abra `http://IP-DA-VPS`. A primeira conta criada é a de administrador; depois dela o cadastro fecha sozinho (para abrir de novo, `ALLOW_SIGNUP=1`).

Antes de processar vídeos, configure `MOCK_AI=0`, `STT_API_KEY`, `LLM_API_KEY` e `LLM_MODEL` no `.env`. O modo fictício só funciona com `NODE_ENV=test` + `MOCK_AI=1`; em produção ele é recusado com uma mensagem explícita. As chaves precisam ter acesso e saldo nos provedores. Alterar o exemplo não altera o `.env` já instalado: edite o arquivo da VPS e rode `docker compose up -d --build`.

Se seus clipes antigos dizem “esse é um teste do Clyps…”, eles foram renderizados com dados simulados. Corrigir a configuração não muda MP4s existentes: envie o vídeo original novamente ou crie outro job com o link.

- **Domínio e HTTPS:** aponte o domínio para o IP da VPS e coloque-o em `SITE_ADDRESS`. O certificado é emitido sozinho. Use HTTPS antes de usar para valer: sem ele, a senha trafega sem criptografia.
- **Portas ocupadas:** se a VPS já tem outro site nas portas 80/443, mude `HTTP_PORT` e `HTTPS_PORT`.
- **Atualizar:** `git pull && docker compose up -d --build`.
- **Backup:** tudo fica no volume `clyps_data` (banco e clipes).
- **Recursos:** 2 vCPU e 4 GB de RAM ou mais, e espaço em disco para os vídeos de origem durante o processamento.

## Desenvolvimento local

Precisa de Node 22, `ffmpeg` e `yt-dlp` instalados.

```bash
cd server && npm install && NODE_ENV=test MOCK_AI=1 npm run dev     # API em :3000
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
| `selectionFocus` | `balanced` (85% conteúdo + 15% energia), `impact` (conteúdo), `energy` (70% conteúdo + 30% energia) |
| `audioEnhancement` | `off`, `clean` (padrão), `voice` |
| `context` | texto livre para orientar a IA |

## Créditos (preparado para virar SaaS)

O banco já tem `users.credits` e `credit_ledger`. Cada job grava o custo em `jobs.credit_cost` (`CREDITS_PER_MINUTE` por minuto de vídeo). Por padrão nada é cobrado; com `ENFORCE_CREDITS=1` o servidor debita antes de processar e estorna se o job falhar. Falta, para vender: checkout, tela de planos e uma rota que credite o saldo.

## Limitações conhecidas

- O enquadramento `fill` corta pelo centro; ainda não segue o rosto de quem fala.
- Um job por vez; sem cancelamento no meio do processamento e sem editor de início/fim do corte.
- Banco SQLite num único servidor: ótimo para uso interno, mas para um SaaS com muitos usuários vale migrar para Postgres e separar a fila.

## Uso responsável

Baixe e recorte apenas vídeos seus ou que você tem autorização para usar, respeitando os termos da plataforma de origem.

## Transcrição, seleção e áudio

- A transcrição deve retornar `verbose_json` com `words`, `start` e `end`. Texto sem timestamps causa erro explícito, sem criar uma legenda inventada. `whisper-1` é o padrão compatível existente; confira a disponibilidade no provedor antes de mudar o modelo. A documentação da OpenAI anuncia a retirada desse modelo em 26/02/2027; planeje migrar para outro provedor/modelo com alinhamento por palavra antes dessa data.
- O editor avalia gancho, utilidade/surpresa, emoção e conclusão. Os limites são aproximados às frases/pausas reais e as durações escolhidas são respeitadas; quando o provedor omite pontuação e pausas, preserva a escolha do LLM ajustando os limites às palavras reais. Trechos fora da duração são descartados. Janelas de análise se sobrepõem para não perder uma ideia na divisão.
- A energia é medida no áudio original em blocos de 0,5 s, somente onde há fala transcrita, e normalizada dentro de cada vídeo. É uma heurística de intensidade, não detecção infalível de emoção. Se a análise de áudio falhar, a seleção continua pelo conteúdo.
- `clean`: filtros de graves/agudos, redução leve de ruído e normalização de volume. `voice`: acrescenta equalização e expansão suave para atenuar caudas do ambiente em pausas. Não é remoção de eco por IA; reverberação forte, distorção e áudio estourado podem continuar presentes. O mesmo perfil é aplicado antes da transcrição e na exportação; escolha `off` para preservar o áudio.
- Ao clicar em baixar, o diálogo oferece MP4 e legenda de post editável. A legenda usa apenas a transcrição do clipe, com cache por clipe. Se o LLM falhar, mostra um trecho da fala identificado como alternativa, sem impedir o download.

## Instagram: publicar e agendar Reels

Implementação opcional para **uma conta profissional e um usuário Clyps**, usando **Instagram API with Instagram Login**. Não é OAuth multiusuário nem publicação em páginas Facebook. É preciso configurar o app e autorizar a conta na Meta; para contas fora dos papéis de teste do app, podem ser necessários revisão e acesso avançado. O Clyps não concede permissões nem renova tokens automaticamente.

1. Obtenha no painel Meta o ID Instagram e um token para `instagram_business_basic` e `instagram_business_content_publish`. Use o fluxo Instagram Login (não o token de página Facebook).
2. Configure as variáveis `META_*` do `.env.example`. `META_OWNER_USER_ID` é o ID da conta Clyps, retornado por `/api/me` quando logado. `META_GRAPH_VERSION` deve ser uma versão ativa do seu app.
3. Configure `PUBLIC_BASE_URL` com a origem HTTPS pública, sem caminho, e `MEDIA_SIGNING_SECRET` com pelo menos 32 caracteres aleatórios. O download normal continua autenticado; a Meta acessa um link assinado que expira em 24 horas.
4. Recrie o container. No diálogo de download, revise a legenda e clique em publicar ou escolha a data (horário local do navegador). Confirme a ação. As datas são armazenadas como instantes UTC.

A fila persistente SQLite é verificada a cada minuto, independentemente do processamento de vídeos. Primeiro cria o container na Meta, espera `FINISHED` e só então chama `media_publish`. Agendamentos até 90 dias são enviados pelo servidor quando chega o horário; não dependem de um campo de agendamento do Instagram. **A VPS precisa permanecer ligada**; ao voltar de uma interrupção, envios vencidos são processados. Cancele na interface enquanto ainda estiverem na fila.

Há bloqueio de envios simultâneos do mesmo clipe, verificação de dono em todas as ações e proteção contra reenvio automático quando uma resposta de publicação se perde. Nessa situação o status será **Confira o Instagram**. O operador deve conferir a conta e reconciliar o registro no banco antes de permitir outra tentativa; não apague registros pendentes sem verificar o resultado remoto. Não rode múltiplas instâncias do servidor sobre o mesmo SQLite.

Os clipes novos são exportados em H.264, AAC 48 kHz/128 kbps e 30 fps. Prefira 9:16. A Meta pode recusar arquivos antigos, proporções, codecs ou contas que não atendam aos seus requisitos. Não houve publicação real durante o desenvolvimento: valide com um Reel de teste autorizado após configurar credenciais. Tokens expirados ou permissões revogadas são exibidos como falha.

Referências: [Meta — coleção oficial da API Instagram](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api), [OpenAI — transcrição](https://developers.openai.com/api/docs/guides/speech-to-text), [FFmpeg — filtros](https://ffmpeg.org/ffmpeg-filters.html).

## Verificação

```bash
cd server
npm ci
npm run typecheck
npm test
npm run smoke
cd ../web
npm ci
npm run build
```

Os testes usam respostas simuladas dos provedores e um banco temporário: não gastam créditos nem publicam vídeos. O smoke usa FFmpeg para validar a renderização. A validação com fala real, ambiente reverberante e credenciais do seu servidor continua necessária antes de colocar em produção.
