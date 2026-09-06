// Moteur d'imputation du relevé ASFC : qui règle quoi, et donc ce qui doit être
// comptabilisé.
//
// Deux mécaniques, volontairement séparées :
//   1. pairBrokerLines — un courtier (FedEx, UPS, Axxess) qui paie l'ASFC pour
//      nous éteint des charges du relevé, puis nous refacture le tout. La charge
//      ET son encaissement s'annulent : rien à comptabiliser ici, la dépense et
//      la TPS arrivent par la facture du courtier (module reçus).
//   2. allocateFifo — nos propres versements (« Lot de cartes ») s'imputent aux
//      charges ouvertes par ordre d'échéance. Le versement de 500 $ du
//      2026-08-03 règle 297,32 $ de charges et laisse 202,68 $ de crédit au
//      portail. Ce lettrage EXPLIQUE le relevé et décide quelles charges sont
//      mûres pour la facture fournisseur ; il ne fabrique aucune écriture par
//      lui-même — la double-entrée (dépense vers 21000, factures depuis 21000)
//      s'en charge.
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { classifyCarmLine, postingSkipReason } from './carmRules.js'
import { getCarmConfig } from './carmAccount.js'
import { daysBetween } from '../utils/datetime.js'
import { round2Safe as round2 } from '../utils/money.js'

const dateOf = r => r.due_date || r.transaction_date
const brokerList = cfg => String(cfg?.broker_names || '').split(',').map(s => s.trim()).filter(Boolean)

// ── 1. Paires charge ↔ encaissement d'un courtier ────────────────────────────
// Pur : reçoit les lignes, rend les paires. Trois passes par courtier —
// même numéro de transaction, puis montant opposé à ≤ 10 jours, puis FIFO sur
// son sous-grand-livre.
export function pairBrokerLines(lines) {
  const pairs = []
  const byBroker = new Map()
  // Quand l'export du portail ne nomme pas le courtier, toutes ses lignes
  // tombent dans un même seau : le code LP dit déjà que c'est un courtier qui
  // paie, et le relevé ne mélange pas les comptes.
  const bucket = l => l.broker || '(courtier)'
  for (const l of lines) {
    const isBrokerPayment = l.kind === 'paiement' && l.payer === 'courtier' && Number(l.amount) < 0
    const isCharge = Number(l.amount) > 0 && l.kind !== 'garantie'
    if (!isBrokerPayment && !isCharge) continue
    if (isCharge && !l.broker && !lines.some(x => x.kind === 'paiement' && x.payer === 'courtier' && !x.broker)) continue
    const key = isBrokerPayment && !l.broker ? '(courtier)' : bucket(l)
    if (!byBroker.has(key)) byBroker.set(key, { charges: [], payments: [] })
    const b = byBroker.get(key)
    if (isBrokerPayment) b.payments.push(l)
    else b.charges.push(l)
  }
  for (const [broker, { charges, payments }] of byBroker) {
    const open = charges.map(c => ({ ...c, left: round2(c.amount) }))
      .sort((a, b) => String(dateOf(a)).localeCompare(String(dateOf(b))))
    for (const p of payments.sort((a, b) => String(dateOf(a)).localeCompare(String(dateOf(b))))) {
      let left = round2(-p.amount)
      const take = (c, amt) => {
        if (amt <= 0.0049) return
        pairs.push({ broker: broker === '(courtier)' ? (p.broker || 'courtier') : broker, charge_txn_id: c.id, payment_txn_id: p.id, amount: round2(amt) })
        c.left = round2(c.left - amt)
        left = round2(left - amt)
      }
      // a) même numéro de transaction
      for (const c of open) {
        if (left <= 0.0049) break
        if (c.left > 0.0049 && c.transaction_number && p.transaction_number
          && String(c.transaction_number) === String(p.transaction_number)) take(c, Math.min(c.left, left))
      }
      // b) montant exactement opposé, à 10 jours près
      if (left > 0.0049) {
        const exact = open.filter(c => Math.abs(c.left - left) < 0.005 && daysBetween(dateOf(c), dateOf(p)) <= 10)
          .sort((a, b) => daysBetween(dateOf(a), dateOf(p)) - daysBetween(dateOf(b), dateOf(p)))[0]
        if (exact) take(exact, left)
      }
      // c) FIFO sur le sous-grand-livre du courtier
      for (const c of open) {
        if (left <= 0.0049) break
        if (c.left > 0.0049 && dateOf(c) <= dateOf(p)) take(c, Math.min(c.left, left))
      }
    }
  }
  return pairs
}

