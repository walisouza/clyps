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

O `.env.example` já vem com `MOCK_AI=1`: tudo funciona, mas a transcrição e a escolha dos trechos são simuladas. Para usar IA de verdade, edite o `.env`, apague essa linha, preencha `STT_API_KEY`, `LLM_API_KEY` e `LLM_MODEL`, e rode `docker compose up -d` de novo.

- **Domínio e HTTPS:** aponte o domínio para o IP da VPS e coloque-o em `SITE_ADDRESS`. O certificado é emitido sozinho. Use HTTPS antes de usar para valer: sem ele, a senha trafega sem criptografia.
- **Portas ocupadas:** se a VPS já tem outro site nas portas 80/443, mude `HTTP_PORT` e `HTTPS_PORT`.
- **Atualizar:** `git pull && docker compose up -d --build`.
- **Backup:** tudo fica no volume `clyps_data` (banco e clipes).
- **Recursos:** 2 vCPU e 4 GB de RAM ou mais, e espaço em disco para os vídeos de origem durante o processamento.

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

## Limitações conhecidas

- O enquadramento `fill` corta pelo centro; ainda não segue o rosto de quem fala.
- Um job por vez; sem cancelamento no meio do processamento e sem editor de início/fim do corte.
- Banco SQLite num único servidor: ótimo para uso interno, mas para um SaaS com muitos usuários vale migrar para Postgres e separar a fila.

## Uso responsável

Baixe e recorte apenas vídeos seus ou que você tem autorização para usar, respeitando os termos da plataforma de origem.
