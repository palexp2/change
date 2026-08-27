// Cédule hebdomadaire de paiements fournisseurs — « qu'est-ce qu'on paie cette
// semaine, et est-ce que le compte suit ? »
//
// Le trou que ça comble : les factures fournisseurs à payer existaient déjà
// (panneau « Factures à payer » de /paiements-emis), mais en vrac — une liste
// plate, sans horizon, sans total, sans confrontation au solde disponible. La
// décision hebdomadaire (« je paie ces sept-là mardi, je reporte Fabrique Manic
// à la semaine prochaine ») se prenait donc de tête, et rien n'empêchait de
// charger 12 000 $ de plus sur la Mastercard la veille du paiement pré-programmé.
//
// Trois règles portent tout :
//   1. On ne propose QUE ce qui est réellement à payer : une facture déjà
//      couverte par un paiement émis (lien achat_id, ou même fournisseur/montant
//      /date à quelques jours près) ou par une sortie récurrente (loyer,
//      Mastercard pré-programmée du 5) est retirée AVEC sa raison — jamais
//      silencieusement (le même dollar sortirait deux fois).
//   2. Cocher = payer : ça crée le paiement émis du jour dans /paiements-emis,
//      lié à la facture. Décocher supprime ce paiement tant qu'il n'est pas
//      passé à la banque.
//   3. Reporter est un état, pas un oubli : la facture sort de la cédule avec
//      une raison écrite et, si on veut, une date de retour.
import db from '../db/database.js'
import {
  getTreasuryConfig, expandRecurring, variableOccurrence, TREASURY_BANK_ACCOUNT,
} from './treasury.js'
import {
  coveredBillIds, vendorPaymentHints, vendorKey, createPayment, getPayment,
  BILL_COVER_DAY_WINDOW, COVERAGE_DAY_WINDOW,
} from './treasuryPayments.js'
import { summarizeAccount } from './bankReconcileSummary.js'
import { findVendorProfile } from './vendorProfiles.js'
import { ensureCardDues, listOpenCardDues } from './cardDues.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'
import { v4 as uuid } from 'uuid'

const r2 = n => Math.round(Number(n) * 100) / 100
const dayOnly = v => String(v || '').slice(0, 10)
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const todayIso = (today = new Date()) => isoDate(today)

