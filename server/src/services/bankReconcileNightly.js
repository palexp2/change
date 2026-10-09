// PASSE DE NUIT DU RAPPROCHEMENT — tous les comptes, chaque mois terminé.
//
// Charles (2026-10-06) : Boréal refait chaque nuit le tour que Claude a fait à
// la main, mais ne corrige SEUL que des cas sûrs à 100 %. Tout le reste est
// listé (journal de l'automation), jamais touché.
//
// Seul cas corrigé : la date QuickBooks d'un paiement ou d'un virement entre
// deux de NOS comptes, quand les deux relevés s'accordent sur une autre date
// (vécu : paiement Visa du 24 juillet inscrit au 25). Garde-fous :
//   - écriture unique, montant identique, dépense ou virement ;
//   - l'autre côté est une ligne de relevé (pas en attente) liée à la même
//     écriture, à la même date que celle-ci ;
//   - écart de 1 à 5 jours ;
//   - écriture pas encore rapprochée dans QuickBooks (« R ») : un mois fermé
//     ne se touche pas (Charles, même jour).
// Le montant, les comptes et les taxes ne changent jamais.
//
// Les lignes « total » d'un paiement déjà détaillé sont bloquées à l'import
// des relevés (findSumDuplicates) : la passe ne fait que les signaler.

import db from '../db/database.js'
import { qbGet, qbPost } from '../connectors/quickbooks.js'
import { reconcileSheet } from './bankReconcileSheet.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

export const NIGHTLY_AUTOMATION_ID = 'sys_bank_reconcile_nightly'
const SINCE = '2026-06'
const MAX_DRIFT_DAYS = 5
const daysApart = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5
const money = (n) => Number(n).toFixed(2).replace('.', ',')

function nightlyConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(NIGHTLY_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch { /* défaut */ }
  return { since: /^\d{4}-\d{2}$/.test(cfg.since || '') ? cfg.since : SINCE }
}

// L'autre côté de l'écriture : une ligne de relevé d'un autre de nos comptes.
function counterpart(accountId, qbId) {
  return db.prepare(`
    SELECT t.id, t.txn_date, a.name FROM bank_transactions t JOIN bank_accounts a ON a.id=t.account_id
    WHERE t.qb_txn_id=? AND t.account_id<>? AND t.deleted_at IS NULL AND COALESCE(t.pending,0)=0
  `).all(String(qbId), accountId)
}

const ENTITIES = { purchase: 'Purchase', transfer: 'Transfer' }

async function setQbDate(entity, id, date) {
  const name = ENTITIES[entity]
  const cur = (await qbGet(`/${entity}/${id}`))?.[name]
  if (!cur) throw new Error(`${entity} ${id} introuvable`)
  const body = { Id: cur.Id, SyncToken: cur.SyncToken, sparse: true, TxnDate: date }
  if (name === 'Purchase') Object.assign(body, { PaymentType: cur.PaymentType, AccountRef: cur.AccountRef })
  else Object.assign(body, { FromAccountRef: cur.FromAccountRef, ToAccountRef: cur.ToAccountRef, Amount: cur.Amount })
  await qbPost(`/${entity}`, body)
}

// `log: false` — la route « Exécuter » journalise déjà.
export async function runNightlyReconcile({ dryRun = false, trigger = 'planifie', force = false, log = true } = {}) {
  if (!force && !isSystemAutomationActive(NIGHTLY_AUTOMATION_ID)) return null
  const t0 = Date.now()
  const { since } = nightlyConfig()
  const current = new Date().toISOString().slice(0, 7)
  const accounts = db.prepare(`
    SELECT id, name FROM bank_accounts
    WHERE deleted_at IS NULL AND qb_account_id IS NOT NULL AND qb_account_id<>'' AND name NOT LIKE 'ZZ%'
    ORDER BY sort_order
  `).all()
  const fixed = []
  const review = []
  const done = new Set()
  try {
    for (const a of accounts) {
      let first
      try { first = await reconcileSheet(a.id) } catch (e) { review.push(`${a.name} : ${e.message}`); continue }
      for (const m of first.months.filter((x) => x.month >= since && x.month < current)) {
        const r = m.month === first.month ? first : await reconcileSheet(a.id, m.month)
        const before = fixed.length
        for (const row of r.rows) {
          const q = row.qb
          if (row.kind !== 'ok' || !q || !row.bank || q.date === row.bank.date) continue
          if (!ENTITIES[q.entity] || !q.qb_id || q.count !== 1 || q.cleared === 'R') continue
          if (Math.abs(Math.abs(q.amount) - Math.abs(row.bank.amount)) > 0.004) continue
          if (daysApart(q.date, row.bank.date) > MAX_DRIFT_DAYS || done.has(q.qb_id)) continue
          const other = counterpart(a.id, q.qb_id)
          if (other.length !== 1 || other[0].txn_date !== row.bank.date) continue
          done.add(q.qb_id)
          const what = `${a.name} ↔ ${other[0].name} : ${money(Math.abs(row.bank.amount))} $ du ${q.date} → ${row.bank.date}`
          try {
            if (!dryRun) await setQbDate(q.entity, q.qb_id, row.bank.date)
            fixed.push(what)
          } catch (e) { review.push(`${what} : non corrigée (${e.message})`) }
        }
        // Après correction, l'écart restant du mois est à regarder.
        const after = fixed.length > before && !dryRun ? await reconcileSheet(a.id, m.month) : r
        if (after.difference) review.push(`${a.name} ${m.month} : écart ${money(after.difference)} $`)
        const todo = after.rows.filter((x) => x.kind === 'bank' || x.kind === 'qb')
        if (todo.length) review.push(`${a.name} ${m.month} : ${todo.length} ligne(s) sans vis-à-vis`)
      }
    }
    const summary = `${dryRun ? 'Simulation — ' : ''}${fixed.length} date(s) corrigée(s) · ${review.length} point(s) à regarder`
    const result = { summary, fixed, review, since }
    if (log) logSystemRun(NIGHTLY_AUTOMATION_ID, { status: 'success', duration_ms: Date.now() - t0, result, triggerData: { trigger, dryRun } })
    return result
  } catch (e) {
    if (log) logSystemRun(NIGHTLY_AUTOMATION_ID, { status: 'error', duration_ms: Date.now() - t0, error: e, triggerData: { trigger, dryRun } })
    throw e
  }
}
