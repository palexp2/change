#!/usr/bin/env bash
# `npm run build` : construit à côté de dist, puis bascule par renommage.
# Un build en place vidait dist pendant ~40 s : la page ne chargeait plus et
# les onglets ouverts perdaient leurs modules (« Failed to fetch dynamically
# imported module »). Les builds simultanés passent l'un après l'autre.
# Un --outDir explicite (deploy.sh) garde l'ancien comportement.
set -e
cd "$(dirname "$0")/.."
VITE=node_modules/.bin/vite
case " $* " in *" --outDir"*) exec "$VITE" build "$@" ;; esac
exec 9>.build.lock
flock 9
tmp=".dist-build-$$"
rm -rf "$tmp"
"$VITE" build --outDir "$tmp" --emptyOutDir "$@"
if [ ! -f "$tmp/index.html" ]; then rm -rf "$tmp"; echo "❌ Build sans index.html — dist conservé."; exit 1; fi
rm -rf dist.prev
[ -d dist ] && mv dist dist.prev
mv "$tmp" dist
