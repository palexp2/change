// Détection du « passé à la banque » depuis QuickBooks.
//
// Le bouton « Passé » de /paiements-emis était coché à la main, puis
// automatiquement par deux signaux indirects : l'appariement au relevé importé
// (autoClearFromBank) et la disparition d'une ligne du fichier « Maintien du
// solde disponible BNC » (treasurySoldeSheet). QuickBooks porte le signal
// DIRECT : le rapport GeneralLedger d'un compte bancaire expose une colonne
// `is_cleared` par écriture —
//   « C » = compensée : l'écriture a été appariée au flux bancaire, donc le
//           mouvement EST au compte ;
//   « R » = rapprochée : elle a en plus été validée dans un rapprochement ;
//   vide  = saisie dans QB mais jamais vue à la banque (chèque pas encore
//           encaissé, paiement post-daté).
// Constaté sur 2026 (compte BNC CAD) : 390 « R », 22 « C » et une seule vide —
// exactement le paiement post-daté Axxess du 14 août. Le signal discrimine donc
// vraiment, contrairement à « l'écriture existe dans QB » (elle existe dès la
// saisie, avant que l'argent bouge).
//
// PRUDENCE SUR L'APPARIEMENT : cocher à tort retire une sortie de la projection
// et masque un découvert. Le montant seul ne suffit pas — BTTH SERVICES
// MUTIPLES et Axxess International facturent tous deux 103,48 $, DBG et un
// autre fournisseur 50,00 $. On exige donc la concordance du NOM QB, sauf pour
// les mouvements internes (« Virement », sans nom chez QB) où l'on impose en
// échange le montant au cent près et une date très proche. Tout appariement qui
// n'atteint pas ce niveau est PROPOSÉ à l'utilisateur, jamais appliqué tout
// seul.
import db from '../db/database.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'
import { fetchQbLedgerCleared } from './bankQbLink.js'
import { logSync } from './syncLog.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { setCleared, createPayment } from './treasuryPayments.js'

export const QB_CLEAR_AUTOMATION_ID = 'sys_treasury_qb_clear'

export const QB_CLEAR_DEFAULT_CONFIG = {
  // Compte suivi par la projection : c'est lui dont on lit le grand livre QB.
  account_name: 'BNC CAD',
  // Écart de date toléré entre le paiement ERP et l'écriture QB (un Interac
  // émis le samedi est débité le lundi ; QB date parfois à la saisie).
  day_window: '6',
  // Profondeur d'historique lue quand aucun paiement en attente n'est plus
  // ancien (bornes réelles = plus vieux paiement en attente − day_window).
  lookback_days: '75',
  // 1 = les appariements sûrs (nom concordant) sont cochés automatiquement ;
  // 0 = tout est seulement proposé, l'utilisateur confirme sur la page.
  auto_apply: '1',
}

