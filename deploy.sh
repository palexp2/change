#!/bin/bash
set -e
cd /home/ec2-user/erp

# ─── PATH ────────────────────────────────────────────────────────────────────
# cron ne fournit que PATH=/sbin:/bin:/usr/sbin:/usr/bin — /usr/local/bin en est
# absent, donc `pm2` (installé dans /usr/local/bin) était introuvable sous cron.
# Combiné à `set -e`, le script mourait juste avant le restart : le front était
# rebuildé toutes les heures mais le serveur ne redémarrait jamais et le commit
# déployé n'était jamais enregistré. 3578 builds, 0 déploiement complet.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

# ─── Garde anti-interruption d'une tâche de l'agent autonome ──────────────────
# Redémarrer erp-server pendant qu'une tâche de l'agent s'exécute la fait passer
# en « bloquée » (garde-fou anti-boucle de taskRunner.js) — il faut alors la
# relancer à la main. On attend donc la fin de l'exécution en cours avant de
# toucher au serveur. Override : `./deploy.sh --force` pour déployer tout de suite.
FORCE=0
[ "$1" = "--force" ] && FORCE=1

# L'agent travaille sur QUATRE files en parallèle : un fichier PID par file
# (.agent-pid pour la file 0, puis .agent-pid-1..3). Il suffit qu'UNE exécution
# tourne pour qu'un redémarrage la fasse passer en « bloquée » — on attend donc
# qu'elles soient toutes terminées.
agent_running_pids() {
  local f pid
  for f in .agent-pid .agent-pid-1 .agent-pid-2 .agent-pid-3; do
    [ -f "$f" ] || continue
    pid=$(head -n1 "$f" 2>/dev/null)
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"
  done
}

agent_task_running() {
  [ -n "$(agent_running_pids)" ]
}

if [ "$FORCE" = "1" ]; then
  agent_task_running && echo "⏩ --force : des tâches de l'agent tournent et seront interrompues (puis bloquées)."
else
  WAITED=0
  MAX_WAIT=2400   # 40 min — un peu au-dessus du timeout d'exécution (30 min)
  while agent_task_running; do
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
      echo "⚠️  Tâche de l'agent toujours active après ${MAX_WAIT}s — on déploie quand même."
      break
    fi
    echo "⏳ Tâche(s) de l'agent autonome en cours (PID $(agent_running_pids | tr '\n' ' ')) — attente avant déploiement… (${WAITED}s écoulés, ./deploy.sh --force pour forcer)"
    sleep 15
    WAITED=$((WAITED + 15))
  done
fi

# ─── Politique changelog : le journal des nouveautés est OBLIGATOIRE ─────────
# Un déploiement qui touche client/src ou server/src sans nouvelle entrée dans
# client/src/data/changelog.json est BLOQUÉ. Échappatoire explicite et tracée :
# `./deploy.sh --skip-changelog` ou `SKIP_CHANGELOG=1 ./deploy.sh`.
CHANGELOG_BLOCK=1
[ "$SKIP_CHANGELOG" = "1" ] && CHANGELOG_BLOCK=0
for a in "$@"; do [ "$a" = "--skip-changelog" ] && CHANGELOG_BLOCK=0; done

# Pull latest code from GitHub
git pull origin main

# ─── Garde changelog ─────────────────────────────────────────────────────────
# Vérifie qu'une entrée changelog accompagne tout changement de client/src ou
# server/src depuis le dernier commit déployé (enregistré dans .last-deploy-commit).
if ! node server/src/scripts/check-changelog.js; then
  if [ "$CHANGELOG_BLOCK" = "1" ]; then
    echo "❌ Déploiement bloqué : le journal des nouveautés n'a pas été mis à jour."
    echo "   Ajoutez une entrée en tête de \"entries\" dans client/src/data/changelog.json (date, titre, changements),"
    echo "   ou relancez avec --skip-changelog (SKIP_CHANGELOG=1) pour passer outre en connaissance de cause."
    exit 1
  fi
  echo "⚠️  --skip-changelog : du code a changé sans entrée dans le journal — déploiement poursuivi malgré tout."
fi

# ─── Ne travailler que si quelque chose a changé ──────────────────────────────
# Ce script tourne sur cron toutes les heures. Il rebuildait et redémarrait
# systématiquement, même quand rien n'avait bougé — et ça se voyait pour les
# utilisateurs. Mesuré le 2026-09-04 en sondant un fichier statique toutes les
# 250 ms pendant le déploiement de 14:00 :
#
#   14:00:00  le build Vite démarre → latence 2 ms → 10-25 ms
#   14:00:06  1,00 s
#   14:00:11  1,02 s
#   14:00:24  port fermé (pm2 restart) → 502 pendant ~4 s
#   14:00:30  0,85 s   (le serveur redémarre : schéma, migrations, watchers)
#   14:00:45  1,69 s
#   14:00:47  retour à 2 ms
#
# Soit ~50 s de dégradation par heure, plus le rechargement automatique de tous
# les onglets ouverts derrière (voir ServerOfflineOverlay.jsx). Pour rien, la
# plupart du temps.
#
# On compare donc une empreinte des sources à celle du dernier déploiement :
# le build ne part que si `client/` a bougé, le redémarrage que si `server/` a
# bougé. Un cycle sans changement ne dérange plus personne.
#
# L'empreinte prend nom + taille + mtime, pas le contenu : `git pull` ne touche
# les mtimes que des fichiers qu'il modifie, et l'édition locale (dev et prod
# partagent l'arbre) change la mtime. Une mtime bougée sans changement de
# contenu provoque un build inutile — sans conséquence.
FINGERPRINT_FILE=.deploy-fingerprints

