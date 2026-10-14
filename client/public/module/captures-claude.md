# Captures d'écran envoyées à Claude (Mac)

Instructions pour Claude Code sur le Mac de Charles. But : quand Charles fait
une capture d'écran normale (⌘⇧4 ou ⌘⇧3) **pendant qu'une session Claude est
ouverte sur l'ERP** (ssh vers le serveur, dossier `erp`), la capture part aussi
à l'ERP, où ce Claude la lit. Sinon, rien ne part.

Décisions de Charles (ne pas les refaire) :
- Les captures restent **dans son dossier de captures habituel** : ne pas
  changer l'emplacement des captures de macOS. On les copie, on ne les déplace pas.
- Une session sur un autre projet (ex. QNE) ne compte pas. C'est le serveur qui
  répond « session ERP ouverte ou non » ; le Mac ne fait que demander.

Prérequis : `~/.orisha/token` existe déjà (installé par
`https://customer.orisha.io/erp/module/installer-claude.md`). Sinon, faire
d'abord l'étape 2 de ce document.

## 1. Trouver le dossier des captures

```bash
defaults read com.apple.screencapture location 2>/dev/null || echo "$HOME/Desktop"
```

Si une version précédente de ce document l'a changé pour `~/Captures`, le
remettre où Charles l'avait (lui demander) et faire `killall SystemUIServer`.
Appeler ce dossier `CAPDIR` ci-dessous.

**Si CAPDIR est dans le Bureau, Documents ou Téléchargements**, macOS empêche
une tâche de fond de le lire : guider Charles dans Réglages Système →
Confidentialité et sécurité → Accès complet au disque → ajouter `/bin/bash`
(⌘⇧G pour taper le chemin). Sinon le journal affichera « Operation not permitted ».

## 2. Le script d'envoi

Créer `~/.orisha/send-captures.sh` (remplacer CAPDIR) :

```bash
#!/bin/bash
# Envoie à l'ERP chaque nouvelle capture, une seule fois chacune, et seulement
# si une session Claude est ouverte sur l'ERP en ce moment.
set -uo pipefail
DIR="CAPDIR"
SENT="$HOME/.orisha/captures-sent"
API="https://customer.orisha.io/erp/api/scrapers/session-bridge"
TOKEN="$(cat ~/.orisha/token)"
touch "$SENT"
sleep 1 # macOS écrit d'abord un fichier caché, puis le renomme
NEW=()
for f in "$DIR"/*.png "$DIR"/*.jpg "$DIR"/*.jpeg; do
  [ -f "$f" ] || continue
  grep -qxF "$f" "$SENT" && continue
  echo "$f" >> "$SENT" # vue une fois : jamais envoyée plus tard
  # Seulement les captures de la dernière minute.
  [ $(( $(date +%s) - $(stat -f %m "$f") )) -le 60 ] && NEW+=("$f")
done
[ ${#NEW[@]} -eq 0 ] && exit 0
ACTIVE="$(curl -fsS "$API/screenshot/active" -H "Authorization: Bearer ${TOKEN}" || echo '{}')"
case "$ACTIVE" in *'"active":true'*) ;; *) echo "$(date) pas de session ERP : non envoyée"; exit 0 ;; esac
for f in "${NEW[@]}"; do
  case "$f" in *.png) MIME=image/png ;; *) MIME=image/jpeg ;; esac
  TMP="$(mktemp)"
  printf '{"mime":"%s","note":"%s","data":"' "$MIME" "$(basename "$f" | tr -d '"\\')" > "$TMP"
  base64 -i "$f" | tr -d '\n' >> "$TMP"
  printf '"}' >> "$TMP"
  if curl -fsS -X POST "$API/screenshot" -H "Authorization: Bearer ${TOKEN}" \
       -H 'Content-Type: application/json' --data-binary @"$TMP" >/dev/null; then
    echo "$(date) envoyée : $f"
  else
    echo "$(date) échec : $f"
  fi
  rm -f "$TMP"
done
```

```bash
chmod +x ~/.orisha/send-captures.sh && ~/.orisha/send-captures.sh
```

(La première exécution marque les captures existantes comme vues : elles ne
partiront jamais.)

## 3. Le déclencher à chaque nouvelle capture (launchd)

Créer `~/Library/LaunchAgents/io.orisha.captures.plist` (CAPDIR en chemin
absolu, sans `~`) :

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.orisha.captures</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>-lc</string><string>~/.orisha/send-captures.sh</string></array>
  <key>WatchPaths</key><array><string>CAPDIR</string></array>
  <key>StandardOutPath</key><string>/tmp/orisha-captures.log</string>
  <key>StandardErrorPath</key><string>/tmp/orisha-captures.log</string>
</dict></plist>
```

```bash
launchctl unload ~/Library/LaunchAgents/io.orisha.captures.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/io.orisha.captures.plist
```

## Vérifier

Charles a une session Claude ouverte sur l'ERP : lui demander une capture
(⌘⇧4), attendre 5 s, `cat /tmp/orisha-captures.log` → « envoyée ». Sans
session ERP : « pas de session ERP : non envoyée ». En cas de 401 : jeton
expiré, en redemander un (Boréal → Collecte de factures → « Jeton »).
