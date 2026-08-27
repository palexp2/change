// Backfill « période de service » sur les reçus/factures déjà extraits.
//
// Les factures d'abonnement extraites avant l'arrivée du moteur de période (ou dont
// l'IA n'a rien rempli) sont en base sans `service_period` — et celles déjà publiées
// dans QuickBooks y sont sans période dans le mémo ni dans les lignes. Ce script
// rejoue le moteur déterministe (servicePeriod.js) sur l'historique.
//
//   node src/scripts/backfill-service-period.js                 # rapport seul (dry-run)
//   node src/scripts/backfill-service-period.js --apply         # écrit dans l'ERP
//   node src/scripts/backfill-service-period.js --apply --qb    # + corrige QuickBooks
//   node src/scripts/backfill-service-period.js --apply --qb --id=<receiptId>
//
// La correction QuickBooks est un sparse update de la transaction : descriptions de
// lignes et mémo réécrits avec la période, montants et taxes INCHANGÉS.

import db from '../db/database.js'
import { resolveServicePeriod, annotateItemsWithPeriod, annotateDescriptionWithPeriod } from '../services/servicePeriod.js'
import { buildReceiptMemo } from '../services/quickbooks.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'

const APPLY = process.argv.includes('--apply')
const WITH_QB = process.argv.includes('--qb')
const ONLY_ID = (process.argv.find(a => a.startsWith('--id=')) || '').slice(5) || null

const rows = db.prepare(`
  SELECT * FROM sale_receipts
  WHERE deleted_at IS NULL AND status = 'done'
    AND (service_period IS NULL OR TRIM(service_period) = '')
    ${ONLY_ID ? 'AND id = ?' : ''}
  ORDER BY receipt_date DESC
`).all(...(ONLY_ID ? [ONLY_ID] : []))

console.log(`${rows.length} reçu(s) sans période à évaluer${APPLY ? '' : ' (dry-run)'}\n`)

const ENTITY = { bill: 'Bill', purchase: 'Purchase', cc_credit: 'Purchase' }

let found = 0
for (const rec of rows) {
  let items = []
  try { items = JSON.parse(rec.items || '[]') } catch {}
  // Factures de transport : ponctuelles par nature, jamais de période.
  try {
    const raw = JSON.parse(rec.raw_data || '{}')
    if (Array.isArray(raw.shipments) && raw.shipments.some(s => s && Number(s.total))) continue
  } catch {}

  const { period, source } = resolveServicePeriod({ ...rec, items })
  if (!period) continue
  found++
  const description = annotateDescriptionWithPeriod(rec.general_description, period)
  const annotated = annotateItemsWithPeriod(items, period)
  const published = rec.quickbooks_id ? ` [QB ${rec.quickbooks_type || 'purchase'} ${rec.quickbooks_id}]` : ''
  console.log(`${rec.receipt_date || '????-??-??'}  ${rec.company || '?'} — « ${period} » (${source})${published}`)
  console.log(`    ${rec.general_description || '(sans description)'}  →  ${description}`)

  if (!APPLY) continue

  db.prepare(`
    UPDATE sale_receipts SET service_period=?, general_description=?, items=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=? AND deleted_at IS NULL
  `).run(period, description, JSON.stringify(annotated), rec.id)

  if (!WITH_QB || !rec.quickbooks_id) continue
  const entity = ENTITY[rec.quickbooks_type] || 'Purchase'
  try {
    const res = await qbGet(`/${entity.toLowerCase()}/${rec.quickbooks_id}`)
    const txn = res[entity]
    if (!txn) throw new Error('transaction introuvable')
    // Descriptions de lignes : même filet que côté ERP, ligne par ligne. Les montants,
    // comptes et codes de taxe sont recopiés tels quels — on ne touche QUE le libellé.
    const lines = (txn.Line || []).map(l => {
      const d = annotateDescriptionWithPeriod(l.Description, period)
      return d && d !== l.Description ? { ...l, Description: d } : l
    })
    const memo = buildReceiptMemo(rec.memo, description, annotated, period)
    const body = {
      Id: txn.Id,
      SyncToken: txn.SyncToken,
      sparse: true,
      TxnDate: txn.TxnDate,
      ...(txn.CurrencyRef ? { CurrencyRef: txn.CurrencyRef } : {}),
      ...(txn.ExchangeRate ? { ExchangeRate: txn.ExchangeRate } : {}),
      ...(txn.PaymentType ? { PaymentType: txn.PaymentType } : {}),
      ...(txn.Credit ? { Credit: txn.Credit } : {}),
      ...(txn.AccountRef ? { AccountRef: txn.AccountRef } : {}),
      ...(txn.VendorRef ? { VendorRef: txn.VendorRef } : {}),
      ...(txn.EntityRef ? { EntityRef: txn.EntityRef } : {}),
      ...(txn.APAccountRef ? { APAccountRef: txn.APAccountRef } : {}),
      ...(txn.GlobalTaxCalculation ? { GlobalTaxCalculation: txn.GlobalTaxCalculation } : {}),
      ...(txn.TxnTaxDetail ? { TxnTaxDetail: txn.TxnTaxDetail } : {}),
      PrivateNote: memo,
      Line: lines,
    }
    const updated = await qbPost(`/${entity.toLowerCase()}`, body)
    const after = updated[entity]
    console.log(`    QB ${entity} ${rec.quickbooks_id} mis à jour — total ${after?.TotalAmt} (avant ${txn.TotalAmt})`)
    if (Number(after?.TotalAmt) !== Number(txn.TotalAmt)) {
      console.warn('    ⚠️  TOTAL MODIFIÉ — à vérifier dans QuickBooks')
    }
  } catch (e) {
    console.error(`    ✗ QB ${entity} ${rec.quickbooks_id} : ${e.message}`)
  }
}

console.log(`\n${found} période(s) ${APPLY ? 'appliquée(s)' : 'trouvée(s)'} sur ${rows.length} reçu(s) examiné(s).`)
process.exit(0)