fingerprint() {
  # $@ = chemins à empreindre. `architectureManifest.js` est EXCLU : il est
  # regénéré par le prebuild à chaque build, donc l'inclure ferait rebuilder
  # à chaque cycle, pour l'éternité. Les vraies sources qui le font changer
  # sont dans l'empreinte de toute façon.
  find "$@" -type f -not -name architectureManifest.js -printf '%p %s %T@\n' 2>/dev/null \
    | LC_ALL=C sort | sha256sum | cut -c1-16
}

CLIENT_PATHS="client/src client/public client/index.html client/package.json client/vite.config.js client/tailwind.config.js client/postcss.config.js"
SERVER_PATHS="server/src server/package.json"
[ -f server/.env ] && SERVER_PATHS="$SERVER_PATHS server/.env"

CLIENT_FP=$(fingerprint $CLIENT_PATHS)
SERVER_FP=$(fingerprint $SERVER_PATHS)

PREV_CLIENT_FP=""
PREV_SERVER_FP=""
# shellcheck source=/dev/null
[ -f "$FINGERPRINT_FILE" ] && . "$FINGERPRINT_FILE"

FORCE_ALL=0
for a in "$@"; do [ "$a" = "--rebuild" ] && FORCE_ALL=1; done

NEED_BUILD=0
NEED_RESTART=0
[ "$CLIENT_FP" != "$PREV_CLIENT_FP" ] && NEED_BUILD=1
[ "$SERVER_FP" != "$PREV_SERVER_FP" ] && NEED_RESTART=1
# Filet : un dist absent ou amputé doit se rebuilder, empreinte ou pas.
[ -f client/dist/index.html ] || NEED_BUILD=1
if [ "$FORCE_ALL" = "1" ]; then
  NEED_BUILD=1
  NEED_RESTART=1
  echo "⏩ --rebuild : build et redémarrage forcés."
fi

# ─── Build frontend ──────────────────────────────────────────────────────────
# Dans un dossier à part, puis bascule par renommage. Avant, `vite build`
# réécrivait client/dist EN PLACE pendant ~18 s : nginx y sert désormais
# index.html et les assets, donc une ouverture de page tombant dans cette
# fenêtre pouvait lire un dist à moitié écrit.
#
# `nice`/`ionice` : la machine n'a que 2 vCPU et le build les sature tous les
# deux. Sans priorité basse, il volait le CPU à erp-server — c'est lui qu'on
# voit dans les 1,0 s de latence à 14:00:06 ci-dessus. Le build met un peu plus
# longtemps, l'app ne ralentit plus.
if [ "$NEED_BUILD" = "1" ]; then
  echo "🏗️  Build frontend (client/ a changé)…"
  rm -rf client/.dist-build
  NICE="nice -n 19"
  command -v ionice >/dev/null 2>&1 && NICE="ionice -c3 $NICE"
  ( cd client && $NICE npm run build -- --outDir .dist-build --emptyOutDir )
  if [ ! -f client/.dist-build/index.html ]; then
    echo "❌ Build terminé sans index.html — dist actuel conservé, déploiement arrêté."
    rm -rf client/.dist-build
    exit 1
  fi
  # Bascule. Deux renommages : l'ancien dist est gardé un cycle sous dist.prev,
  # de quoi revenir en arrière à la main si le build s'avère mauvais.
  rm -rf client/dist.prev
  [ -d client/dist ] && mv client/dist client/dist.prev
  mv client/.dist-build client/dist
  echo "✅ Frontend déployé (ancien build conservé dans client/dist.prev)"
else
  echo "⏭️  Build frontend sauté — client/ inchangé depuis le dernier déploiement."
fi

# ─── Redémarrage serveur ─────────────────────────────────────────────────────
# Volontairement non fatal : un pm2 absent ou en erreur ne doit pas avaler
# silencieusement la fin du script (enregistrement du commit changelog).
if [ "$NEED_RESTART" = "1" ]; then
  if ! command -v pm2 >/dev/null 2>&1; then
    echo "❌ pm2 introuvable dans le PATH ($PATH) — serveur NON redémarré."
    echo "   Le build front est en place mais server/src n'est pas rechargé."
    DEPLOY_INCOMPLETE=1
  elif ! pm2 restart erp-server; then
    echo "❌ 'pm2 restart erp-server' a échoué — serveur possiblement non rechargé."
    DEPLOY_INCOMPLETE=1
  fi
else
  echo "⏭️  Redémarrage sauté — server/ inchangé depuis le dernier déploiement."
fi

# Empreintes enregistrées seulement pour ce qui a effectivement abouti : un
# build raté ou un pm2 en erreur doit être retenté au prochain cycle.
{
  if [ "$NEED_BUILD" = "1" ]; then echo "PREV_CLIENT_FP=$CLIENT_FP"; else echo "PREV_CLIENT_FP=$PREV_CLIENT_FP"; fi
  if [ "$NEED_RESTART" = "1" ] && [ "${DEPLOY_INCOMPLETE:-0}" = "0" ]; then
    echo "PREV_SERVER_FP=$SERVER_FP"
  else
    echo "PREV_SERVER_FP=$PREV_SERVER_FP"
  fi
} > "$FINGERPRINT_FILE"

# Enregistre le commit déployé comme base pour la prochaine vérification changelog.
node server/src/scripts/check-changelog.js --record || true

if [ "${DEPLOY_INCOMPLETE:-0}" = "1" ]; then
  echo "⚠️  Deploy INCOMPLET at $(date) — voir l'erreur pm2 ci-dessus."
  exit 1
fi

echo "✅ Deploy done at $(date)"
