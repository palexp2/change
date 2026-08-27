// Réaligne sur QuickBooks les recharges de crédit Twilio DÉJÀ publiées :
//   • libellé court dans le mémo (PrivateNote) ET sur la description de la ligne,
//     au lieu de la phrase de provenance verbeuse d'origine ;
//   • PaymentType 'Cash' → la transaction est une DÉPENSE dans QBO, pas un CHÈQUE
//     (ce que produisait PaymentType 'Check'), comme toutes les recharges Twilio
//     précédentes (Purchase 17202/17410/17530/17604/17711).
//
//   node src/scripts/fix-twilio-recharge-qb.js            # dry-run, dernière recharge
//   node src/scripts/fix-twilio-recharge-qb.js --apply
//   node src/scripts/fix-twilio-recharge-qb.js --all --apply
//   node src/scripts/fix-twilio-recharge-qb.js --repush --apply   # + conversion chèque → dépense
//
// GOTCHA QuickBooks : un CHÈQUE ne peut pas être converti en DÉPENSE par update.
// Le POST /purchase avec PaymentType 'Cash' sur une transaction 'Check' échoue en
// 400 code 610 « Objet introuvable / made inactive » — message trompeur, tous les
// comptes et fournisseurs référencés sont actifs (le MÊME corps avec 'Check' passe).
// Seule issue : supprimer la transaction et la republier (--repush), ce qui lui
// donne un NOUVEL Id QuickBooks.
//
// Le sparse update ne touche QUE PaymentType, le mémo et la Description des lignes :
// montants, comptes, taxes et date sont recopiés tels quels, total revérifié après coup.
import 'dotenv/config'
import db from '../db/database.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'
import { TWILIO_RECHARGE_DESCRIPTION } from '../services/prepaid.js'
import { pushAchatToQB } from '../services/quickbooks.js'

const APPLY = process.argv.includes('--apply')
const ALL = process.argv.includes('--all')
const REPUSH = process.argv.includes('--repush')

// PaymentType attendu et libellé ERP correspondant (QB_PAYMENT_METHOD / PAYMENT_TYPE_MAP).
const QB_PAYMENT_TYPE = 'Cash'
const ERP_PAYMENT_METHOD = 'Comptant'

// Les recharges détectées automatiquement sont celles adossées à une transaction
// bancaire appariée ET à une entrée « recharge » du ledger prépayé — les dépenses
// Twilio importées de QB (sans transaction bancaire) ne sont pas concernées.
const rows = db.prepare(`
  SELECT DISTINCT a.id, a.date_achat, a.description, a.total_cad, a.quickbooks_id
  FROM achats_fournisseurs a
  JOIN bank_transactions t ON t.matched_type='achat' AND t.matched_id = a.id
  JOIN prepaid_ledger_entries e ON e.bank_transaction_id = t.id AND e.type='recharge' AND e.deleted_at IS NULL
  WHERE a.type='purchase' AND a.quickbooks_id IS NOT NULL
  ORDER BY a.date_achat DESC
`).all()

const targets = ALL ? rows : rows.slice(0, 1)
if (!targets.length) {
  console.log('Aucune recharge Twilio publiée à corriger.')
  process.exit(0)
}

