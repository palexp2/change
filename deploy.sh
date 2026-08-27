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

agent_task_running() {
  [ -f .agent-pid ] || return 1
  local pid
  pid=$(head -n1 .agent-pid 2>/dev/null)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

if [ "$FORCE" = "1" ]; then
  agent_task_running && echo "⏩ --force : une tâche de l'agent tourne et sera interrompue (puis bloquée)."
else
  WAITED=0
  MAX_WAIT=2400   # 40 min — un peu au-dessus du timeout d'exécution (30 min)
  while agent_task_running; do
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
      echo "⚠️  Tâche de l'agent toujours active après ${MAX_WAIT}s — on déploie quand même."
      break
    fi
    echo "⏳ Tâche de l'agent autonome en cours (PID $(head -n1 .agent-pid)) — attente avant déploiement… (${WAITED}s écoulés, ./deploy.sh --force pour forcer)"
    sleep 15
    WAITED=$((WAITED + 15))
  done
fi

# ─── Politique changelog : bloquer ou avertir ? ──────────────────────────────
# Par défaut on AVERTIT (le deploy continue). Pour BLOQUER un deploy qui touche
# du code sans entrée changelog : `./deploy.sh --strict-changelog` ou
# `STRICT_CHANGELOG=1 ./deploy.sh`.
CHANGELOG_BLOCK=0
[ "$STRICT_CHANGELOG" = "1" ] && CHANGELOG_BLOCK=1
for a in "$@"; do [ "$a" = "--strict-changelog" ] && CHANGELOG_BLOCK=1; done

# Pull latest code from GitHub
git pull origin main

# ─── Garde changelog ─────────────────────────────────────────────────────────
# Vérifie qu'une entrée changelog accompagne tout changement de client/src ou
# server/src depuis le dernier commit déployé (enregistré dans .last-deploy-commit).
if ! node server/src/scripts/check-changelog.js; then
  if [ "$CHANGELOG_BLOCK" = "1" ]; then
    echo "❌ Déploiement bloqué : changelog non mis à jour. Ajoutez une entrée dans client/src/data/changelog.json,"
    echo "   ou relancez sans --strict-changelog (STRICT_CHANGELOG unset) pour avertir seulement."
    exit 1
  fi
  echo "⚠️  Avertissement : du code a changé sans entrée changelog — déploiement poursuivi (mode non strict)."
fi

# Rebuild frontend
cd client
npm run build
cd ..

# Restart server
# Volontairement non fatal : un pm2 absent ou en erreur ne doit pas avaler
# silencieusement la fin du script (enregistrement du commit changelog).
if ! command -v pm2 >/dev/null 2>&1; then
  echo "❌ pm2 introuvable dans le PATH ($PATH) — serveur NON redémarré."
  echo "   Le build front est en place mais server/src n'est pas rechargé."
  DEPLOY_INCOMPLETE=1
elif ! pm2 restart erp-server; then
  echo "❌ 'pm2 restart erp-server' a échoué — serveur possiblement non rechargé."
  DEPLOY_INCOMPLETE=1
fi

# Enregistre le commit déployé comme base pour la prochaine vérification changelog.
node server/src/scripts/check-changelog.js --record || true

if [ "${DEPLOY_INCOMPLETE:-0}" = "1" ]; then
  echo "⚠️  Deploy INCOMPLET at $(date) — voir l'erreur pm2 ci-dessus."
  exit 1
fi

echo "✅ Deploy done at $(date)"
