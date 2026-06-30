#!/usr/bin/env node
// Garde de déploiement : vérifie que le journal des changements
// (client/src/data/changelog.json) a bien été mis à jour quand du code
// applicatif (client/src/** ou server/src/**) a changé depuis le dernier
// déploiement enregistré.
//
// Pourquoi : on veut que « chaque changement de l'app se retrouve dans le
// journal des changements ». Le _comment de changelog.json documente déjà la
// règle ; ce script l'applique au moment du deploy (voir deploy.sh).
//
// Usage :
//   node server/src/scripts/check-changelog.js            → vérifie, exit 1 si violation
//   node server/src/scripts/check-changelog.js --base REF → force le commit de base
//   node server/src/scripts/check-changelog.js --record   → enregistre HEAD comme dernier deploy
//
// Résolution du commit de base (le « dernier commit déployé ») :
//   1. argument --base <ref> ou variable d'env CHANGELOG_BASE
//   2. contenu du fichier .last-deploy-commit à la racine du repo
//   3. fallback : HEAD~1
//
// Codes de sortie :
//   0 → OK (aucun code applicatif changé, ou changelog mis à jour, ou mode --record)
//   1 → VIOLATION (code applicatif changé sans toucher changelog.json)
//   0 → en cas d'erreur git interne, on n'avorte pas le deploy : on avertit et on sort 0.
//
// C'est un pur détecteur : il ne décide pas de bloquer/avertir. C'est deploy.sh
// qui applique la politique (avertir par défaut, bloquer si --strict-changelog).

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..', '..') // server/src/scripts → repo root
const STATE_FILE = join(REPO_ROOT, '.last-deploy-commit')
const CHANGELOG_PATH = 'client/src/data/changelog.json'

// Préfixes de code applicatif surveillés (relatifs à la racine du repo).
const WATCHED_PREFIXES = ['client/src/', 'server/src/']

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}

function isValidCommit(ref) {
  if (!ref) return false
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

function resolveBase() {
  // 1. --base <ref> ou CHANGELOG_BASE
  const argIdx = process.argv.indexOf('--base')
  const argBase = argIdx !== -1 ? process.argv[argIdx + 1] : null
  const candidates = [argBase, process.env.CHANGELOG_BASE]

  // 2. fichier d'état
  if (existsSync(STATE_FILE)) {
    try {
      candidates.push(readFileSync(STATE_FILE, 'utf8').trim())
    } catch {
      /* ignore */
    }
  }

  for (const c of candidates) {
    if (isValidCommit(c)) return c
  }

  // 3. fallback HEAD~1 (premier déploiement / pas d'état)
  if (isValidCommit('HEAD~1')) return 'HEAD~1'
  return null
}

function recordHead() {
  const head = git(['rev-parse', 'HEAD'])
  writeFileSync(STATE_FILE, head + '\n')
  console.log(`📌 Dernier commit déployé enregistré : ${head.slice(0, 10)} (${STATE_FILE})`)
}

function main() {
  if (process.argv.includes('--record')) {
    recordHead()
    process.exit(0)
  }

  const base = resolveBase()
  if (!base) {
    console.log('ℹ️  check-changelog : aucun commit de base déterminable (repo neuf ?) — vérification ignorée.')
    process.exit(0)
  }

  let changed
  try {
    const head = git(['rev-parse', 'HEAD'])
    if (git(['rev-parse', `${base}^{commit}`]) === head) {
      console.log('ℹ️  check-changelog : aucun nouveau commit depuis le dernier déploiement — rien à vérifier.')
      process.exit(0)
    }
    changed = git(['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean)
  } catch (err) {
    console.log(`⚠️  check-changelog : erreur git (${err.message.split('\n')[0]}) — vérification ignorée, deploy non bloqué.`)
    process.exit(0)
  }

  const codeChanged = changed.filter(
    (f) => f !== CHANGELOG_PATH && WATCHED_PREFIXES.some((p) => f.startsWith(p))
  )
  const changelogTouched = changed.includes(CHANGELOG_PATH)

  const shortBase = base.length === 40 ? base.slice(0, 10) : base

  if (codeChanged.length === 0) {
    console.log(`✅ check-changelog : aucun code applicatif modifié depuis ${shortBase} — OK.`)
    process.exit(0)
  }

  if (changelogTouched) {
    console.log(
      `✅ check-changelog : ${codeChanged.length} fichier(s) de code modifié(s) depuis ${shortBase}, ` +
        `et ${CHANGELOG_PATH} a été mis à jour — OK.`
    )
    process.exit(0)
  }

  // Violation
  console.error(
    `❌ check-changelog : ${codeChanged.length} fichier(s) de code applicatif modifié(s) depuis ${shortBase} ` +
      `SANS entrée correspondante dans ${CHANGELOG_PATH}.`
  )
  const preview = codeChanged.slice(0, 15)
  for (const f of preview) console.error(`     • ${f}`)
  if (codeChanged.length > preview.length) {
    console.error(`     … et ${codeChanged.length - preview.length} de plus.`)
  }
  console.error(
    `   → Ajoutez une entrée en tête du tableau "entries" de ${CHANGELOG_PATH} décrivant ce qui change pour l'utilisateur.`
  )
  process.exit(1)
}

main()