for (const row of targets) {
  console.log(`\n— Achat ${row.id} · ${row.date_achat} · ${row.total_cad} · QB Purchase ${row.quickbooks_id}`)
  console.log(`  ERP description : « ${row.description} »`)

  let txn
  try {
    txn = (await qbGet(`/purchase/${row.quickbooks_id}`))?.Purchase
  } catch (e) {
    console.error(`  ✗ lecture QB : ${e.message}`)
    continue
  }
  if (!txn) { console.error('  ✗ transaction QB introuvable'); continue }

  console.log(`  QB PaymentType  : ${txn.PaymentType} ${txn.PaymentType === QB_PAYMENT_TYPE ? '' : `→ ${QB_PAYMENT_TYPE}`}`)
  console.log(`  QB memo         : « ${txn.PrivateNote || ''} »`)
  txn.Line?.forEach((l, i) => console.log(`  QB ligne ${i}      : « ${l.Description || ''} » (${l.Amount})`))

  if (!APPLY) { console.log('  (dry-run — relancer avec --apply)'); continue }

  // Chèque → dépense : impossible par update (voir GOTCHA en tête de fichier).
  // On supprime et on republie via le chemin normal (pushAchatToQB), qui applique
  // le mode de paiement, le mémo et la description à jour.
  if (txn.PaymentType !== QB_PAYMENT_TYPE) {
    if (!REPUSH) {
      console.warn(`  ⚠️  PaymentType ${txn.PaymentType} ≠ ${QB_PAYMENT_TYPE} — relancer avec --repush pour supprimer et republier`)
    } else {
      try {
        await qbPost('/purchase?operation=delete', { Id: txn.Id, SyncToken: txn.SyncToken })
        console.log(`  ✓ Purchase ${txn.Id} supprimé de QuickBooks`)
      } catch (e) {
        console.error(`  ✗ suppression QB : ${e.message}`)
        continue
      }
      db.prepare(`
        UPDATE achats_fournisseurs SET quickbooks_id=NULL, description=?, qb_memo=?, payment_method=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?
      `).run(TWILIO_RECHARGE_DESCRIPTION, TWILIO_RECHARGE_DESCRIPTION, ERP_PAYMENT_METHOD, row.id)
      const newId = await pushAchatToQB(row.id)
      const created = (await qbGet(`/purchase/${newId}`))?.Purchase
      console.log(`  ✓ republié — Purchase ${newId}, PaymentType ${created?.PaymentType}, total ${created?.TotalAmt}`)
      console.log(`    memo « ${created?.PrivateNote || ''} » · ligne « ${created?.Line?.[0]?.Description || ''} »`)
      if (Number(created?.TotalAmt) !== Number(txn.TotalAmt)) console.warn('  ⚠️  TOTAL MODIFIÉ — à vérifier dans QuickBooks')
    }
    continue
  }

  const lines = (txn.Line || []).map(l => (
    l.DetailType === 'AccountBasedExpenseLineDetail'
      ? { ...l, Description: TWILIO_RECHARGE_DESCRIPTION }
      : l
  ))
  const body = {
    Id: txn.Id,
    SyncToken: txn.SyncToken,
    sparse: true,
    TxnDate: txn.TxnDate,
    ...(txn.CurrencyRef ? { CurrencyRef: txn.CurrencyRef } : {}),
    ...(txn.ExchangeRate ? { ExchangeRate: txn.ExchangeRate } : {}),
    PaymentType: QB_PAYMENT_TYPE,
    ...(txn.Credit ? { Credit: txn.Credit } : {}),
    ...(txn.AccountRef ? { AccountRef: txn.AccountRef } : {}),
    ...(txn.EntityRef ? { EntityRef: txn.EntityRef } : {}),
    ...(txn.GlobalTaxCalculation ? { GlobalTaxCalculation: txn.GlobalTaxCalculation } : {}),
    ...(txn.TxnTaxDetail ? { TxnTaxDetail: txn.TxnTaxDetail } : {}),
    PrivateNote: TWILIO_RECHARGE_DESCRIPTION,
    Line: lines,
  }
  try {
    const after = (await qbPost('/purchase', body))?.Purchase
    console.log(`  ✓ QB mis à jour — total ${after?.TotalAmt} (avant ${txn.TotalAmt}), PaymentType ${after?.PaymentType}`)
    if (Number(after?.TotalAmt) !== Number(txn.TotalAmt)) console.warn('  ⚠️  TOTAL MODIFIÉ — à vérifier dans QuickBooks')
    if (after?.PaymentType !== QB_PAYMENT_TYPE) console.warn(`  ⚠️  PaymentType toujours ${after?.PaymentType} — QB a refusé le changement de type`)
  } catch (e) {
    console.error(`  ✗ écriture QB : ${e.message}`)
    continue
  }

  db.prepare(`
    UPDATE achats_fournisseurs SET description=?, qb_memo=?, payment_method=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?
  `).run(TWILIO_RECHARGE_DESCRIPTION, TWILIO_RECHARGE_DESCRIPTION, ERP_PAYMENT_METHOD, row.id)
  console.log('  ✓ description + mémo + mode de paiement ERP alignés')
}
