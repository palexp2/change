#!/usr/bin/env node
// One-shot : pose factures.airtable_id sur les factures nées dans Stripe depuis
// le débranchement du sync complet (avril 2026), par le numéro de document —
// sans ce lien, le write-back les sautait (« record non lié à Airtable »).
// Puis repousse les champs Boréal → Airtable déjà saisis sur ces factures
// (ex. « Proposition » cochée).
//
// Usage : node src/scripts/backfill-factures-airtable-ids.js

import db from '../db/database.js'
import { backfillFactureAirtableIds } from '../services/factureLinks.js'
import { writeBackRecord } from '../services/airtableWriteback.js'

const result = await backfillFactureAirtableIds()
console.log('Liens posés :', result)

const toPush = db.prepare('SELECT id FROM factures WHERE airtable_id IS NOT NULL AND cf_proposition = 1').all()
for (const { id } of toPush) {
  const res = await writeBackRecord('factures', id, ['cf_proposition'])
  console.log(id, res?.ok ? 'poussé' : (res?.skipped || res?.error))
}
process.exit(0)
