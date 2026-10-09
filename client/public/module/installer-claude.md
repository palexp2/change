# Mise à jour automatique du module Orisha (Mac)

Instructions pour Claude Code sur le Mac de Charles. But : que le module de
navigateur « Orisha — Pont de session » se mette à jour tout seul, sans que
Charles ait jamais à retélécharger, décompresser ou recharger quoi que ce soit.

Le module (version 1.8.1 et plus) se recharge de lui-même dans Edge dans les
30 secondes qui suivent un changement de ses fichiers. Il reste à faire en sorte que ce dossier soit
remplacé régulièrement par la dernière version publiée par l'ERP.

## 1. Trouver le dossier du module

Chercher le dossier qui contient un `manifest.json` dont le nom est
« Orisha — Pont de session » :

```bash
grep -rl '"Orisha — Pont de session"' ~/Downloads ~/Desktop ~/Documents 2>/dev/null | grep manifest.json
```

**Le bon dossier est celui qu'Edge a chargé**, pas une copie dans
Téléchargements. Edge l'écrit dans ses préférences :

```bash
grep -ho '"path":"[^"]*"' ~/Library/Application\ Support/Microsoft\ Edge/*/Secure\ Preferences \
  ~/Library/Application\ Support/Microsoft\ Edge/*/Preferences 2>/dev/null | sort -u
```

Garder le chemin dont le `manifest.json` est « Orisha — Pont de session ».
Appeler ce dossier `DIR` ci-dessous. Si le script existe déjà avec un autre
dossier, le corriger.

## 2. Le jeton

Demander à Charles son jeton ERP : Boréal → Collecte de factures → bouton
« Jeton » (c'est le même que celui des réglages du module). Ne jamais l'écrire
ailleurs que dans le fichier ci-dessous, en `chmod 600`.

```bash
mkdir -p ~/.orisha && printf '%s' 'LE_JETON' > ~/.orisha/token && chmod 600 ~/.orisha/token
```

## 3. Le script de mise à jour

Créer `~/.orisha/update-module.sh` (remplacer DIR par le chemin trouvé) :

```bash
#!/bin/bash
set -euo pipefail
DIR="DIR"
TOKEN="$(cat ~/.orisha/token)"
# Version publiée : un appel minuscule, le zip seulement si elle a changé.
LATEST="$(curl -fsS "https://customer.orisha.io/erp/api/scrapers/session-bridge/module/version?token=${TOKEN}")"
CURRENT="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DIR/manifest.json" | head -1)"
[ -n "$LATEST" ] && [ "$LATEST" = "$CURRENT" ] && exit 0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsS "https://customer.orisha.io/erp/api/scrapers/session-bridge/module?token=${TOKEN}" -o "$TMP/m.zip"
unzip -q -o "$TMP/m.zip" -d "$TMP/new"
# Rien à faire si la version n'a pas changé.
if cmp -s "$TMP/new/manifest.json" "$DIR/manifest.json"; then exit 0; fi
# background.js et les autres d'abord, le manifeste en DERNIER : le module se
# recharge quand il voit la nouvelle version, tous les fichiers doivent déjà y être.
for f in "$TMP/new"/*; do [ "$(basename "$f")" = manifest.json ] || cp -f "$f" "$DIR/"; done
cp -f "$TMP/new/manifest.json" "$DIR/manifest.json"
echo "$(date) module mis à jour"
```

```bash
chmod +x ~/.orisha/update-module.sh && ~/.orisha/update-module.sh
```

## 4. Le lancer toutes les 30 secondes (launchd)

Créer `~/Library/LaunchAgents/io.orisha.module-update.plist` :

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.orisha.module-update</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>-lc</string><string>~/.orisha/update-module.sh</string></array>
  <key>StartInterval</key><integer>30</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/orisha-module-update.log</string>
  <key>StandardErrorPath</key><string>/tmp/orisha-module-update.log</string>
</dict></plist>
```

```bash
launchctl unload ~/Library/LaunchAgents/io.orisha.module-update.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/io.orisha.module-update.plist
```

## 5. Une dernière fois à la main

Si le module chargé dans Edge est plus vieux que 1.8.1, il ne sait pas encore
se recharger seul : après la première exécution du script, dans
`edge://extensions`, cliquer une fois sur le bouton de rechargement de la carte
Orisha. Ensuite, plus jamais.

## Vérifier

- `cat /tmp/orisha-module-update.log` — « module mis à jour » à chaque nouvelle version.
- `edge://extensions` : la carte Orisha affiche la dernière version moins d’une minute après.
