// Rapprochement encaissement de la subvention salariale (Biotalent, Louis-
// Bernard) : la provision mensuelle accrue (Dr 12400 « Subventions à recevoir »
// / Cr 49000 « Subventions ») est une ESTIMATION (60 % du salaire brut, voir
// monthEnd.js). Le montant réellement versé par Biotalent peut différer —
// c'est fréquent avec ce type de subvention gouvernementale, sujette à
// approbation. Deux volets, demandés par Charles le 2026-08-09 :
//
//   1. Suivre ce qui est réellement encaissé (ledger simple : date, montant,
//      note) — indépendant du calendrier des provisions, une entrée par
//      versement de Biotalent.
//   2. Visualiser l'écart cumulatif entre ce qui a été comptabilisé comme
//      recevable (somme des mois PUBLIÉS de la provision) et ce qui a été
//      réellement reçu, puis « régulariser » cet écart par une écriture
//      Dr/Cr 12400 ↔ 49000 qui vide la créance et ajuste le revenu constaté —
//      jamais automatique, un bouton dédié.
//   3. Détecter automatiquement les versements dans le rapprochement bancaire
//      (2026-08-09, suite à la demande de Charles) : `config.bank_match_label`
//      de la provision (ex. « Biotalent ») est comparé au libellé de chaque
//      transaction bancaire créditrice via le même matching que les fournisseurs
//      (labelMatchesVendor). Une correspondance crée une ligne source='banque'
//      liée à la transaction (bank_transaction_id, UNIQUE) — jamais deux fois la
//      même, et une ligne supprimée (faux positif) n'est jamais recréée par un
//      passage ultérieur. Déclenché à chaque import bancaire (collage ou sync
//      horaire TRX_Orisha, voir bankReconciliation.js) + bouton manuel.
//
// Hypothèse (à confirmer avec Charles) : le dépôt bancaire réel de la
// subvention est catégorisé au compte 12400 par ailleurs (rapprochement
// bancaire) — cette régularisation ne touche donc pas de compte de banque,
// uniquement le couple créance/revenu, pour le SEUL écart estimation ↔ réel.
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { qbPost } from '../connectors/quickbooks.js'
import { resolveAccountByAcctNum } from './quickbooks.js'
import { logSync } from './syncLog.js'
import { getProvision, listProvisions, lastDayOfMonth } from './monthEnd.js'
import { round2Safe as round2 } from '../utils/money.js'

const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))
const today = () => new Date().toISOString().slice(0, 10)

// Copie locale de bankReconciliation.js:labelMatchesVendor — un import croisé
// avec bankReconciliation.js (qui appelle detectBankReceipts ci-dessous après
// chaque import bancaire) créerait un cycle ESM entre les deux modules.
function normalizeLabel(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}
function labelMatches(bankLabel, targetLabel) {
  const label = normalizeLabel(bankLabel)
  if (!label) return false
  const tokens = normalizeLabel(targetLabel).split(' ').filter(t => t.length >= 3)
  if (tokens.length && tokens.every(t => label.includes(t))) return true
  const compact = tokens.join('')
  return compact.length >= 5 && label.replace(/ /g, '').includes(compact)
}

export function listReceipts(provisionId) {
  return db.prepare(`
    SELECT * FROM wage_subsidy_receipts WHERE provision_id = ? AND deleted_at IS NULL
    ORDER BY received_date, created_at
  `).all(provisionId)
}

