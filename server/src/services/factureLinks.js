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

// Noms des champs Airtable — configurables via la modale « Mapping Airtable »
// sur /factures (field_map de airtable_module_config, module='factures',
// seedé dans schema.js). Les défauts reproduisent les noms historiques.
const DEFAULT_FIELD_MAP = {
  document_number: 'Numéro de document',
  project: 'Projet',
  order: 'Commande',
}
function getFieldMap() {
  try {
    const row = db.prepare("SELECT field_map FROM airtable_module_config WHERE module='factures'").get()
    const saved = row?.field_map ? JSON.parse(row.field_map) : {}
    const map = { ...DEFAULT_FIELD_MAP }
    for (const k of Object.keys(DEFAULT_FIELD_MAP)) {
      if (typeof saved[k] === 'string' && saved[k]) map[k] = saved[k]
    }
    return map
  } catch {
    return { ...DEFAULT_FIELD_MAP }
  }
}

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

// ── Jumeau Airtable d'une facture (factures.airtable_id) ─────────────────────
//
// Depuis le débranchement du sync complet (avril 2026), plus rien ne posait
// `airtable_id` sur les factures nées dans Stripe : le write-back les sautait
// (« record non lié ») et un champ réglé Boréal → Airtable ne partait jamais.
// Le lien se pose par le numéro de document, seulement s'il est sans ambiguïté :
// une seule facture ERP porte ce numéro, et aucune autre n'a déjà ce record.
export function linkFactureAirtableId(documentNumber, recordId) {
  if (!documentNumber || !recordId) return false
  const rows = db.prepare('SELECT id, airtable_id FROM factures WHERE document_number=?').all(documentNumber)
  if (rows.length !== 1 || rows[0].airtable_id) return false
  if (db.prepare('SELECT 1 FROM factures WHERE airtable_id=?').get(recordId)) return false
  db.prepare('UPDATE factures SET airtable_id=? WHERE id=?').run(recordId, rows[0].id)
  return rows[0].id
}

const formulaString = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

// Records Airtable portant ces numéros de document (par lots de 50).
async function fetchByDocumentNumbers(docNumbers, fieldMap = getFieldMap()) {
  const token = await getAccessToken()
  const out = []
  for (let i = 0; i < docNumbers.length; i += 50) {
    const slice = docNumbers.slice(i, i + 50)
    const formula = `OR(${slice.map(d => `{${fieldMap.document_number}}=${formulaString(d)}`).join(',')})`
    let offset = null
    do {
      const url = `/${FACTURES_BASE_ID}/${FACTURES_TABLE_ID}`
        + `?fields[]=${encodeURIComponent(fieldMap.document_number)}`
        + `&filterByFormula=${encodeURIComponent(formula)}&pageSize=100`
        + (offset ? `&offset=${encodeURIComponent(offset)}` : '')
      const data = await airtableFetch(url, token)
      out.push(...(data.records || []))
      offset = data.offset || null
    } while (offset)
  }
  return out
}

// Pose les liens d'une liste de records : un numéro présent deux fois côté
// Airtable reste non lié (ambigu).
function linkRecords(records, fieldMap) {
  const byDoc = new Map()
  for (const r of records) {
    const doc = r.fields?.[fieldMap.document_number]
    if (doc) byDoc.set(doc, byDoc.has(doc) ? null : r.id)
  }
  let linked = 0
  db.transaction(() => {
    for (const [doc, recId] of byDoc) if (recId && linkFactureAirtableId(doc, recId)) linked++
  })()
  return linked
}

// Résolution à la demande (write-back d'une facture encore non liée).
export async function resolveFactureAirtableId(row) {
  if (row?.airtable_id) return row.airtable_id
  if (!row?.document_number) return null
  const fieldMap = getFieldMap()
  linkRecords(await fetchByDocumentNumbers([row.document_number], fieldMap), fieldMap)
  return db.prepare('SELECT airtable_id FROM factures WHERE id=?').get(row.id)?.airtable_id || null
}

// Rattrapage : toutes les factures sans jumeau Airtable.
export async function backfillFactureAirtableIds() {
  const docs = db.prepare(`
    SELECT document_number FROM factures
    WHERE airtable_id IS NULL AND document_number IS NOT NULL AND document_number <> ''
    GROUP BY document_number HAVING COUNT(*) = 1
  `).all().map(r => r.document_number)
  if (!docs.length) return { candidates: 0, linked: 0 }
  const fieldMap = getFieldMap()
  const records = await fetchByDocumentNumbers(docs, fieldMap)
  return { candidates: docs.length, fetched: records.length, linked: linkRecords(records, fieldMap) }
}

// Applique les liens Projet/Commande d'un record Airtable à la facture ERP
// correspondante, dans le respect des règles ci-dessus.
// Retourne 'set-project' | 'set-order' | 'no-stripe-match' | 'already-linked' | 'no-airtable-link'.
function applyLink(record, fieldMap = getFieldMap()) {
  const documentNumber = record.fields?.[fieldMap.document_number]
  if (!documentNumber) return 'no-document-number'
  // Toute facture vue passer au webhook reçoit son jumeau Airtable.
  linkFactureAirtableId(documentNumber, record.id)

  const facture = findStripeFactureByDocNumber(documentNumber)
  if (!facture) return 'no-stripe-match'
  if (facture.project_id || facture.order_id) return 'already-linked'

  const projAt = firstLinked(record.fields, fieldMap.project)
  const cmdAt  = firstLinked(record.fields, fieldMap.order)

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
  const fieldMap = getFieldMap()
  // Airtable filterByFormula RECORD_ID() — on récupère uniquement les fields utiles
  const formula = `OR(${recordIds.map(id => `RECORD_ID()='${id}'`).join(',')})`
  const url = `/${FACTURES_BASE_ID}/${FACTURES_TABLE_ID}`
    + `?fields[]=${encodeURIComponent(fieldMap.document_number)}&fields[]=${encodeURIComponent(fieldMap.project)}&fields[]=${encodeURIComponent(fieldMap.order)}`
    + `&filterByFormula=${encodeURIComponent(formula)}`
    + `&pageSize=100`
  const data = await airtableFetch(url, token)

  const counts = {}
  db.transaction((records) => {
    for (const rec of records) {
      const result = applyLink(rec, fieldMap)
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
  const fieldMap = getFieldMap()
  const records = new Map()
  for (let i = 0; i < candidates.length; i += 50) {
    const slice = candidates.slice(i, i + 50)
    const formula = `OR(${slice.map(c => `RECORD_ID()='${c.airtable_id}'`).join(',')})`
    const url = `/${FACTURES_BASE_ID}/${FACTURES_TABLE_ID}`
      + `?fields[]=${encodeURIComponent(fieldMap.document_number)}&fields[]=${encodeURIComponent(fieldMap.project)}&fields[]=${encodeURIComponent(fieldMap.order)}`
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
      const result = apply ? applyLink(at, fieldMap) : previewLink(at, fieldMap)
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
function previewLink(record, fieldMap = getFieldMap()) {
  const documentNumber = record.fields?.[fieldMap.document_number]
  if (!documentNumber) return 'no-document-number'
  const stripeFacture = findStripeFactureByDocNumber(documentNumber)
  if (!stripeFacture) return 'no-stripe-match'
  if (stripeFacture.project_id || stripeFacture.order_id) return 'already-linked'

  const projAt = firstLinked(record.fields, fieldMap.project)
  const cmdAt  = firstLinked(record.fields, fieldMap.order)
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
