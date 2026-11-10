# Clyps

Vídeos longos viram cortes prontos para postar: o Clyps transcreve a fala, usa IA para escolher os melhores trechos e entrega cada clipe já reenquadrado (9:16, 1:1 ou 4:5) e com legenda queimada.

## Como funciona

```
web (React + Vite)  ──►  Supabase (Auth, Postgres, Storage)  ◄──  worker (Node + FFmpeg)
   cria o job               fila = tabela jobs                      processa o job
```

1. O app web cria uma linha em `jobs` (link ou arquivo enviado para o bucket `uploads`).
2. O worker pega o próximo job com `claim_next_job()` (`FOR UPDATE SKIP LOCKED`, então dá para rodar vários workers).
3. Pipeline: baixar o vídeo (yt-dlp ou Storage) → extrair áudio → transcrever com tempo por palavra → LLM escolhe os trechos → FFmpeg corta, reenquadra e queima a legenda → envia para o bucket `clips`.
4. O app acompanha o progresso (consulta a cada 3s) e mostra os clipes com player, transcrição e download.

| Pasta | O que é |
|---|---|
| `supabase/migrations` | Tabelas, RLS, fila, créditos e buckets |
| `worker` | Processamento de vídeo (Node 22, TypeScript, FFmpeg, yt-dlp) |
| `web` | Interface (React, Vite, supabase-js) |

## Colocar no ar numa VPS (caminho mais simples)

Uma VPS com Docker roda o app web e o worker juntos.

```bash
# na VPS (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
git clone https://github.com/walisouza/clyps && cd clyps
cp .env.example .env && nano .env     # preencha a service role key e as chaves de IA
docker compose up -d --build
docker compose logs -f worker         # deve mostrar "Clyps worker no ar"
```

O app abre em `http://IP-DA-VPS`. Com um domínio apontado para a VPS, coloque-o em `SITE_ADDRESS` no `.env` e rode `docker compose up -d` de novo: o HTTPS é emitido sozinho. Para atualizar depois: `git pull && docker compose up -d --build`.

Recomendado: 2 vCPU e 4 GB de RAM ou mais (a renderização usa CPU), e espaço em disco para o vídeo de origem durante o processamento.

## Colocar no ar (serviços separados)

### 1. Supabase
1. Crie um projeto em supabase.com.
2. Rode `supabase/migrations/0001_init.sql` no SQL Editor (ou `supabase db push`).
3. Em Authentication, crie seu usuário. Para uso interno, desligue o cadastro público depois (Authentication → Sign In / Providers → "Allow new users to sign up").
4. Em Storage → Settings, aumente o limite de tamanho de arquivo se for enviar vídeos grandes (o plano gratuito limita a 50 MB por arquivo; links não têm esse limite).

### 2. Worker
Precisa de um servidor que fique ligado (VPS, Railway, Fly.io, Render). Funções serverless não servem: o processamento usa FFmpeg e pode levar vários minutos.

```bash
cd worker
cp .env.example .env   # preencha as chaves
docker build -t clyps-worker .
docker run --env-file .env clyps-worker
```

Sem Docker: instale `ffmpeg`, `yt-dlp` e a fonte Inter, depois `npm install && npm start`.

Chaves necessárias:
- `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` (só no worker, nunca no front).
- `STT_API_KEY`: API de transcrição compatível com OpenAI (`/audio/transcriptions`, com timestamps por palavra).
- `LLM_API_KEY`, `LLM_MODEL` (e `LLM_BASE_URL` se não for OpenAI): qualquer API compatível com `/chat/completions`.

### 3. Web
```bash
cd web
cp .env.example .env   # URL do projeto e chave pública (anon)
npm install
npm run dev
```
Para publicar no Netlify: base directory `web`, e as duas variáveis `VITE_...` no painel. O `netlify.toml` já está configurado.

## Testar sem chaves de IA

```bash
cd worker && npm install
npm run smoke          # gera um vídeo sintético e renderiza clipes em ./smoke-out
MOCK_AI=1 npm start    # worker completo com transcrição e seleção simuladas
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

O banco já tem `profiles.credits`, `credit_ledger` e a função `adjust_credits`. Cada job grava o custo em `jobs.credit_cost` (`CREDITS_PER_MINUTE` por minuto de vídeo). Por padrão nada é cobrado; com `ENFORCE_CREDITS=1` o worker debita antes de processar e estorna se o job falhar. Falta, para vender: checkout (Stripe), tela de planos e webhook que chama `adjust_credits`.

## Limitações conhecidas desta versão

- O enquadramento `fill` corta pelo centro; ainda não segue o rosto de quem fala.
- Sem cancelamento de job e sem editor de corte (ajustar início/fim) na interface.
- Apagar um job não remove os arquivos do Storage.
- Envio de arquivo usa upload simples; para arquivos muito grandes vale trocar por upload resumível (TUS).

## Uso responsável

Baixe e recorte apenas vídeos seus ou que você tem autorização para usar, respeitando os termos da plataforma de origem.
