#!/usr/bin/env bash
# Configura (ou troca) a chave da OpenAI no .env, reinicia o Clyps e roda o diagnóstico.
# Uso: ./scripts/openai.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env

read -rsp "Cole a chave da OpenAI (começa com sk-) e aperte Enter: " KEY
echo
KEY=$(printf '%s' "$KEY" | tr -d " \r\n\"'")
case "$KEY" in
  sk-*) ;;
  key_*) echo "Isso é o ID da chave, não a chave. A chave secreta começa com sk- e aparece só uma vez, ao ser criada em platform.openai.com → API keys."; exit 1 ;;
  "") echo "Nenhuma chave colada. Nada foi alterado."; exit 1 ;;
  *) echo "Essa chave não começa com sk-. Confira se copiou a chave secreta inteira. Nada foi alterado."; exit 1 ;;
esac

read -rp "Usar a OpenAI também para transcrever? (S = OpenAI, n = Speaches na VPS) [S/n] " STT
STT=${STT:-S}

# Apaga a configuração anterior de IA e o modo de teste, e grava a nova.
sed -i '/^LLM_/d;/^STT_/d;/^MOCK_AI=/d' .env
{
  echo
  echo "LLM_API_KEY=$KEY"
  echo "LLM_BASE_URL=https://api.openai.com/v1"
  echo "LLM_MODEL=${LLM_MODEL:-gpt-5-mini}"
  if [[ ! "$STT" =~ ^[Nn] ]]; then
    echo "STT_PROVIDER=openai"
    echo "STT_API_KEY=$KEY"
    echo "STT_BASE_URL=https://api.openai.com/v1"
    echo "STT_MODEL=whisper-1"
  fi
} >> .env
chmod 600 .env
echo "Chave gravada (${KEY:0:7}…, ${#KEY} caracteres). Reiniciando o Clyps…"

docker compose up -d --force-recreate app
sleep 5
echo
docker compose exec app npx tsx src/check-ai.ts
