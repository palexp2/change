// Synchronise UNIQUEMENT les liens projet/commande des factures depuis Airtable.
//
// Règles strictes :
//   - On ne touche qu'à `project_id` et `order_id` — jamais montants, dates, statut.
//   - On n'insère JAMAIS de nouvelle facture (pas d'import depuis Airtable).
//   - Une facture ERP n'est candidate que si son `invoice_id LIKE 'in_%'`
//     (preuve qu'elle existe côté Stripe — la source de vérité actuelle).
//   - Si `project_id` OU `order_id` est déjà rempli côté ERP, on ne touche rien.
//   - Match Airtable ↔ ERP : par `Numéro de document` = `factures.document_number`.
//
// Utilisé par :
//   - Webhook Airtable (changements en temps réel) — voir airtableWebhooks.js
//   - Script one-shot de backfill — voir scripts/backfill-factures-airtable-links.js

import db from '../db/database.js'
import { getAccessToken, airtableFetch } from '../connectors/airtable.js'

const FACTURES_BASE_ID  = 'appB4Fehk9jYd4s4B'
const FACTURES_TABLE_ID = 'tblEfH4UV8hm0YHkG'

function firstLinked(fields, name) {
  const v = fields?.[name]
  return Array.isArray(v) && v.length ? v[0] : null
}

// Cherche une facture ERP correspondant à ce numéro de document Stripe.
// Retourne null si aucune facture (pas de Stripe → on ignore).
function findStripeFactureByDocNumber(documentNumber) {
  if (!documentNumber) return null
  return db.prepare(`
    SELECT id, project_id, order_id
    FROM factures
    WHERE document_number = ? AND invoice_id LIKE 'in_%'
    LIMIT 1
  `).get(documentNumber) || null
}

// Applique les liens Projet/Commande d'un record Airtable à la facture ERP
// correspondante, dans le respect des règles ci-dessus.
// Retourne 'set-project' | 'set-order' | 'no-stripe-match' | 'already-linked' | 'no-airtable-link'.
function applyLink(record) {
  const documentNumber = record.fields?.['Numéro de document']
  if (!documentNumber) return 'no-document-number'

  const facture = findStripeFactureByDocNumber(documentNumber)
  if (!facture) return 'no-stripe-match'
  if (facture.project_id || facture.order_id) return 'already-linked'

  const projAt = firstLinked(record.fields, 'Projet')
  const cmdAt  = firstLinked(record.fields, 'Commande')

  if (projAt) {
    const proj = db.prepare('SELECT id FROM projects WHERE airtable_id=? LIMIT 1').get(projAt)
    if (!proj) return 'project-not-found-in-erp'
    db.prepare(`UPDATE factures SET project_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
      .run(proj.id, facture.id)
    return 'set-project'
  }
  if (cmdAt) {
    const order = db.prepare('SELECT id FROM orders WHERE airtable_id=? LIMIT 1').get(cmdAt)
    if (!order) return 'order-not-found-in-erp'
    db.prepare(`UPDATE factures SET order_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
      .run(order.id, facture.id)
    return 'set-order'
  }
  return 'no-airtable-link'
}

// Webhook entry-point : reçoit { recordIds, destroyedIds } pour la table factures
// et n'agit que sur les records modifiés.
export async function syncFactureLinksFromWebhook(changes) {
  const tableChanges = changes?.[FACTURES_TABLE_ID]
  const recordIds = tableChanges?.recordIds
  if (!recordIds?.length) return { processed: 0 }

  const token = await getAccessToken()
  // Airtable filterByFormula RECORD_ID() — on récupère uniquement les fields utiles
  const formula = `OR(${recordIds.map(id => `RECORD_ID()='${id}'`).join(',')})`
  const url = `/${FACTURES_BASE_ID}/${FACTURES_TABLE_ID}`
    + `?fields[]=Numéro de document&fields[]=Projet&fields[]=Commande`
    + `&filterByFormula=${encodeURIComponent(formula)}`
    + `&pageSize=100`
  const data = await airtableFetch(url, token)

  const counts = {}
  db.transaction((records) => {
    for (const rec of records) {
      const result = applyLink(rec)
      counts[result] = (counts[result] || 0) + 1
    }
  })(data.records)

  const linked = (counts['set-project'] || 0) + (counts['set-order'] || 0)
  if (linked > 0) console.log(`🔗 Factures: ${linked} lien(s) projet/commande mis à jour via webhook`, counts)
  return { processed: data.records.length, ...counts }
}

// Backfill : passe sur toutes les factures ERP sans lien et tente d'en poser un
// depuis Airtable. Retourne les compteurs détaillés (dry-run friendly via apply).
export async function backfillFactureLinks({ apply = false } = {}) {
  const candidates = db.prepare(`
    SELECT id, airtable_id, document_number
    FROM factures
    WHERE project_id IS NULL AND order_id IS NULL
      AND airtable_id IS NOT NULL
      AND invoice_id LIKE 'in_%'
  `).all()

  if (!candidates.length) return { candidates: 0 }

  const token = await getAccessToken()
  const records = new Map()
  for (let i = 0; i < candidates.length; i += 50) {
    const slice = candidates.slice(i, i + 50)
    const formula = `OR(${slice.map(c => `RECORD_ID()='${c.airtable_id}'`).join(',')})`
    const url = `/${FACTURES_BASE_ID}/${FACTURES_TABLE_ID}`
      + `?fields[]=Numéro de document&fields[]=Projet&fields[]=Commande`
      + `&filterByFormula=${encodeURIComponent(formula)}`
      + `&pageSize=100`
    const data = await airtableFetch(url, token)
    for (const r of data.records) records.set(r.id, r)
  }

  const counts = { candidates: candidates.length, fetched: records.size }
  const actions = []

  const run = (records) => {
    for (const c of candidates) {
      const at = records.get(c.airtable_id)
      if (!at) { counts['airtable-record-missing'] = (counts['airtable-record-missing'] || 0) + 1; continue }
      const result = apply ? applyLink(at) : previewLink(at, c)
      counts[result] = (counts[result] || 0) + 1
      if (result === 'set-project' || result === 'set-order' || result === 'would-set-project' || result === 'would-set-order') {
        actions.push({ doc: c.document_number, factureId: c.id, action: result })
      }
    }
  }

  if (apply) db.transaction(run)(records)
  else run(records)

  return { ...counts, actions }
}

// Variante dry-run de applyLink — retourne ce qu'on ferait sans rien écrire.
function previewLink(record, facture) {
  const documentNumber = record.fields?.['Numéro de document']
  if (!documentNumber) return 'no-document-number'
  const stripeFacture = findStripeFactureByDocNumber(documentNumber)
  if (!stripeFacture) return 'no-stripe-match'
  if (stripeFacture.project_id || stripeFacture.order_id) return 'already-linked'

  const projAt = firstLinked(record.fields, 'Projet')
  const cmdAt  = firstLinked(record.fields, 'Commande')
  if (projAt) {
    const proj = db.prepare('SELECT id FROM projects WHERE airtable_id=? LIMIT 1').get(projAt)
    return proj ? 'would-set-project' : 'project-not-found-in-erp'
  }
  if (cmdAt) {
    const order = db.prepare('SELECT id FROM orders WHERE airtable_id=? LIMIT 1').get(cmdAt)
    return order ? 'would-set-order' : 'order-not-found-in-erp'
  }
  return 'no-airtable-link'
}