export const shiftIso = (iso, days) => {
  const d = new Date(`${dayOnly(iso)}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ── Fenêtre de la cédule : le cycle réel de paiement ─────────────────────────
// Les factures se paient LE MARDI. Ce jour-là on règle tout ce qui échoit avant
// le mercredi suivant — donc jusqu'au mardi d'après INCLUS : un paiement émis le
// mardi en fin de journée ne passe à la banque que le lendemain, une facture qui
// échoit le mardi suivant serait donc payée en retard si on attendait la
// prochaine séance.
//
// La fenêtre n'est ni la semaine civile ni 7 jours glissants : elle va
// d'aujourd'hui au mardi qui SUIT la prochaine séance de paiement.
export const PAY_WEEKDAY = 2   // mardi (1 = lundi … 7 = dimanche, ISO-8601)

// Prochaine séance de paiement : aujourd'hui si on y est déjà, sinon le
// prochain jour de paie.
export function nextPayDay(fromIso, weekday = PAY_WEEKDAY) {
  const d = new Date(`${dayOnly(fromIso)}T12:00:00Z`)
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
  return shiftIso(fromIso, (weekday - dow + 7) % 7)
}

export function scheduleWindow(todayIsoStr, weekday = PAY_WEEKDAY) {
  const pay_day = nextPayDay(todayIsoStr, weekday)
  // Dernière échéance couverte = le jour de paie suivant, inclus.
  const end = shiftIso(pay_day, 7)
  return {
    start: dayOnly(todayIsoStr),
    pay_day,
    end,
    // Première échéance NON couverte — c'est le « avant le mercredi » de la règle.
    cutoff: shiftIso(end, 1),
    weekday,
  }
}

// en retard (échéance dépassée) · cette semaine · plus tard. Pur.
export function bucketOf(dueIso, todayIsoStr, weekEndIso) {
  const due = dayOnly(dueIso)
  if (!due) return 'week'          // sans échéance : à traiter tout de suite
  if (due < dayOnly(todayIsoStr)) return 'late'
  if (due <= dayOnly(weekEndIso)) return 'week'
  return 'later'
}

const daysApart = (a, b) =>
  Math.abs(Math.round((new Date(`${dayOnly(a)}T12:00:00Z`) - new Date(`${dayOnly(b)}T12:00:00Z`)) / 86400000))

// Factures couvertes par une sortie récurrente (le loyer est une récurrente ET
// une facture du bailleur ; la Mastercard pré-programmée du 5 règle des achats
// déjà facturés). L'appariement se fait sur `recurring_outflows.vendor_match`
// — le seul lien que l'utilisateur ait explicitement posé — et sur une fenêtre
// de jours autour de l'occurrence. Pur : `occurrences` = [{label, date,
// vendor_match, amount}].
export function coveredByRecurring(bills, occurrences, { windowDays = COVERAGE_DAY_WINDOW } = {}) {
  const covered = new Map()
  for (const b of bills || []) {
    const due = dayOnly(b.due_date || b.date_achat)
    if (!due) continue
    const hit = (occurrences || []).find(o => {
      const needle = vendorKey(o.vendor_match)
      const vk = vendorKey(b.vendor)
      if (!needle || !vk) return false
      if (!vk.includes(needle) && !needle.includes(vk)) return false
      return daysApart(o.date, due) <= windowDays
    })
    if (hit) covered.set(b.id, { label: hit.label, date: hit.date, amount: hit.amount })
  }
  return covered
}

// Regroupement par fournisseur, dans l'ordre d'urgence : le fournisseur dont la
// facture est la plus proche de l'échéance vient en premier. Pur.
export function groupByVendor(items) {
  const byKey = new Map()
  for (const it of items) {
    const key = vendorKey(it.vendor) || 'sans-fournisseur'
    let g = byKey.get(key)
    if (!g) { g = { key, vendor: it.vendor || 'Sans fournisseur', items: [], total_cad: 0, currencies: {} }; byKey.set(key, g) }
    g.items.push(it)
    if ((it.currency || 'CAD') === 'CAD') g.total_cad = r2(g.total_cad + it.amount)
    else g.currencies[it.currency] = r2((g.currencies[it.currency] || 0) + it.amount)
  }
  for (const g of byKey.values()) {
    g.items.sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')))
    g.due_date = g.items[0]?.due_date || null
  }
  return [...byKey.values()].sort((a, b) =>
    String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'))
    || a.vendor.localeCompare(b.vendor, 'fr'))
}

// Solde projeté de la carte. Tout est en « montant dû » (positif = dette).
// Pur — c'est le calcul que l'alerte doit pouvoir justifier ligne à ligne.
export function projectCard({ current = 0, charges_pending = 0, scheduled = 0, card_payments = 0 }) {
  return r2(Number(current) + Number(charges_pending) + Number(scheduled) - Number(card_payments))
}

// ── Reports ──────────────────────────────────────────────────────────────────

export function listDeferrals() {
  return db.prepare(`
    SELECT achat_id, reason, defer_until, created_at, updated_at
    FROM payment_schedule_deferrals WHERE deleted_at IS NULL
  `).all()
}

export function deferBill(achatId, { reason = null, defer_until = null } = {}, userId = null) {
  db.prepare(`
    INSERT INTO payment_schedule_deferrals (achat_id, reason, defer_until, created_by)
    VALUES (?,?,?,?)
    ON CONFLICT(achat_id) DO UPDATE SET
      reason = excluded.reason, defer_until = excluded.defer_until,
      deleted_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(achatId, reason ? String(reason).trim() : null, defer_until ? dayOnly(defer_until) : null, userId)
  return db.prepare('SELECT * FROM payment_schedule_deferrals WHERE achat_id=?').get(achatId)
}

export function resumeBill(achatId) {
  db.prepare(`
    UPDATE payment_schedule_deferrals
    SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE achat_id = ?
  `).run(achatId)
  return { ok: true }
}

// ── Cocher / décocher un paiement de la cédule ───────────────────────────────
// Cocher crée le paiement émis du jour, lié à la facture : elle cède sa place
// dans la projection (anti double-compte) et apparaît dans /paiements-emis en
// « À passer ». Décocher le supprime — tant qu'il n'est PAS passé à la banque :
// après, c'est le relevé qui fait foi, pas la case.
export function payBill(achatId, { account = null, method = null, notes = null, payment_date = null } = {}, userId = null) {
  const bill = db.prepare(`
    SELECT * FROM achats_fournisseurs WHERE id = ? AND type = 'bill'
  `).get(achatId)
  if (!bill) return { error: 'Facture introuvable', status: 404 }
  const existing = db.prepare(
    'SELECT id FROM treasury_payments WHERE achat_id = ? AND deleted_at IS NULL'
  ).get(achatId)
  if (existing) return { payment: getPayment(existing.id), created: false }

  const hint = vendorPaymentHints().find(h => h.key === vendorKey(bill.vendor)) || null
  const amount = Number(bill.balance_due_cad ?? bill.total_cad)
  if (!(amount > 0)) return { error: 'Solde dû nul', status: 400 }
  const accountsByName = new Map(
    db.prepare('SELECT name, currency, kind FROM bank_accounts WHERE deleted_at IS NULL').all().map(a => [a.name, a])
  )
  const payment = createPayment({
    payment_date: payment_date && /^\d{4}-\d{2}-\d{2}$/.test(payment_date) ? payment_date : todayIso(),
    direction: 'out',
    amount,
    currency: bill.currency || 'CAD',
    account: account || suggestedAccountName(bill, hint, accountsByName),
    label: bill.vendor || 'Facture fournisseur',
    achat_id: bill.id,
    invoice_number: bill.vendor_invoice_number || bill.bill_number || null,
    method: method || (hint?.method && hint.direction !== 'in' ? hint.method : 'interac'),
    notes: notes ?? hint?.note ?? null,
    recipient: hint?.recipient || null,
    source: 'schedule',
  }, userId)
  return { payment, created: true }
}

export function unpayBill(achatId) {
  const row = db.prepare(
    'SELECT id, cleared_at FROM treasury_payments WHERE achat_id = ? AND deleted_at IS NULL'
  ).get(achatId)
  if (!row) return { ok: true, deleted: 0 }
  if (row.cleared_at) return { error: 'Paiement déjà passé à la banque — le décocher dans Paiements émis', status: 409 }
  db.prepare(`UPDATE treasury_payments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(row.id)
  return { ok: true, deleted: 1 }
}

// ── Particularités du fournisseur, corrigées depuis la cédule ────────────────
// La remarque ambre sous une facture ne vit pas sur la facture : c'est la
// particularité du PROFIL du fournisseur (« Facture à ctb le 30 du mois
// précédent… »). C'est au moment de payer qu'on s'aperçoit qu'elle est fausse ou
// incomplète, donc elle s'édite ici — mais l'écriture va dans le profil, pas
// dans une copie locale : toutes les factures du fournisseur, le formulaire de
// paiement et /fournisseurs affichent la même version. Un fournisseur sans
// profil en obtient un (la remarque doit vivre quelque part).
export function setVendorParticularites(achatId, particularites) {
  const bill = db.prepare("SELECT id, vendor FROM achats_fournisseurs WHERE id = ? AND type = 'bill'").get(achatId)
  if (!bill) return { error: 'Facture introuvable', status: 404 }
  const vendor = String(bill.vendor || '').trim()
  if (!vendor) return { error: 'Facture sans fournisseur — aucun profil à mettre à jour', status: 400 }
  const value = particularites == null ? null : String(particularites).trim() || null

  let profile = findVendorProfile(vendor)
  if (!profile) {
    // Homonyme soft-deleté : le UNIQUE de vendor_profiles.name l'inclut, on
    // réveille le profil archivé au lieu de buter sur la contrainte.
    const archived = db.prepare(
      'SELECT id FROM vendor_profiles WHERE deleted_at IS NOT NULL AND LOWER(TRIM(name)) = LOWER(?)'
    ).get(vendor)
    if (archived) {
      db.prepare(`UPDATE vendor_profiles SET deleted_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(archived.id)
      profile = { id: archived.id, name: vendor }
    } else {
      const id = uuid()
      db.prepare('INSERT INTO vendor_profiles (id, name) VALUES (?,?)').run(id, vendor)
      profile = { id, name: vendor }
    }
  }
  db.prepare(`
    UPDATE vendor_profiles SET particularites = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(value, profile.id)
  return { achat_id: bill.id, vendor, profile_id: profile.id, profile_name: profile.name, particularites: value }
}

// ── La cédule ────────────────────────────────────────────────────────────────

export function buildSchedule({ from = null, today = new Date() } = {}) {
  const cfg = getTreasuryConfig()
  const todayStr = todayIso(today)
  // Les cartes de crédit à payer se génèrent ici plutôt que par un cron : la
  // cédule est relue à chaque affichage, donc les lignes apparaissent d'elles-
  // mêmes le jour dit, et une période sautée se rattrape au passage suivant.
  ensureCardDues({ today: todayStr })
  // `pay_weekday` de la config trésorerie : le cycle réel de paiement (mardi).
  const weekday = Math.min(7, Math.max(1, Number(cfg.pay_weekday) || PAY_WEEKDAY))
  const week = scheduleWindow(from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : todayStr, weekday)

  // Factures ouvertes + le paiement émis qui les règle déjà, s'il existe (c'est
  // lui qui porte l'état « coché »).
  const rows = db.prepare(`
    SELECT a.id, a.vendor, a.vendor_invoice_number, a.bill_number, a.due_date, a.date_achat,
           a.total_cad, a.balance_due_cad, a.currency, a.status, a.quickbooks_id,
           p.id AS payment_id, p.payment_date, p.cleared_at, p.account AS payment_account,
           p.amount AS payment_amount, p.method AS payment_method
    FROM achats_fournisseurs a
    LEFT JOIN treasury_payments p ON p.achat_id = a.id AND p.deleted_at IS NULL
    WHERE a.type = 'bill' AND a.status NOT IN ('Payée', 'Annulée', 'Brouillon')
      AND COALESCE(a.balance_due_cad, a.total_cad) > 0
    ORDER BY COALESCE(a.due_date, a.date_achat) ASC, a.vendor COLLATE NOCASE ASC
  `).all()

  // ── Ce qu'on retire de la proposition, avec sa raison ──────────────────────
  const excluded = []
  const unpaid = rows.filter(b => !b.payment_id)

  // 1. Paiement émis en attente qui couvre la facture sans lien achat_id.
  const pendingOut = db.prepare(`
    SELECT id, label, amount, payment_date, achat_id FROM treasury_payments
    WHERE deleted_at IS NULL AND cleared_at IS NULL AND direction = 'out'
  `).all()
  const linkedIds = new Set(rows.filter(b => b.payment_id).map(b => b.id))
  const billCover = coveredBillIds(
    unpaid.map(b => ({ ...b, due_date: dayOnly(b.due_date || b.date_achat) })),
    pendingOut.filter(p => !p.achat_id || !linkedIds.has(p.achat_id)),
    { windowDays: BILL_COVER_DAY_WINDOW },
  )

  // 2. Sortie récurrente qui couvre la facture (vendor_match posé à la main).
  const recurring = db.prepare(
    'SELECT * FROM recurring_outflows WHERE deleted_at IS NULL AND active = 1'
  ).all()
  const occurrences = []
  for (const r of recurring) {
    if (!(Number(r.amount) > 0)) continue
    const dates = r.variable_amount
      ? [variableOccurrence(r, week.start, week.end)].filter(Boolean)
      : expandRecurring(r, week.start, week.end)
    for (const date of dates) {
      occurrences.push({
        id: r.id, label: r.label, date, amount: r2(r.amount),
        vendor_match: r.vendor_match || null, variable_amount: r.variable_amount ? 1 : 0,
      })
    }
  }
  // Fenêtre élargie pour la couverture : une facture peut tomber avant ou après
  // l'occurrence de la semaine.
  const coverOccurrences = []
  for (const r of recurring.filter(x => x.vendor_match && Number(x.amount) > 0)) {
    for (const date of expandRecurring(r,
      shiftIso(week.start, -COVERAGE_DAY_WINDOW), shiftIso(week.end, COVERAGE_DAY_WINDOW))) {
      coverOccurrences.push({ label: r.label, date, amount: r2(r.amount), vendor_match: r.vendor_match })
    }
  }
  const recurringCover = coveredByRecurring(unpaid, coverOccurrences)

  // 3. Reports explicites (avec leur raison).
  const deferrals = new Map(listDeferrals().map(d => [d.achat_id, d]))

  const hints = vendorPaymentHints()
  const hintByKey = new Map(hints.map(h => [h.key, h]))
  const accountsByName = new Map(
    db.prepare('SELECT name, currency, kind FROM bank_accounts WHERE deleted_at IS NULL').all().map(a => [a.name, a])
  )

  const items = []
  for (const b of rows) {
    const due = dayOnly(b.due_date || b.date_achat) || null
    const amount = r2(b.balance_due_cad ?? b.total_cad)
    const cover = billCover.get(b.id)
    if (!b.payment_id && cover) {
      excluded.push({
        id: b.id, vendor: b.vendor, amount, currency: b.currency || 'CAD', due_date: due,
        reason: 'paiement', detail: `Déjà couverte par le paiement émis « ${cover.payment_label || 'sans libellé'} » du ${cover.payment_date}`,
        payment_id: cover.payment_id,
        qb_url: b.quickbooks_id ? qbEntityUrl('bill', b.quickbooks_id) : null,
      })
      continue
    }
    const rec = !b.payment_id && recurringCover.get(b.id)
    if (rec) {
      excluded.push({
        id: b.id, vendor: b.vendor, amount, currency: b.currency || 'CAD', due_date: due,
        reason: 'recurring', detail: `Couverte par la sortie récurrente « ${rec.label} » du ${rec.date}`,
        qb_url: b.quickbooks_id ? qbEntityUrl('bill', b.quickbooks_id) : null,
      })
      continue
    }
    const hint = hintByKey.get(vendorKey(b.vendor)) || null
    const def = deferrals.get(b.id) || null
    // Un report daté expire tout seul : la facture revient dans la cédule le jour dit.
    const deferActive = !!def && (!def.defer_until || def.defer_until > todayStr)
    const account = b.payment_account || suggestedAccountName(b, hint, accountsByName)
    items.push({
      id: b.id,
      vendor: b.vendor || 'Sans fournisseur',
      vendor_key: vendorKey(b.vendor),
      invoice_number: b.vendor_invoice_number || b.bill_number || null,
      due_date: due,
      no_due_date: !b.due_date,
      amount,
      currency: b.currency || 'CAD',
      status: b.status,
      quickbooks_id: b.quickbooks_id || null,
      // Lien direct vers la facture dans QuickBooks : au moment de décider si on
      // la paie, la pièce justificative est à un clic. NULL tant que la facture
      // n'est pas publiée à QB (rien à ouvrir).
      qb_url: b.quickbooks_id ? qbEntityUrl('bill', b.quickbooks_id) : null,
      // Coché = un paiement émis existe pour cette facture.
      paid: !!b.payment_id,
      payment_id: b.payment_id || null,
      payment_date: b.payment_date ? dayOnly(b.payment_date) : null,
      payment_cleared: !!b.cleared_at,
      account,
      account_is_card: accountsByName.get(account)?.kind === 'card',
      method: b.payment_method || (hint?.method && hint.direction !== 'in' ? hint.method : 'interac'),
      note: hint?.note || null,
      particularites: hint?.particularites || null,
      deferred: deferActive,
      defer_reason: def?.reason || null,
      defer_until: def?.defer_until || null,
      defer_expired: !!def && !deferActive,
      bucket: bucketOf(due, todayStr, week.end),
    })
  }

  const active = items.filter(i => !i.deferred)
  const inWeek = active.filter(i => i.bucket === 'late' || i.bucket === 'week')
  // Une facture déjà réglée par un paiement émis n'est plus une décision à
  // prendre : elle QUITTE complètement la cédule. Sa suite se joue dans
  // /paiements-emis, onglet « À passer à la banque » — un seul endroit par état,
  // pas de section « déjà payées » qui redirait la même chose ici.
  // Elle continue en revanche de grever le solde : le paiement est émis,
  // l'argent va sortir — d'où `paid_cad`, qui explique l'écart entre le reste à
  // payer et ce que la cédule retire du compte.
  const paidItems = active.filter(i => i.paid)
  const toPay = active.filter(i => !i.paid)
  const cadSum = list => r2(list.filter(i => (i.currency || 'CAD') === 'CAD').reduce((s, i) => s + i.amount, 0))
  const byCurrency = list => {
    const out = {}
    for (const i of list) {
      const c = i.currency || 'CAD'
      if (c === 'CAD') continue
      out[c] = r2((out[c] || 0) + i.amount)
    }
    return out
  }

  // ── Confrontation au solde disponible BNC ──────────────────────────────────
  const balanceRow = db.prepare('SELECT * FROM treasury_balances ORDER BY noted_at DESC LIMIT 1').get() || null
  const staleDays = Math.max(1, Number(cfg.balance_stale_days) || 7)
  const balanceAgeDays = balanceRow
    ? Math.floor((today - new Date(balanceRow.noted_at)) / (24 * 3600 * 1000))
    : null
  // Les sorties récurrentes de la semaine tombent quoi qu'il arrive : le solde
  // qui reste après la cédule doit les compter, sinon on se croit plus riche.
  const recurringWeek = occurrences
    .filter(o => o.date >= week.start && o.date <= week.end)
    .sort((a, b) => a.date.localeCompare(b.date))
  const recurringTotal = r2(recurringWeek.reduce((s, o) => s + o.amount, 0))
  // Seules les sorties depuis le compte projeté (BNC CAD) grèvent le solde ; ce
  // qui part de la carte ou d'un compte USD ne le touche pas.
  const weekFromBnc = inWeek.filter(i => (i.currency || 'CAD') === 'CAD' && i.account === TREASURY_BANK_ACCOUNT)
  const weekTotalCad = cadSum(inWeek)
  const fromBncTotal = cadSum(weekFromBnc)
  const available = balanceRow ? r2(balanceRow.balance) : null
  const threshold = Number(cfg.threshold) || 0

  const balance = {
    account: TREASURY_BANK_ACCOUNT,
    available,
    noted_at: balanceRow?.noted_at || null,
    age_days: balanceAgeDays,
    stale: balanceAgeDays == null || balanceAgeDays >= staleDays,
    threshold,
    week_outflow: fromBncTotal,
    // Décomposition du même total : ce qui reste à décider, et ce qui est déjà
    // parti en paiement émis (plus listé dans la cédule, mais toujours à sortir
    // du compte — sans ces deux lignes le solde affiché ne serait plus
    // explicable depuis l'écran).
    week_outflow_to_pay: cadSum(weekFromBnc.filter(i => !i.paid)),
    week_outflow_paid: cadSum(weekFromBnc.filter(i => i.paid)),
    recurring_week: recurringTotal,
    after_week: available == null ? null : r2(available - fromBncTotal - recurringTotal),
    below_threshold: available != null && r2(available - fromBncTotal - recurringTotal) < threshold,
    negative: available != null && r2(available - fromBncTotal - recurringTotal) < 0,
  }

  return {
    generated_at: new Date().toISOString(),
    today: todayStr,
    week,
    // Les compteurs comptent ce qu'il RESTE à décider : une facture payée n'est
    // plus « à payer cette semaine ».
    counts: {
      late: toPay.filter(i => i.bucket === 'late').length,
      week: toPay.filter(i => i.bucket === 'week').length,
      later: toPay.filter(i => i.bucket === 'later').length,
      paid: paidItems.length,
      deferred: items.filter(i => i.deferred).length,
      excluded: excluded.length,
    },
    totals: {
      week_cad: weekTotalCad,
      week_paid_cad: cadSum(inWeek.filter(i => i.paid)),
      week_remaining_cad: cadSum(inWeek.filter(i => !i.paid)),
      week_other_currencies: byCurrency(inWeek.filter(i => !i.paid)),
      late_cad: cadSum(toPay.filter(i => i.bucket === 'late')),
      later_cad: cadSum(toPay.filter(i => i.bucket === 'later')),
      paid_cad: cadSum(paidItems),
      deferred_cad: cadSum(items.filter(i => i.deferred)),
      recurring_week: recurringTotal,
    },
    // Groupé par fournisseur (une ligne par facture dessous), échéance d'abord.
    // Uniquement ce qui reste à payer : une facture réglée a quitté la cédule.
    vendors: groupByVendor(inWeek.filter(i => !i.paid)),
    later: groupByVendor(toPay.filter(i => i.bucket === 'later')),
    deferred: items.filter(i => i.deferred),
    excluded,
    recurring: recurringWeek,
    // Les Visa à payer, À CÔTÉ des factures fournisseurs et non dedans : elles
    // n'ont ni fournisseur, ni échéance négociable, et leur montant est une
    // saisie humaine souvent absente. Volontairement exclues des totaux — un
    // cumul qui bougerait selon qu'on a tapé ou non le solde serait trompeur.
    cards: listOpenCardDues(),
    balance,
    mastercard: cardOutlook({ cfg, items: inWeek, week }),
  }
}

// Compte à débiter proposé : celui du dernier paiement au même fournisseur (si
// sa devise colle), sinon un compte de la bonne devise, sinon le compte projeté.
function suggestedAccountName(bill, hint, accountsByName) {
  const cur = bill.currency || 'CAD'
  if (hint?.account && hint.direction !== 'in'
    && (accountsByName.get(hint.account)?.currency || 'CAD') === cur) return hint.account
  if (cur === 'CAD') return TREASURY_BANK_ACCOUNT
  for (const a of accountsByName.values()) {
    if (a.kind === 'bank' && (a.currency || 'CAD') === cur) return a.name
  }
  return TREASURY_BANK_ACCOUNT
}

// ── Carte de crédit : le solde projeté ne doit pas dépasser le seuil ─────────
// Une partie des fournisseurs se paie par Mastercard. La carte a une limite
// (15 000 $) et un paiement pré-programmé le 5 : charger 12 000 $ de plus la
// veille, c'est se retrouver sans moyen de paiement. On projette donc, ligne à
// ligne : solde du dernier relevé + achats déjà émis mais pas encore au relevé
// + ce que la cédule propose de mettre sur la carte − les paiements de carte
// déjà émis et l'occurrence pré-programmée de la semaine.
export function cardOutlook({ cfg, items, week }) {
  const name = cfg.mc_account || 'MasterCard BNC'
  const acc = db.prepare('SELECT * FROM bank_accounts WHERE name = ? AND deleted_at IS NULL').get(name)
  const threshold = Number(cfg.mc_alert_threshold) || 0
  const limit = Number(cfg.mc_limit) || 0
  if (!acc) return { account: name, available_data: false, threshold, limit }

  const summary = summarizeAccount(acc.id)
  // Convention carte : `statement.balance` est le solde DÛ (positif).
  const current = summary?.statement?.balance != null ? r2(summary.statement.balance) : null
  const statementDate = summary?.statement?.date || null

  // Achats déjà émis sur la carte, pas encore passés (donc pas au relevé).
  const chargesRows = db.prepare(`
    SELECT id, label, amount, payment_date FROM treasury_payments
    WHERE deleted_at IS NULL AND cleared_at IS NULL AND direction = 'out' AND account = ?
  `).all(name)
  const charges_pending = r2(chargesRows.reduce((s, p) => s + Number(p.amount), 0))

  // Paiements de la carte déjà émis (banque → carte), pas encore passés.
  const paymentRows = db.prepare(`
    SELECT id, label, amount, payment_date FROM treasury_payments
    WHERE deleted_at IS NULL AND cleared_at IS NULL
      AND ((counterparty_account = ? AND direction = 'out') OR (account = ? AND direction = 'in'))
  `).all(name, name)
  const emitted_card_payments = r2(paymentRows.reduce((s, p) => s + Number(p.amount), 0))

  // Occurrence pré-programmée de la semaine (Mastercard le 5) : elle fait
  // baisser le solde. Repérée par le nom du compte dans le libellé récurrent.
  const recurring = db.prepare(
    'SELECT * FROM recurring_outflows WHERE deleted_at IS NULL AND active = 1'
  ).all().filter(r => {
    const k = vendorKey(r.label)
    return k.includes('mastercard') || k.includes(vendorKey(name))
  })
  const preprogrammed = []
  for (const r of recurring) {
    if (!(Number(r.amount) > 0)) continue
    const dates = r.variable_amount
      ? [variableOccurrence(r, week.start, week.end)].filter(Boolean)
      : expandRecurring(r, week.start, week.end)
    for (const date of dates) preprogrammed.push({ label: r.label, date, amount: r2(r.amount) })
  }
  const preprogrammed_total = r2(preprogrammed.reduce((s, o) => s + o.amount, 0))

  // Ce que la cédule propose de charger sur la carte (paiements pas encore émis
  // dont le compte proposé est la carte) — c'est LA question de la semaine.
  const scheduledItems = (items || []).filter(i => !i.paid && i.account === name)
  const scheduled = r2(scheduledItems.reduce((s, i) => s + i.amount, 0))

  const card_payments = r2(emitted_card_payments + preprogrammed_total)
  const projected = current == null ? null
    : projectCard({ current, charges_pending, scheduled, card_payments })

  return {
    account: name,
    available_data: current != null,
    current,
    statement_date: statementDate,
    charges_pending,
    charges_pending_count: chargesRows.length,
    scheduled,
    scheduled_count: scheduledItems.length,
    emitted_card_payments,
    preprogrammed,
    preprogrammed_total,
    card_payments,
    projected,
    threshold,
    limit,
    room: projected == null || !limit ? null : r2(limit - projected),
    over_threshold: projected != null && threshold > 0 && projected > threshold,
    over_limit: projected != null && limit > 0 && projected > limit,
  }
}