export function getQbClearConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(QB_CLEAR_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch { /* config illisible : défauts */ }
  const merged = { ...QB_CLEAR_DEFAULT_CONFIG }
  for (const k of Object.keys(QB_CLEAR_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

// ── Appariement (pur, testé dans treasuryQbClear.test.js) ────────────────────

const r2 = n => Math.round(Number(n) * 100) / 100
const dayOnly = v => String(v || '').slice(0, 10)
const vendorKey = s => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '')

const namesOverlap = (a, b) => {
  const ka = vendorKey(a), kb = vendorKey(b)
  if (!ka || !kb) return false
  if (ka.includes(kb) || kb.includes(ka)) return true
  // « BTTH SERVICES MUTIPLES » vs « BTTH Services multiples inc. » : un premier
  // mot significatif commun (≥ 4 caractères) suffit — les raisons sociales QB
  // et ERP divergent souvent sur le suffixe légal.
  const head = s => (String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().match(/[a-z0-9]{4,}/g) || [])[0]
  const ha = head(a), hb = head(b)
  return !!ha && ha === hb
}
const amountsMatch = (a, b) => Math.abs(Math.abs(a) - Math.abs(b)) <= Math.max(1, Math.abs(b) * 0.01)
const daysApart = (a, b) =>
  Math.abs(Math.round((new Date(`${dayOnly(a)}T12:00:00Z`) - new Date(`${dayOnly(b)}T12:00:00Z`)) / 86400000))

// Niveau de confiance d'un appariement paiement ERP ↔ écriture QB compensée.
// 'high' = appliquable sans confirmation · 'low' = proposé seulement · null =
// pas un appariement.
export function matchConfidence(payment, entry, { windowDays = 6 } = {}) {
  const sign = payment.direction === 'in' ? 1 : -1
  if (Math.sign(entry.amount) !== sign) return null
  if (!amountsMatch(entry.amount, payment.amount)) return null
  const gap = daysApart(payment.payment_date, entry.date)
  if (gap > windowDays) return null
  // Le nom QB concorde avec le fournisseur ou le bénéficiaire réel du paiement :
  // c'est le cas ordinaire (paiement de facture, dépense, chèque).
  if (namesOverlap(entry.name, payment.label) || namesOverlap(entry.name, payment.recipient)) return 'high'
  // Mouvement interne : QB ne nomme pas les virements. On compense par le
  // montant au cent près et une date quasi identique.
  if (!vendorKey(entry.name)
    && Math.abs(Math.abs(entry.amount) - Math.abs(payment.amount)) < 0.005 && gap <= 2) return 'high'
  return 'low'
}

// Apparie les paiements en attente aux écritures QB compensées. Une écriture ne
// sert qu'une fois, et le meilleur candidat gagne (confiance, puis écart de
// date, puis écart de montant) — sinon un paiement récurrent au même montant
// « volerait » l'écriture d'un autre.
export function matchPaymentsToLedger(pending, entries, { windowDays = 6 } = {}) {
  const scored = []
  for (const p of pending || []) {
    for (const e of entries || []) {
      const confidence = matchConfidence(p, e, { windowDays })
      if (!confidence) continue
      scored.push({
        payment: p, entry: e, confidence,
        gap: daysApart(p.payment_date, e.date),
        amountGap: Math.abs(Math.abs(e.amount) - Math.abs(p.amount)),
      })
    }
  }
  scored.sort((a, b) =>
    (a.confidence === b.confidence ? 0 : a.confidence === 'high' ? -1 : 1)
    || (a.gap - b.gap) || (a.amountGap - b.amountGap))
  const usedEntries = new Set()
  const usedPayments = new Set()
  const out = []
  for (const s of scored) {
    if (usedPayments.has(s.payment.id) || usedEntries.has(s.entry)) continue
    usedPayments.add(s.payment.id)
    usedEntries.add(s.entry)
    out.push(s)
  }
  return out
}

// Factures fournisseurs encore « à payer » dans l'ERP alors que QuickBooks a
// déjà une écriture bancaire COMPENSÉE à ce fournisseur et ce montant : la
// facture a été payée et l'argent est sorti, elle n'a plus rien à faire dans la
// projection ni dans le panneau « Factures à payer ».
// Le nom est OBLIGATOIRE ici (aucune exception « virement ») : une facture n'est
// jamais réglée par un mouvement interne anonyme.
export function matchBillsToLedger(bills, entries, { windowDays = 21 } = {}) {
  const scored = []
  for (const b of bills || []) {
    const due = dayOnly(b.due_date || b.date_achat)
    const amounts = [Number(b.balance_due_cad ?? b.total_cad), Number(b.total_cad)]
    for (const e of entries || []) {
      if (e.amount >= 0) continue // une facture se règle par une sortie
      if (!namesOverlap(e.name, b.vendor)) continue
      const amountGap = Math.min(...amounts.map(a => Math.abs(Math.abs(e.amount) - a)))
      if (amountGap > Math.max(1, amounts[0] * 0.01)) continue
      const gap = due ? daysApart(due, e.date) : 0
      if (due && gap > windowDays) continue
      scored.push({ bill: b, entry: e, confidence: 'low', gap, amountGap })
    }
  }
  // Toujours proposées, jamais appliquées d'office : créer un paiement lié à une
  // facture est une écriture de plus, l'utilisateur tranche.
  scored.sort((a, b) => (a.gap - b.gap) || (a.amountGap - b.amountGap))
  const usedEntries = new Set()
  const usedBills = new Set()
  const out = []
  for (const s of scored) {
    if (usedBills.has(s.bill.id) || usedEntries.has(s.entry)) continue
    usedBills.add(s.bill.id)
    usedEntries.add(s.entry)
    out.push(s)
  }
  return out
}

// ── Détection (lecture QB, aucune écriture) ─────────────────────────────────

function pendingPayments(accountName) {
  return db.prepare(`
    SELECT * FROM treasury_payments
    WHERE deleted_at IS NULL AND cleared_at IS NULL AND COALESCE(account, 'BNC CAD') = ?
    ORDER BY payment_date
  `).all(accountName)
}

function openBillsForAccount() {
  return db.prepare(`
    SELECT id, vendor, vendor_invoice_number, bill_number, due_date, date_achat,
           total_cad, balance_due_cad, currency, status
    FROM achats_fournisseurs
    WHERE type = 'bill' AND status NOT IN ('Payée', 'Annulée', 'Brouillon')
      AND COALESCE(balance_due_cad, total_cad) > 0 AND COALESCE(currency, 'CAD') = 'CAD'
      AND id NOT IN (SELECT achat_id FROM treasury_payments WHERE achat_id IS NOT NULL AND deleted_at IS NULL)
    ORDER BY COALESCE(due_date, date_achat)
  `).all()
}

const shiftDay = (iso, days) => {
  const d = new Date(`${dayOnly(iso)}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Candidat exposé à l'UI : ce qu'on a trouvé, à quoi ça correspond chez QB, et
// pourquoi on en est sûr (ou pas).
const toCandidate = (s, kind) => ({
  // 'payment'   : cocher le paiement en attente
  // 'bill'      : créer le paiement passé lié à la facture (elle quitte la liste)
  // 'duplicate' : paiement en attente qui double un paiement déjà passé
  kind,
  confidence: s.confidence,
  payment_id: kind === 'bill' ? null : s.payment.id,
  achat_id: kind === 'bill' ? s.bill.id : null,
  label: kind === 'bill' ? (s.bill.vendor || null) : (s.payment.label || null),
  amount: r2(kind === 'bill' ? (s.bill.balance_due_cad ?? s.bill.total_cad) : s.payment.amount),
  direction: kind === 'bill' ? 'out' : (s.payment.direction || 'out'),
  date: dayOnly(kind === 'bill' ? (s.bill.due_date || s.bill.date_achat) : s.payment.payment_date),
  invoice_number: kind === 'bill' ? (s.bill.vendor_invoice_number || s.bill.bill_number || null) : null,
  // Doublon : le paiement déjà passé auquel l'écriture QB est attribuée.
  twin: kind === 'duplicate' && s.twin
    ? { id: s.twin.id, date: dayOnly(s.twin.payment_date), amount: r2(s.twin.amount), cleared_source: s.twin.cleared_source || null }
    : null,
  qb: {
    date: s.entry.date,
    amount: s.entry.amount,
    name: s.entry.name || null,
    type: s.entry.type || null,
    entity: s.entry.entity || null,
    txn_id: s.entry.qbId || null,
    status: s.entry.cleared, // 'C' compensée · 'R' rapprochée
    url: s.entry.entity && s.entry.qbId ? qbEntityUrl(s.entry.entity, s.entry.qbId) : null,
  },
  day_gap: s.gap,
})

// Lit le grand livre QB du compte et renvoie les candidats, sans rien écrire.
export async function detectQbCleared({ accountName = null, windowDays = null, lookbackDays = null } = {}) {
  const cfg = getQbClearConfig()
  const account = accountName || cfg.account_name
  const window = Number(windowDays ?? cfg.day_window) || 6
  const lookback = Number(lookbackDays ?? cfg.lookback_days) || 75

  const bank = db.prepare('SELECT * FROM bank_accounts WHERE name = ? AND deleted_at IS NULL').get(account)
  if (!bank) throw new Error(`Compte bancaire « ${account} » introuvable`)
  if (!bank.qb_account_id) throw new Error(`Aucun compte QuickBooks mappé sur « ${account} » (page Rapprochement)`)

  const pending = pendingPayments(account)
  const bills = openBillsForAccount()
  const today = new Date().toISOString().slice(0, 10)
  // Fenêtre de lecture : assez large pour couvrir le plus vieux paiement en
  // attente / la plus vieille facture ouverte, bornée par lookback_days.
  const oldest = [
    ...pending.map(p => dayOnly(p.payment_date)),
    ...bills.map(b => dayOnly(b.due_date || b.date_achat)).filter(Boolean),
  ].sort()[0] || today
  const start = [shiftDay(oldest, -window), shiftDay(today, -lookback)].sort().reverse()[0]
  const end = shiftDay(today, window)

  const allEntries = await fetchQbLedgerCleared(bank.qb_account_id, start, end)

  // Écritures QB déjà « consommées » : soit explicitement rattachées à un
  // paiement (qb_txn_id), soit appariables à un paiement DÉJÀ passé. Sans ce
  // filtre, le paiement BTTH de 103,48 $ du 23 juillet — coché depuis
  // longtemps — était proposé comme règlement de la facture BTTH du 11 août
  // (même fournisseur, même montant tous les mois) : un faux positif à chaque
  // fournisseur récurrent.
  const storedQbIds = new Set(db.prepare(`
    SELECT qb_txn_id FROM treasury_payments WHERE qb_txn_id IS NOT NULL AND deleted_at IS NULL
  `).all().map(r => String(r.qb_txn_id)))
  const clearedInWindow = db.prepare(`
    SELECT * FROM treasury_payments
    WHERE deleted_at IS NULL AND cleared_at IS NOT NULL AND COALESCE(account, 'BNC CAD') = ?
      AND payment_date >= ? AND payment_date <= ?
  `).all(account, shiftDay(start, -window), end)
  const unstored = allEntries.filter(e => !e.qbId || !storedQbIds.has(e.qbId))
  const consumedBy = new Map(
    matchPaymentsToLedger(clearedInWindow, unstored, { windowDays: window }).map(m => [m.entry, m.payment])
  )
  const entries = unstored.filter(e => !consumedBy.has(e))

  const paymentMatches = matchPaymentsToLedger(pending, entries, { windowDays: window })

  // Doublons : un paiement en attente qui viserait une écriture QB DÉJÀ
  // attribuée à un paiement passé. QuickBooks ne connaît qu'UN mouvement de
  // 352,48 $ le 7 août ; s'il est déjà coché sur un autre paiement, celui-ci est
  // la même sortie enregistrée deux fois (les deux importateurs — Pmt_Suivi et
  // le fichier de solde — ont créé chacun leur ligne). Sans ça, le jumeau reste
  // éternellement dans la projection et fabrique une sortie fantôme. Toujours à
  // confirmer : c'est l'utilisateur qui tranche.
  const matchedPending = new Set(paymentMatches.map(m => m.payment.id))
  const duplicates = []
  for (const p of pending) {
    if (matchedPending.has(p.id)) continue
    for (const [entry, twin] of consumedBy) {
      if (!matchConfidence(p, entry, { windowDays: window })) continue
      duplicates.push({
        payment: p, entry, twin, confidence: 'low',
        gap: daysApart(p.payment_date, entry.date),
        amountGap: Math.abs(Math.abs(entry.amount) - Math.abs(p.amount)),
      })
      break
    }
  }
  // Les écritures déjà attribuées à un paiement ne peuvent pas régler une
  // facture en plus : le même dollar ne sort qu'une fois.
  const takenEntries = new Set(paymentMatches.map(m => m.entry))
  const billMatches = matchBillsToLedger(bills, entries.filter(e => !takenEntries.has(e)))

  return {
    account,
    window_days: window,
    range: { start, end },
    scanned: {
      payments: pending.length, bills: bills.length,
      qb_entries: entries.length, qb_entries_total: allEntries.length,
    },
    candidates: [
      ...paymentMatches.map(s => toCandidate(s, 'payment')),
      ...duplicates.map(s => toCandidate(s, 'duplicate')),
      ...billMatches.map(s => toCandidate(s, 'bill')),
    ],
  }
}

// ── Application ─────────────────────────────────────────────────────────────

// Coche un paiement (ou crée le paiement passé d'une facture) d'après un
// candidat. Retourne ce qui a été fait, pour le journal et les toasts.
function applyCandidate(c, userId = null) {
  if (c.kind === 'payment' || c.kind === 'duplicate') {
    const p = db.prepare('SELECT id, cleared_at FROM treasury_payments WHERE id = ? AND deleted_at IS NULL').get(c.payment_id)
    if (!p || p.cleared_at) return null
    setCleared(c.payment_id, true, { source: 'qb' })
    // Doublon : l'écriture QB appartient au jumeau déjà passé — on ne la
    // rattache pas ici, sinon deux paiements pointeraient le même mouvement et
    // la détection suivante ignorerait l'écriture du vrai.
    if (c.kind === 'payment') {
      db.prepare(`
        UPDATE treasury_payments SET qb_txn_id = ?, qb_txn_type = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
      `).run(c.qb.txn_id || null, c.qb.entity || null, c.payment_id)
    }
    return { kind: c.kind, id: c.payment_id, label: c.label, amount: c.amount }
  }
  // Facture : le paiement est créé DÉJÀ passé et lié à la facture — elle quitte
  // la projection et le panneau « Factures à payer ». Le statut de la facture
  // n'est pas touché : c'est QuickBooks (import CDC) qui en est la source.
  const bill = db.prepare('SELECT * FROM achats_fournisseurs WHERE id = ? AND deleted_at IS NULL').get(c.achat_id)
  if (!bill) return null
  const already = db.prepare('SELECT id FROM treasury_payments WHERE achat_id = ? AND deleted_at IS NULL').get(c.achat_id)
  if (already) return null
  const created = createPayment({
    payment_date: c.qb.date, direction: 'out', amount: c.amount,
    currency: bill.currency || 'CAD', account: getQbClearConfig().account_name,
    label: bill.vendor || c.label, achat_id: c.achat_id,
    invoice_number: c.invoice_number, method: 'autre',
    notes: `Détecté passé à la banque via QuickBooks (${c.qb.type || 'écriture'} du ${c.qb.date})`,
    cleared_at: new Date().toISOString(), cleared_source: 'qb', source: 'qb',
  }, userId)
  db.prepare(`
    UPDATE treasury_payments SET qb_txn_id = ?, qb_txn_type = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
  `).run(c.qb.txn_id || null, c.qb.entity || null, created.id)
  return { kind: 'bill', id: created.id, achat_id: c.achat_id, label: c.label, amount: c.amount }
}

// Applique une sélection de candidats identifiés côté client (ids de paiement /
// de facture). On RE-DÉTECTE avant d'appliquer : l'utilisateur confirme ce que
// QuickBooks dit maintenant, pas ce qu'il disait quand la page a été chargée.
export async function applyQbCleared({ paymentIds = [], achatIds = [], userId = null } = {}) {
  const wantP = new Set(paymentIds || [])
  const wantB = new Set(achatIds || [])
  if (!wantP.size && !wantB.size) return { applied: [], skipped: 0 }
  const detected = await detectQbCleared()
  const applied = []
  for (const c of detected.candidates) {
    const wanted = c.kind === 'bill' ? wantB.has(c.achat_id) : wantP.has(c.payment_id)
    if (!wanted) continue
    const done = applyCandidate(c, userId)
    if (done) applied.push(done)
  }
  // Demandé mais plus détecté par QuickBooks (ou déjà coché entre-temps) : on ne
  // coche jamais à l'aveugle sur la seule foi des ids envoyés par le client.
  const skipped = Math.max(0, (wantP.size + wantB.size) - applied.length)
  return { applied, skipped, detected: detected.candidates.length }
}

// ── Sync complète (bouton de la page + automation horaire) ───────────────────
//
// apply=false → simulation (rien n'est écrit).
// apply=true  → les appariements SÛRS (nom QB concordant, ou virement interne au
//               cent près) sont cochés ; les autres sont retournés pour
//               confirmation manuelle, ainsi que les factures détectées.
export async function syncQbClear({ trigger = 'manual', apply = true, userId = null } = {}) {
  const t0 = Date.now()
  const cfg = getQbClearConfig()
  try {
    const detected = await detectQbCleared()
    const autoApply = apply && cfg.auto_apply !== '0'
    const applied = []
    if (autoApply) {
      for (const c of detected.candidates) {
        if (c.kind !== 'payment' || c.confidence !== 'high') continue
        const done = applyCandidate(c, userId)
        if (done) applied.push(done)
      }
    }
    const appliedIds = new Set(applied.map(a => a.id))
    const toConfirm = detected.candidates.filter(c => !appliedIds.has(c.payment_id))
    const result = {
      summary: autoApply
        ? `${detected.scanned.qb_entries} écriture(s) compensée(s) chez QuickBooks · ${applied.length} paiement(s) marqué(s) passé(s) · ${toConfirm.length} à confirmer`
        : `Simulation : ${detected.scanned.qb_entries} écriture(s) compensée(s) · ${detected.candidates.length} correspondance(s) trouvée(s)`,
      account: detected.account,
      range: detected.range,
      scanned: detected.scanned,
      applied,
      candidates: toConfirm,
    }
    logSync('treasury:qb-clear', trigger === 'scheduled' ? 'scheduled' : 'manual',
      { status: 'success', modified: applied.length, durationMs: Date.now() - t0 })
    logSystemRun(QB_CLEAR_AUTOMATION_ID,
      { status: 'success', result, duration_ms: Date.now() - t0, triggerData: { trigger, apply } })
    return result
  } catch (e) {
    logSync('treasury:qb-clear', trigger === 'scheduled' ? 'scheduled' : 'manual',
      { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    logSystemRun(QB_CLEAR_AUTOMATION_ID,
      { status: 'error', error: e, duration_ms: Date.now() - t0, triggerData: { trigger, apply } })
    throw e
  }
}

// Sync horaire (index.js) — coupe-circuit si l'automation est désactivée.
export async function scheduledQbClearSync() {
  if (!isSystemAutomationActive(QB_CLEAR_AUTOMATION_ID)) return
  await syncQbClear({ trigger: 'scheduled', apply: true })
}

// État pour la page Paiements émis : automation active ? dernière exécution ?
export function qbClearStatus() {
  const auto = db.prepare('SELECT active FROM automations WHERE id = ? AND system = 1').get(QB_CLEAR_AUTOMATION_ID)
  const last = db.prepare(`
    SELECT status, result, error, created_at FROM automation_logs
    WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(QB_CLEAR_AUTOMATION_ID) || null
  let result = null
  if (last?.result) { try { result = JSON.parse(last.result) } catch { result = { summary: last.result } } }
  // Les candidats à confirmer de la dernière exécution sont renvoyés tels quels :
  // la page les affiche au chargement SANS rappeler QuickBooks (l'automation
  // horaire a déjà fait la lecture). Ils sont revalidés côté serveur au moment
  // d'appliquer.
  return {
    active: !!(auto && auto.active),
    last_run: last
      ? { status: last.status, executed_at: last.created_at, error: last.error, summary: result?.summary || null }
      : null,
    candidates: Array.isArray(result?.candidates) ? result.candidates : [],
  }
}
