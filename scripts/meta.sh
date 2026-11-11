#!/usr/bin/env bash
# Liga a publicação no Instagram e no Facebook: grava o App ID e o App Secret do app da Meta no .env.
# Uso: ./scripts/meta.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env

SITE=$(grep -E '^SITE_ADDRESS=' .env | tail -1 | cut -d= -f2- | tr -d " \r\"'")
case "$SITE" in
  ""|:*) echo "Antes, configure o domínio com HTTPS (SITE_ADDRESS no .env): a Meta só aceita endereço https."; exit 1 ;;
  http*) PUBLIC="$SITE" ;;
  *) PUBLIC="https://$SITE" ;;
esac

echo "No app da Meta (developers.facebook.com → seu app → Configurações do app → Básico):"
read -rp  "App ID: " APP_ID
read -rsp "App Secret (não aparece na tela): " APP_SECRET
echo
APP_ID=$(printf '%s' "$APP_ID" | tr -d " \r\n\"'")
APP_SECRET=$(printf '%s' "$APP_SECRET" | tr -d " \r\n\"'")
if ! printf '%s' "$APP_ID" | grep -qE '^[0-9]{6,}$'; then echo "O App ID tem só números. Nada foi alterado."; exit 1; fi
if [ ${#APP_SECRET} -lt 20 ]; then echo "O App Secret parece incompleto. Nada foi alterado."; exit 1; fi

echo "Conferindo com a Meta…"
R=$(curl -s -m 20 "https://graph.facebook.com/oauth/access_token?client_id=$APP_ID&client_secret=$APP_SECRET&grant_type=client_credentials" || true)
if ! printf '%s' "$R" | grep -q access_token; then
  echo "A Meta não aceitou esse App ID com esse App Secret. Resposta:"
  printf '%s\n' "$R" | head -c 300; echo
  echo "Nada foi alterado."
  exit 1
fi
echo "App ID e App Secret conferem."

sed -i '/^META_APP_ID=/d;/^META_APP_SECRET=/d;/^PUBLIC_URL=/d' .env
printf '\nMETA_APP_ID=%s\nMETA_APP_SECRET=%s\nPUBLIC_URL=%s\n' "$APP_ID" "$APP_SECRET" "$PUBLIC" >> .env
chmod 600 .env

docker compose up -d --force-recreate app
echo
echo "Pronto. Falta cadastrar no app da Meta o endereço de retorno do login:"
echo "  $PUBLIC/api/meta/callback"
echo "Depois abra $PUBLIC/conta e clique em \"Conectar com o Facebook\"."
