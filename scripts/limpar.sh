#!/usr/bin/env bash
# Libera espaço na VPS sem apagar nada do Clyps que importa:
# banco, contas, cortes, clipes e o modelo de transcrição (volumes do Docker) ficam intactos.
# Uso: ./scripts/limpar.sh
set -uo pipefail
cd "$(dirname "$0")/.."

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "Espaço antes:"; df -h / | tail -1
echo

echo "→ Cache de build do Docker (camadas de builds antigos)…"
docker builder prune -af >/dev/null 2>&1 && echo "  ok"

echo "→ Imagens e containers do Docker que não estão em uso…"
docker container prune -f >/dev/null 2>&1
docker image prune -af >/dev/null 2>&1 && echo "  ok"

echo "→ Arquivos temporários de cortes interrompidos…"
# Só limpa se nenhum corte estiver sendo processado agora.
if docker compose ps --status running app 2>/dev/null | grep -q app; then
  BUSY=$(docker compose exec -T app node -e "
    const D=require('better-sqlite3'); const d=new D('/data/clyps.db', {readonly:true});
    console.log(d.prepare(\"select count(*) n from jobs where status='processing'\").get().n)" 2>/dev/null || echo 1)
  if [ "${BUSY:-1}" = "0" ]; then
    docker compose exec -T app sh -c 'rm -rf /tmp/clyps-*' && echo "  ok"
  else
    echo "  pulado: há um corte em processamento agora"
  fi
fi

echo "→ Cache de pacotes do sistema…"
$SUDO apt-get clean -y >/dev/null 2>&1 && $SUDO apt-get autoremove -y >/dev/null 2>&1 && echo "  ok"

echo "→ Logs antigos do sistema (mantém os últimos 200 MB)…"
$SUDO journalctl --vacuum-size=200M >/dev/null 2>&1 && echo "  ok"

echo "→ Logs de containers maiores que 50 MB…"
for f in $($SUDO find /var/lib/docker/containers -name '*-json.log' -size +50M 2>/dev/null); do
  $SUDO truncate -s 0 "$f"
done
echo "  ok"

rm -f ~/clyps-pull.log ~/clyps-update.log.old 2>/dev/null

echo
echo "Espaço depois:"; df -h / | tail -1
echo
echo "Uso do Docker agora:"; docker system df