// ── 2. Lettrage FIFO de NOS versements ───────────────────────────────────────
// Pur. `charges` = charges à notre charge (ni garantie, ni éteintes par un
// courtier), `payments` = nos versements. Les allocations manuelles sont posées
// d'abord et réduisent les restes.
export function allocateFifo({ charges = [], payments = [], manual = [] } = {}) {
  const byDate = (a, b) => String(dateOf(a)).localeCompare(String(dateOf(b))) || String(a.id).localeCompare(String(b.id))
  const c = charges.map(x => ({ ...x, left: round2(x.amount) })).sort(byDate)
  const p = payments.map(x => ({ ...x, left: round2(-x.amount) })).sort(byDate)
  const idx = { charge: new Map(c.map(x => [x.id, x])), payment: new Map(p.map(x => [x.id, x])) }
  const allocations = []

  for (const m of manual) {
    const ch = idx.charge.get(m.charge_txn_id), pa = idx.payment.get(m.payment_txn_id)
    if (!ch || !pa) continue
    const amt = round2(Math.min(m.amount, ch.left, pa.left))
    if (amt <= 0.0049) continue
    ch.left = round2(ch.left - amt); pa.left = round2(pa.left - amt)
    allocations.push({ payment_txn_id: pa.id, charge_txn_id: ch.id, amount: amt, method: 'manuel' })
  }
  for (const pa of p) {
    for (const ch of c) {
      if (pa.left <= 0.0049) break
      if (ch.left <= 0.0049) continue
      const amt = round2(Math.min(ch.left, pa.left))
      ch.left = round2(ch.left - amt); pa.left = round2(pa.left - amt)
      allocations.push({ payment_txn_id: pa.id, charge_txn_id: ch.id, amount: amt, method: 'fifo' })
    }
  }
  return {
    allocations,
    open_charges: c.filter(x => x.left > 0.0049).map(x => ({ id: x.id, left: x.left })),
    credit_available: round2(p.reduce((s, x) => s + x.left, 0)),
    unpaid: round2(c.reduce((s, x) => s + x.left, 0)),
  }
}

// ── Enveloppes DB ────────────────────────────────────────────────────────────

function liveLines() {
  return db.prepare(`
    SELECT id, transaction_date, due_date, transaction_type, transaction_number, description,
           amount, party, detail, kind, payer, broker, split_source, duty_amount, gst_amount,
           posting_state, skip_reason, qb_txn_id
    FROM carm_transactions WHERE deleted_at IS NULL ORDER BY transaction_date, created_at
  `).all()
}

// ── Confirmation par la banque ───────────────────────────────────────────────
// L'export du portail ne dit pas toujours qui a payé. Le relevé bancaire, lui,
// est sans appel : une sortie « CBSA-ASFC » du bon montant prouve que le
// versement vient de nous — et le montant à chercher est celui du GROUPE, car
// l'ASFC éclate un versement de 500 $ en deux lignes (297,32 + 202,68).
// Le compte bancaire trouvé sert ensuite de compte de paiement dans QuickBooks.
const BANK_ASFC_LIKE = '%cbsa%'