export function addReceipt(provisionId, { received_date, amount, note } = {}, userId = null) {
  if (!getProvision(provisionId)) throw new Error('Provision introuvable')
  if (!isDate(received_date)) throw new Error('received_date invalide (YYYY-MM-DD)')
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) throw new Error('amount doit être un nombre positif')
  const id = randomUUID()
  db.prepare(`
    INSERT INTO wage_subsidy_receipts (id, provision_id, received_date, amount, note, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(id, provisionId, received_date, round2(n), note || null, userId)
  return db.prepare('SELECT * FROM wage_subsidy_receipts WHERE id = ?').get(id)
}

export function updateReceipt(id, patch = {}) {
  const existing = db.prepare('SELECT * FROM wage_subsidy_receipts WHERE id = ? AND deleted_at IS NULL').get(id)
  if (!existing) throw new Error('Réception introuvable')
  const fields = []
  const values = []
  if (patch.received_date !== undefined) {
    if (!isDate(patch.received_date)) throw new Error('received_date invalide (YYYY-MM-DD)')
    fields.push('received_date = ?'); values.push(patch.received_date)
  }
  if (patch.amount !== undefined) {
    const n = Number(patch.amount)
    if (!Number.isFinite(n) || n <= 0) throw new Error('amount doit être un nombre positif')
    fields.push('amount = ?'); values.push(round2(n))
  }
  if (patch.note !== undefined) { fields.push('note = ?'); values.push(patch.note || null) }
  if (!fields.length) return existing
  fields.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
  db.prepare(`UPDATE wage_subsidy_receipts SET ${fields.join(', ')} WHERE id = ?`).run(...values, id)
  return db.prepare('SELECT * FROM wage_subsidy_receipts WHERE id = ?').get(id)
}

export function deleteReceipt(id) {
  db.prepare(`UPDATE wage_subsidy_receipts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(id)
}

// ── Détection automatique depuis le rapprochement bancaire ──────────────────

// Transactions créditrices déjà vues pour CETTE provision (peu importe si la
// ligne a depuis été supprimée à la main — un faux positif rejeté ne doit
// jamais revenir au passage suivant).
function seenBankTxnIds(provisionId) {
  return new Set(db.prepare(`
    SELECT bank_transaction_id FROM wage_subsidy_receipts
    WHERE provision_id = ? AND bank_transaction_id IS NOT NULL
  `).all(provisionId).map(r => r.bank_transaction_id))
}

// Scanne bank_transactions pour UNE provision dont `config.bank_match_label`
// est renseigné. Retourne les lignes insérées (source='banque').
//
// Le libellé à comparer n'est PAS forcément `description` : pour les comptes
// alimentés par la sync TRX_Orisha (services/bankTrxSheet.js), `description`
// n'est qu'un code de catégorie générique du relevé BNC (« COMPTES DEBITEURS »,
// « COMPTE DIVERS »…) et le nom de la contrepartie (« BIOTALENT CANAD ») vit
// dans `details`. Même convention que le reste du module de rapprochement
// bancaire : `COALESCE(NULLIF(details,''), description)` (voir bankTrxSheet.js).
function detectBankReceiptsForProvision(provision) {
  const label = String(provision.config?.bank_match_label || '').trim()
  if (!label) return []
  const seen = seenBankTxnIds(provision.id)
  const candidates = db.prepare(`
    SELECT id, txn_date, amount, COALESCE(NULLIF(details, ''), description) AS label
    FROM bank_transactions
    WHERE deleted_at IS NULL AND amount > 0 AND COALESCE(NULLIF(details, ''), description) IS NOT NULL
  `).all()
  const inserted = []
  for (const txn of candidates) {
    if (seen.has(txn.id)) continue
    if (!labelMatches(txn.label, label)) continue
    const id = randomUUID()
    try {
      db.prepare(`
        INSERT INTO wage_subsidy_receipts
          (id, provision_id, received_date, amount, note, source, bank_transaction_id)
        VALUES (?,?,?,?,?,'banque',?)
      `).run(id, provision.id, txn.txn_date, round2(txn.amount), `Détecté dans le relevé — ${txn.label}`, txn.id)
      inserted.push(db.prepare('SELECT * FROM wage_subsidy_receipts WHERE id = ?').get(id))
    } catch (e) {
      // Contrainte UNIQUE sur bank_transaction_id : une course avec un autre
      // appel (import concurrent) a déjà inséré cette transaction — ignorer.
      if (!String(e.message).includes('UNIQUE')) throw e
    }
  }
  return inserted
}

// Scanne toutes les provisions wage_subsidy configurées (ou une seule, en
// argument), sans jamais lancer d'erreur — appelé après chaque import bancaire
// (collage manuel ou sync horaire TRX_Orisha), ne doit jamais faire échouer
// l'import qui le déclenche.
export function detectBankReceipts(provisionId = null) {
  const provisions = (provisionId ? [getProvision(provisionId)] : listProvisions({ includeInactive: false }))
    .filter(p => p && p.kind === 'wage_subsidy')
  const inserted = []
  for (const p of provisions) {
    try {
      inserted.push(...detectBankReceiptsForProvision(p))
    } catch (e) {
      console.error(`wageSubsidyReceipts.detectBankReceipts (${p.id}):`, e.message)
    }
  }
  return inserted
}

