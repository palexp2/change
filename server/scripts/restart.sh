#!/bin/bash
# Redémarre erp-server SANS coupure visible : un relais (erp-standby, port 3007)
# prend les requêtes le temps que le principal (3004) redémarre — nginx bascule
# seul sur son serveur « backup ». À utiliser à la place de `pm2 restart erp-server`.
#   server/scripts/restart.sh           redémarrage sans coupure
#   server/scripts/restart.sh --force   redémarrage classique direct (urgence)
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1

MAIN=http://127.0.0.1:3004/api/health
RELAY=http://127.0.0.1:3007/api/health

wait_health() { # url, secondes max, boot_id à éviter (facultatif)
  local url=$1 max=$2 avoid=$3 i body
  for ((i = 0; i < max * 5; i++)); do
    body=$(curl -s -m 1 "$url") && [ -n "$body" ] && { [ -z "$avoid" ] || [[ "$body" != *"$avoid"* ]]; } && return 0
    sleep 0.2
  done
  return 1
}

classic() { pm2 restart erp-server; }

if [ "$1" = "--force" ]; then classic; exit $?; fi

# 1. Relais en route (même code que le principal va charger).
pm2 start erp-standby.config.cjs >/dev/null 2>&1 || pm2 restart erp-standby >/dev/null 2>&1
if ! wait_health "$RELAY" 40; then
  echo "⚠️  Relais injoignable — redémarrage classique."
  pm2 stop erp-standby >/dev/null 2>&1
  classic; exit $?
fi

# 2. Principal : on attend qu'un NOUVEAU process réponde (boot_id différent).
OLD_BOOT=$(curl -s -m 1 "$MAIN" | sed -n 's/.*"boot_id":"\([^"]*\)".*/\1/p')
pm2 restart erp-server >/dev/null
if ! wait_health "$MAIN" 90 "$OLD_BOOT"; then
  echo "❌ erp-server ne répond pas après 90 s — le relais reste en ligne. Voir pm2 logs erp-server."
  exit 1
fi
sleep 3

# 3. Relais arrêté : il finit ses requêtes en cours avant de sortir.
pm2 stop erp-standby >/dev/null
echo "✅ erp-server redémarré sans coupure."
