#!/usr/bin/env bash
# `npm run build` : construit à côté de dist, puis bascule par renommage.
# Un build en place vidait dist pendant ~40 s : la page ne chargeait plus et
# les onglets ouverts perdaient leurs modules (« Failed to fetch dynamically
# imported module »). Les builds simultanés passent l'un après l'autre.
# Un --outDir explicite (deploy.sh) garde l'ancien comportement.
# Builds fusionnés : une demande arrivée pendant qu'un build tournait attend le
# verrou ; si un build PARTI APRÈS elle a réussi entre-temps, il contenait déjà
# ses modifications — elle s'arrête là au lieu de rebâtir pour rien.
set -e
cd "$(dirname "$0")/.."
VITE=node_modules/.bin/vite
case " $* " in *" --outDir"*) exec "$VITE" build "$@" ;; esac
requested=$(date +%s%N)
exec 9>.build.lock
flock 9
last=$(cat .build.last-start 2>/dev/null || echo 0)
if [ "$last" -gt "$requested" ] 2>/dev/null; then
  echo "✓ Déjà inclus dans le build qui vient de se terminer."
  exit 0
fi
started=$(date +%s%N)
tmp=".dist-build-$$"
rm -rf "$tmp"
"$VITE" build --outDir "$tmp" --emptyOutDir "$@"
if [ ! -f "$tmp/index.html" ]; then rm -rf "$tmp"; echo "❌ Build sans index.html — dist conservé."; exit 1; fi
rm -rf dist.prev
[ -d dist ] && mv dist dist.prev
mv "$tmp" dist
echo "$started" > .build.last-start