// Somme de ce qui a été réellement PUBLIÉ dans QuickBooks pour cette provision
// (mois marqués pushed_at) — c'est ce montant, pas le calcul du mois affiché à
// l'écran, qui a effectivement mouvementé le compte 12400.
function cumulativeProvisioned(provisionId) {
  return round2(db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM month_end_provision_months
    WHERE provision_id = ? AND pushed_at IS NOT NULL AND deleted_at IS NULL
  `).get(provisionId)?.s || 0)
}

function cumulativeReceived(provisionId) {
  return round2(db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM wage_subsidy_receipts
    WHERE provision_id = ? AND deleted_at IS NULL
  `).get(provisionId)?.s || 0)
}

function cumulativeRegularized(provisionId) {
  return round2(db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM wage_subsidy_adjustments
    WHERE provision_id = ? AND deleted_at IS NULL
  `).get(provisionId)?.s || 0)
}

// Écart encore à régulariser : ce qui a été accru (provisionné) moins ce qui a
// été réellement reçu, moins ce qui a déjà été régularisé par une écriture
// précédente. Positif = on a accru plus qu'on ne recevra (à écrire à la baisse
// contre le revenu) ; négatif = Biotalent a versé plus que l'estimation.
export function subsidyReconciliation(provisionId) {
  const provisioned = cumulativeProvisioned(provisionId)
  const received = cumulativeReceived(provisionId)
  const regularized = cumulativeRegularized(provisionId)
  return {
    provisioned, received, regularized,
    outstanding: round2(provisioned - received - regularized),
  }
}

// Publie l'écriture qui vide l'écart entre créance provisionnée et montant
// réellement reçu : Dr 49000 / Cr 12400 si on a accru plus que reçu (écart
// positif), sens inversé si Biotalent a versé plus que l'estimation.
export async function regularizeSubsidy(provisionId, { userId = null } = {}) {
  const provision = getProvision(provisionId)
  if (!provision) throw new Error('Provision introuvable')
  if (!provision.debit_acctnum || !provision.credit_acctnum) throw new Error('Comptes QuickBooks manquants sur la provision')

  const recon = subsidyReconciliation(provisionId)
  const amount = Math.abs(recon.outstanding)
  if (!(amount > 0.005)) throw new Error('Aucun écart à régulariser')

  const receivableId = await resolveAccountByAcctNum(provision.debit_acctnum)
  if (!receivableId) throw new Error(`Compte QB #${provision.debit_acctnum} introuvable`)
  const incomeId = await resolveAccountByAcctNum(provision.credit_acctnum)
  if (!incomeId) throw new Error(`Compte QB #${provision.credit_acctnum} introuvable`)

  const overAccrued = recon.outstanding > 0
  const description = `Régularisation ${provision.label} — accru ${recon.provisioned.toFixed(2)} $ / reçu ${recon.received.toFixed(2)} $`
  const je = {
    TxnDate: lastDayOfMonth(today().slice(0, 7)),
    PrivateNote: `${description} (ERP, rapprochement encaissement subvention)`,
    Line: [
      {
        DetailType: 'JournalEntryLineDetail',
        Amount: amount,
        Description: description,
        JournalEntryLineDetail: { PostingType: overAccrued ? 'Debit' : 'Credit', AccountRef: { value: incomeId } },
      },
      {
        DetailType: 'JournalEntryLineDetail',
        Amount: amount,
        Description: description,
        JournalEntryLineDetail: { PostingType: overAccrued ? 'Credit' : 'Debit', AccountRef: { value: receivableId } },
      },
    ],
  }
  const result = await qbPost('/journalentry', je)
  const jeId = result.JournalEntry?.Id
  if (!jeId) throw new Error("QB n'a pas retourné d'Id pour le JournalEntry")

  const id = randomUUID()
  db.prepare(`
    INSERT INTO wage_subsidy_adjustments (id, provision_id, amount, memo, qb_je_id, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(id, provisionId, recon.outstanding, description, String(jeId), userId)
  logSync('month_end', 'manual', { status: 'success', modified: 1 })
  return { qb_je_id: String(jeId), provision_id: provisionId, amount: recon.outstanding, adjustment_id: id }
}
