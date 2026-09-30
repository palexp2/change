#!/bin/bash
# Hook PreToolUse (Bash) de Claude Code — .claude/settings.json.
# Refuse `pm2 restart|reload erp-server` : ça coupe l'app quelques secondes pour
# tous les utilisateurs. Le redémarrage passe par server/scripts/restart.sh.
cmd=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)
# Seulement en position de commande (début de ligne, ou après ; & | ( sudo) —
# pas une mention dans un texte, un commentaire ou un heredoc.
if printf '%s' "$cmd" | grep -Eq '(^|[;&|(]|sudo)[[:space:]]*pm2[[:space:]]+(restart|reload)[[:space:]]+([^|;&]*[[:space:]])?(erp-server|all|3)([[:space:]]|$|;|&|\|)'; then
  echo "Refusé : n'utilise pas 'pm2 restart erp-server' (coupure visible pour tous). Utilise /home/ec2-user/erp/server/scripts/restart.sh (sans coupure), ou 'restart.sh --force' en urgence." >&2
  exit 2
fi
exit 0
