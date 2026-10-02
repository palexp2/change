#!/usr/bin/env bash
# Prépare un compte Claude supplémentaire pour la file de travaux.
#   usage : claude-account-setup.sh <nom>        (ex. compte-2)
# Crée ~/.claude-accounts/<nom>/ : seul l'identifiant (.credentials.json, .claude.json)
# y est propre ; réglages, hooks, skills, mémoire et sessions sont des liens vers
# ~/.claude, pour que l'agent se comporte à l'identique quel que soit le compte (et
# qu'une conversation reprise sur l'autre compte retrouve sa session).
# Ensuite : CLAUDE_CONFIG_DIR=~/.claude-accounts/<nom> claude auth login
set -euo pipefail
name="${1:?nom du compte requis}"
dir="$HOME/.claude-accounts/$name"
mkdir -p "$dir"
for f in settings.json settings.local.json hooks skills projects plugins agents commands \
         statusline.sh slack-notify.sh CLAUDE.md file-history todos plans; do
  [ -e "$HOME/.claude/$f" ] || continue
  [ -e "$dir/$f" ] || ln -s "$HOME/.claude/$f" "$dir/$f"
done
echo "$dir prêt — connexion : CLAUDE_CONFIG_DIR=$dir claude auth login"
