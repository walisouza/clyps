#!/usr/bin/env bash
# Atualiza o Clyps na VPS quando há versão nova no GitHub.
#   ./scripts/update.sh           atualiza só se houver mudança
#   ./scripts/update.sh --force   reconstrói mesmo sem mudança
# O .env e os dados (volume clyps_data) não são tocados.
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ] && [ "${1:-}" != "--force" ]; then
  echo "$(date '+%F %T') Já está na versão mais recente ($(git rev-parse --short HEAD))."
  exit 0
fi

git reset -q --hard origin/main
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
echo "$(date '+%F %T') Atualizado para $(git log -1 --format='%h %s')."
