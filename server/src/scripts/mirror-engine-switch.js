#!/usr/bin/env node
/**
 * mirror-engine-switch.js — bascule un miroir entre la fonction historique et
 * le moteur unique, et affiche l'état de la bascule.
 *
 * `airtable_mirrors.engine` est le seul commutateur : le routeur de webhooks et
 * le sync planifié le relisent à chaque appel, donc une bascule (ou son
 * annulation) prend effet sans redémarrage.
 *
 * Usage
 *   node src/scripts/mirror-engine-switch.js                        # état de tous les miroirs
 *   node src/scripts/mirror-engine-switch.js --mirror=adresses --to=unified
 *   node src/scripts/mirror-engine-switch.js --mirror=adresses --to=legacy   # annuler
 *
 * Garde-fou : le passage à 'unified' est refusé si le miroir n'a pas de plan
 * cœur déclaré dans CORE_PLANS. Sans plan, le moteur ne saurait pas quelles
 * colonnes écrire — mieux vaut refuser que d'écrire à côté.
 */

import db from '../db/database.js'
import { CORE_PLANS } from '../services/airtableMirrorEngine.js'

function parseArgs(argv) {
  const o = { mirror: null, to: null }
  for (const a of argv) {
    if (a.startsWith('--mirror=')) o.mirror = a.slice(9)
    else if (a.startsWith('--to=')) o.to = a.slice(5)
    else console.warn(`⚠️  argument ignoré : ${a}`)
  }
  return o
}

function printState() {
  const rows = db.prepare(`
    SELECT id, erp_table, status, engine, last_synced_at
    FROM airtable_mirrors
    WHERE status IN ('mirrored','paused')
    ORDER BY engine DESC, id
  `).all()
  const pad = (s, n) => String(s ?? '').padEnd(n)
  console.log('')
  console.log(`${pad('MIROIR', 18)}${pad('TABLE ERP', 22)}${pad('STATUT', 10)}${pad('MOTEUR', 10)}PLAN CŒUR`)
  console.log('─'.repeat(76))
  for (const r of rows) {
    const plan = CORE_PLANS[r.id]
    const planLabel = plan ? `${Object.keys(plan.fields || {}).length} clés${plan.derive ? ' + dérivées' : ''}${plan.insertOnly ? ' · insertion seule' : ''}` : '—'
    const mark = r.engine === 'unified' ? '⚙️  unified' : '   legacy'
    console.log(`${pad(r.id, 18)}${pad(r.erp_table, 22)}${pad(r.status, 10)}${pad(mark, 10)}${planLabel}`)
  }
  const n = rows.filter(r => r.engine === 'unified').length
  console.log('─'.repeat(76))
  console.log(`${n} / ${rows.length} miroir(s) sur le moteur unique · ${Object.keys(CORE_PLANS).length} plan(s) cœur déclaré(s)`)
  console.log('')
}

const opts = parseArgs(process.argv.slice(2))

if (!opts.mirror) {
  printState()
  process.exit(0)
}

if (!['legacy', 'unified'].includes(opts.to)) {
  console.error("--to doit valoir 'legacy' ou 'unified'")
  process.exit(2)
}

const row = db.prepare('SELECT * FROM airtable_mirrors WHERE id=?').get(opts.mirror)
if (!row) {
  console.error(`Miroir « ${opts.mirror} » absent du registre`)
  process.exit(1)
}
if (opts.to === 'unified' && !CORE_PLANS[opts.mirror]) {
  console.error(`Miroir « ${opts.mirror} » sans plan cœur dans CORE_PLANS — bascule refusée.`)
  console.error('Déclarer son plan dans services/airtableMirrorEngine.js avant de basculer.')
  process.exit(1)
}
if (row.engine === opts.to) {
  console.log(`« ${opts.mirror} » est déjà sur ${opts.to} — rien à faire`)
  process.exit(0)
}

db.prepare(`
  UPDATE airtable_mirrors
  SET engine=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id=?
`).run(opts.to, opts.mirror)

console.log(`« ${opts.mirror} » : ${row.engine} → ${opts.to}`)
printState()
