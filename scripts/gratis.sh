#!/usr/bin/env bash
# Configuração sem custo: transcrição no Speaches (na própria VPS) e, opcionalmente, IA de texto
# pelo Gemini (Google AI Studio). Sem a chave do Gemini, os trechos são escolhidos pela energia da fala.
# Uso: ./scripts/gratis.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env

echo "Transcrição: Speaches (Whisper na própria VPS, sem custo)."
echo "IA de texto: cole a chave do Gemini (aistudio.google.com/apikey) ou só aperte Enter para usar sem IA de texto."
read -rsp "Chave do Gemini: " KEY
echo
KEY=$(printf '%s' "$KEY" | tr -d " \r\n\"'")

LLM_LINES=""
if [ -n "$KEY" ]; then
  echo "Consultando os modelos que essa chave pode usar…"
  LIST=$(curl -s -m 30 "https://generativelanguage.googleapis.com/v1beta/models?key=$KEY&pageSize=200" || true)
  if ! printf '%s' "$LIST" | grep -q '"models/gemini'; then
    echo "O Google não aceitou essa chave. Resposta:"
    printf '%s\n' "$LIST" | head -c 400; echo
    echo "Nada foi alterado."
    exit 1
  fi
  # Modelos de texto "flash" (rápidos e com cota gratuita maior); ignora imagem, áudio, TTS e embeddings.
  MODELS=$(printf '%s' "$LIST" | grep -o '"name": *"models/gemini-[^"]*flash[^"]*"' | sed -E 's/.*models\/([^"]*)"/\1/' \
    | grep -viE 'image|tts|audio|live|embedding|thinking|exp' | awk '!seen[$0]++')
  if [ -z "$MODELS" ]; then
    echo "A chave funciona, mas não achei modelos 'flash' de texto nela. Modelos disponíveis:"
    printf '%s' "$LIST" | grep -o '"name": *"models/[^"]*"' | head -20
    exit 1
  fi
  # Principal: gemini-2.5-flash se existir (estável); senão o primeiro da lista. Reservas: até 3 outros.
  if printf '%s\n' "$MODELS" | grep -qx 'gemini-2.5-flash'; then PRIMARY='gemini-2.5-flash'; else PRIMARY=$(printf '%s\n' "$MODELS" | head -1); fi
  FALLBACKS=$(printf '%s\n' "$MODELS" | grep -vx "$PRIMARY" | head -3 | paste -sd, -)
  echo "Modelo principal: $PRIMARY"
  echo "Reservas (se o principal estiver sobrecarregado): ${FALLBACKS:-nenhuma}"
  LLM_LINES=$(printf 'LLM_API_KEY=%s\nLLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai\nLLM_MODEL=%s\nLLM_FALLBACK_MODELS=%s\n' "$KEY" "$PRIMARY" "$FALLBACKS")
else
  echo "Sem IA de texto: os trechos serão escolhidos pela energia da fala e pelas frases."
fi

# Apaga a configuração anterior de IA (OpenAI, AssemblyAI, modo de teste) e grava a nova.
sed -i '/^LLM_/d;/^STT_/d;/^MOCK_AI=/d;/^ASSEMBLYAI_API_KEY=/d' .env
if [ -n "$LLM_LINES" ]; then printf '\n%s\n' "$LLM_LINES" >> .env; fi
chmod 600 .env

echo "Reiniciando o Clyps e o Speaches…"
docker compose up -d --force-recreate app speaches
sleep 8
echo
docker compose exec app npx tsx src/check-ai.ts
echo
echo "Na primeira vez o Speaches baixa o modelo de transcrição; se o diagnóstico disser que o modelo"
echo "ainda não está instalado, espere alguns minutos (acompanhe com: docker compose logs -f speaches)."