export function resolvePayersFromBank({ windowDays = 10 } = {}) {
  const payments = db.prepare(`
    SELECT id, transaction_date, transaction_number, amount, payer, kind
    FROM carm_transactions
    WHERE deleted_at IS NULL AND amount < 0 AND COALESCE(kind,'') = 'paiement'
      AND COALESCE(split_source, 'auto') = 'auto'
      AND COALESCE(posting_state,'') != 'comptabilise'
  `).all()
  if (!payments.length) return 0
  const groups = new Map()
  for (const p of payments) {
    const key = `${p.transaction_date}|${p.transaction_number || p.id}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(p)
  }
  const bank = db.prepare(`
    SELECT id, txn_date, amount, account_id, description FROM bank_transactions
    WHERE deleted_at IS NULL AND amount < 0
      AND (LOWER(description) LIKE ? OR LOWER(description) LIKE '%asfc%'
           OR LOWER(description) LIKE '%border services%' OR LOWER(description) LIKE '%frontalier%')
  `).all(BANK_ASFC_LIKE)
  if (!bank.length) return 0
  const upd = db.prepare(`
    UPDATE carm_transactions SET payer = 'nous', broker = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND deleted_at IS NULL AND COALESCE(posting_state,'') != 'comptabilise'
  `)
  const used = new Set()
  let n = 0
  const tx = db.transaction(() => {
    for (const lines of groups.values()) {
      const sum = round2(lines.reduce((s, l) => s + -l.amount, 0))
      const date = lines[0].transaction_date
      const hit = bank.find(b => !used.has(b.id) && Math.abs(-b.amount - sum) < 0.005
        && daysBetween(b.txn_date, date) <= windowDays)
      if (!hit) continue
      used.add(hit.id)
      for (const l of lines) { if (l.payer !== 'nous') { upd.run(l.id); n++ } }
    }
  })
  tx()
  return n
}

// Rejoue les règles de classification sur les lignes qui n'ont pas été corrigées
// à la main. Idempotent : ne touche jamais une ligne déjà comptabilisée.
export function backfillCarmClassification() {
  const cfg = getCarmConfig()
  const brokerNames = brokerList(cfg)
  const rows = db.prepare(`
    SELECT * FROM carm_transactions
    WHERE deleted_at IS NULL AND COALESCE(split_source, 'auto') = 'auto'
      AND COALESCE(posting_state, '') != 'comptabilise'
  `).all()
  const upd = db.prepare(`
    UPDATE carm_transactions SET kind = ?, category = ?, duty_amount = ?, gst_amount = ?,
      payer = ?, broker = ?, split_source = 'auto', split_rule = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `)
  let n = 0
  const tx = db.transaction(() => {
    for (const r of rows) {
      const c = classifyCarmLine(r, { brokerNames })
      const same = r.kind === c.kind && r.category === c.category && r.payer === c.payer
        && r.broker === c.broker && r.duty_amount === c.duty_amount && r.gst_amount === c.gst_amount
      if (same) continue
      upd.run(c.kind, c.category, c.duty_amount, c.gst_amount, c.payer, c.broker, c.rule, r.id)
      n++
    }
  })
  tx()
  return n
}

// Marque les charges éteintes par un courtier (et les encaissements du courtier)
// comme non comptabilisables, en croisant offset_txn_id. Ne touche jamais une
// ligne déjà comptabilisée ni un état forcé à la main (skip_reason 'manuel:…').
export function matchBrokerPairs() {
  const lines = liveLines().filter(l => l.posting_state !== 'comptabilise')
  const pairs = pairBrokerLines(lines)
  const upd = db.prepare(`
    UPDATE carm_transactions SET posting_state = 'non_comptabilise', skip_reason = ?, offset_txn_id = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND deleted_at IS NULL AND COALESCE(posting_state,'') != 'comptabilise'
      AND COALESCE(skip_reason,'') NOT LIKE 'manuel:%'
  `)
  const tx = db.transaction(() => {
    for (const p of pairs) {
      upd.run(`via_courtier:${p.broker}`, p.payment_txn_id, p.charge_txn_id)
      upd.run(`via_courtier:${p.broker}`, p.charge_txn_id, p.payment_txn_id)
    }
  })
  tx()
  return pairs.length
}

// Périmètre « à notre charge » : ni garantie, ni ligne éteinte par un courtier,
// ni antérieure à la date d'ouverture du compte.
function ourScope(lines, cfg) {
  const since = cfg.opening_date || ''
  return lines.filter(l =>
    l.kind !== 'garantie'
    && !String(l.skip_reason || '').startsWith('via_courtier')
    && !(l.kind === 'paiement' && l.payer === 'courtier')
    && (!since || l.transaction_date >= since))
}

// Recalcule le lettrage FIFO. Diff plutôt que table rase : les allocations
// manuelles survivent, les identiques ne bougent pas (idempotence).
export function recomputeCarmAllocations() {
  const cfg = getCarmConfig()
  const scope = ourScope(liveLines(), cfg)
  const charges = scope.filter(l => Number(l.amount) > 0)
  const payments = scope.filter(l => Number(l.amount) < 0)
  const manual = db.prepare(`
    SELECT payment_txn_id, charge_txn_id, amount FROM carm_allocations
    WHERE deleted_at IS NULL AND method = 'manuel'
  `).all()

  const { allocations } = allocateFifo({ charges, payments, manual })
  const want = new Map(allocations.map(a => [`${a.payment_txn_id}|${a.charge_txn_id}`, a]))
  const have = db.prepare(`SELECT * FROM carm_allocations WHERE deleted_at IS NULL`).all()

  const del = db.prepare(`UPDATE carm_allocations SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
  const upd = db.prepare(`UPDATE carm_allocations SET amount = ? WHERE id = ?`)
  const ins = db.prepare(`
    INSERT INTO carm_allocations (id, payment_txn_id, charge_txn_id, amount, method)
    VALUES (?, ?, ?, ?, ?)
  `)
  let changed = 0
  const tx = db.transaction(() => {
    for (const h of have) {
      const key = `${h.payment_txn_id}|${h.charge_txn_id}`
      const w = want.get(key)
      if (!w) { if (h.method === 'fifo') { del.run(h.id); changed++ } ; continue }
      if (Math.abs(h.amount - w.amount) > 0.0049) { upd.run(w.amount, h.id); changed++ }
      want.delete(key)
    }
    for (const w of want.values()) { ins.run(newRecordId(), w.payment_txn_id, w.charge_txn_id, w.amount, w.method); changed++ }
  })
  tx()
  return changed
}

// État d'imputation lisible par l'UI : pour chaque ligne, ce qui est réglé, par
// quoi, et ce qui reste. Sert au panneau de lettrage et aux garde-fous du push.
export function carmImputation() {
  const cfg = getCarmConfig()
  const lines = liveLines()
  const scope = ourScope(lines, cfg)
  const allocs = db.prepare(`SELECT * FROM carm_allocations WHERE deleted_at IS NULL`).all()
  const byCharge = new Map(), byPayment = new Map()
  for (const a of allocs) {
    byCharge.set(a.charge_txn_id, round2((byCharge.get(a.charge_txn_id) || 0) + a.amount))
    byPayment.set(a.payment_txn_id, round2((byPayment.get(a.payment_txn_id) || 0) + a.amount))
  }
  const settled = new Set()
  for (const l of scope) {
    if (Number(l.amount) > 0 && Math.abs((byCharge.get(l.id) || 0) - l.amount) < 0.005) settled.add(l.id)
  }
  const credit = round2(scope.filter(l => Number(l.amount) < 0)
    .reduce((s, l) => s + (-l.amount - (byPayment.get(l.id) || 0)), 0))
  const unpaid = round2(scope.filter(l => Number(l.amount) > 0)
    .reduce((s, l) => s + (l.amount - (byCharge.get(l.id) || 0)), 0))
  return { allocations: allocs, byCharge, byPayment, settled, credit_available: credit, unpaid }
}

// Sort d'une ligne du point de vue comptable, recalculé à chaque lecture :
//   • 'comptabilise'        — déjà dans QuickBooks
//   • 'non_comptabilise'    — garantie ou réglée par un courtier (rien à faire)
//   • 'attente_imputation'  — charge à notre charge, pas encore réglée : on
//                             attend de savoir si c'est nous ou le courtier qui
//                             paiera (comptabiliser trop tôt = double compte)
//   • 'a_comptabiliser'     — prête à partir dans QB
export function refreshPostingStates() {
  const cfg = getCarmConfig()
  const { settled } = carmImputation()
  const lines = liveLines()
  const upd = db.prepare(`
    UPDATE carm_transactions SET posting_state = ?, skip_reason = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND deleted_at IS NULL
  `)
  let n = 0
  const tx = db.transaction(() => {
    for (const l of lines) {
      if (l.posting_state === 'comptabilise' || l.posting_state === 'a_verifier' || l.posting_state === 'erreur') continue
      if (String(l.skip_reason || '').startsWith('manuel:')) continue
      let state, reason = l.skip_reason || null
      const skip = postingSkipReason(l)
      if (skip) { state = 'non_comptabilise'; reason = skip }
      else if (String(l.skip_reason || '').startsWith('via_courtier')) state = 'non_comptabilise'
      else if (cfg.opening_date && l.transaction_date < cfg.opening_date) { state = 'non_comptabilise'; reason = 'hors_periode' }
      else if (cfg.post_since && l.transaction_date < cfg.post_since) { state = 'non_comptabilise'; reason = 'hors_periode' }
      else if (Number(l.amount) < 0) { state = 'a_comptabiliser'; reason = null }
      else { state = settled.has(l.id) ? 'a_comptabiliser' : 'attente_imputation'; reason = null }
      if (state !== l.posting_state || (reason || null) !== (l.skip_reason || null)) { upd.run(state, reason, l.id); n++ }
    }
  })
  tx()
  return n
}

// Chaîne complète, à rejouer après import / PATCH / suppression / lien.
export function recomputeCarm() {
  const classified = backfillCarmClassification()
  const confirmed = resolvePayersFromBank()
  const paired = matchBrokerPairs()
  const allocated = recomputeCarmAllocations()
  const states = refreshPostingStates()
  return { classified, confirmed, paired, allocated, states }
}
