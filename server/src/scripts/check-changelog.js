#!/usr/bin/env node
// Garde de déploiement : le journal des nouveautés (client/src/data/changelog.json,
// affiché sur /changelog) DOIT être mis à jour dès que du code applicatif
// (client/src/** ou server/src/**) change depuis le dernier déploiement.
//
// La logique vit dans server/src/services/changelogGuard.js (partagée avec la
// route GET /api/changelog/status qui alimente la page /changelog).
//
// Usage :
//   node server/src/scripts/check-changelog.js            → vérifie, exit 1 si violation
//   node server/src/scripts/check-changelog.js --base REF → force le commit de base
//   node server/src/scripts/check-changelog.js --record   → enregistre HEAD comme dernier deploy
//
// Codes de sortie :
//   0 → OK (aucun code applicatif changé, nouvelle entrée présente, ou --record)
//   1 → VIOLATION (code applicatif changé sans nouvelle entrée valide)
//   0 → en cas d'erreur git interne : on avertit, on ne bloque pas le deploy.
//
// C'est un pur détecteur : deploy.sh applique la politique (bloquant par défaut).

import { getChangelogStatus, recordHead, STATE_FILE, CHANGELOG_PATH } from '../services/changelogGuard.js'

function main() {
  if (process.argv.includes('--record')) {
    const head = recordHead()
    console.log(`📌 Dernier commit déployé enregistré : ${head.slice(0, 10)} (${STATE_FILE})`)
    process.exit(0)
  }

  const argIdx = process.argv.indexOf('--base')
  const base = argIdx !== -1 ? process.argv[argIdx + 1] : undefined

  const st = getChangelogStatus({ base })

  if (st.skipped) {
    console.log(`ℹ️  check-changelog : ${st.reason} — vérification ignorée, deploy non bloqué.`)
    process.exit(0)
  }

  const shortBase = st.base.length === 40 ? st.base.slice(0, 10) : st.base

  if (st.ok) {
    console.log(`✅ check-changelog (base ${shortBase}) : ${st.reason}`)
    for (const e of st.newEntries.slice(0, 5)) console.log(`     • ${e.date} — ${e.title}`)
    process.exit(0)
  }

  console.error(`❌ check-changelog (base ${shortBase}) : ${st.reason}`)
  const preview = st.codeChanged.slice(0, 15)
  for (const f of preview) console.error(`     • ${f}`)
  if (st.codeChanged.length > preview.length) {
    console.error(`     … et ${st.codeChanged.length - preview.length} de plus.`)
  }
  for (const e of st.invalidEntries) {
    console.error(`     ⚠️  entrée incomplète : ${JSON.stringify(e).slice(0, 120)}`)
  }
  console.error(
    `   → Ajoutez une entrée en tête du tableau "entries" de ${CHANGELOG_PATH} décrivant ce qui change pour l'utilisateur.`
  )
  process.exit(1)
}

main()
