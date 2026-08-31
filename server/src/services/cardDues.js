import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { createPayment, getPayment } from './treasuryPayments.js'
import { nowIso } from '../utils/datetime.js'

// Paiement mensuel des cartes Visa (CAD et USD).
//
// Ces deux cartes se paient vers le 25, mais elles n'existaient nulle part dans
// l'ERP avant d'être payées : le rappel Slack est purement notificatif et
// l'import Pmt_Suivi ne les ramène qu'après coup. Elles se présentent
// maintenant d'elles-mêmes dans la cédule une semaine avant l'échéance.
//
// Le solde n'est disponible sur aucun canal automatique : le montant se saisit
// à la main, et une ligne sans montant est normale — c'est un rappel, pas une
// dette chiffrée. Tant qu'elle n'est pas payée, elle ne compte donc dans aucun
// total : un cumul qui bougerait selon qu'on a tapé ou non le solde serait
// trompeur. Une fois payée, la ligne devient un treasury_payments ordinaire et
// reprend son rôle habituel (projection, appariement bancaire, cleared_at).

// Libellés repris de l'historique (`treasury_payments.label` vaut « Visa CAD » /
// « Visa USD » depuis janvier) : l'appariement au relevé et les modèles de
// paiement reconnaissent ainsi les nouvelles lignes comme les anciennes.
export const CARDS = [
  { card_account: 'VISA Desjardins CAD', pay_account: 'BNC CAD', currency: 'CAD', label: 'Visa CAD' },
  { card_account: 'VISA Desjardins USD', pay_account: 'BNC USD', currency: 'USD', label: 'Visa USD' },
]

export const DUE_DAY = 25
export const LEAD_DAYS = 7

const dayOnly = (v) => (v ? String(v).slice(0, 10) : null)
const r2 = (n) => Math.round(Number(n) * 100) / 100
// Midi UTC : décaler une date civile sans se faire piéger par un changement
// d'heure, comme partout ailleurs dans le module trésorerie.
export function shiftIso(iso, days) {
  return new Date(new Date(`${iso}T12:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10)
}

// Échéance du mois d'un jour donné, bornée à la fin du mois (février n'a pas de 30).
export function dueDateFor(dayIso, dueDay = DUE_DAY) {
  const [y, m] = dayIso.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const d = Math.min(dueDay, lastDay)
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Crée les lignes du mois dès que la date d'apparition est atteinte.
 *
 * Appelée à chaque construction de la cédule plutôt que par un cron : la page
 * est relue en permanence, les lignes apparaissent donc d'elles-mêmes le jour
 * dit sans tâche planifiée à surveiller — et une période sautée (serveur
 * arrêté, personne n'ouvre la page) se rattrape au premier affichage suivant.
 * L'idempotence tient à l'index UNIQUE(period, card_account).
 */
export function ensureCardDues({ today = new Date(), dueDay = DUE_DAY, leadDays = LEAD_DAYS } = {}) {
  const todayIso = typeof today === 'string' ? today.slice(0, 10) : today.toISOString().slice(0, 10)
  const due = dueDateFor(todayIso, dueDay)
  const showFrom = shiftIso(due, -leadDays)
  // Avant la date d'apparition : rien à créer ce mois-ci. Après l'échéance, la
  // ligne du mois reste ouverte tant qu'elle n'est pas payée ou écartée — un
  // paiement en retard doit continuer de se voir.
  if (todayIso < showFrom) return { created: 0, period: due.slice(0, 7) }

  const period = due.slice(0, 7)
  const insert = db.prepare(`
    INSERT INTO card_payment_dues (id, period, card_account, pay_account, currency, label, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const exists = db.prepare(
    'SELECT id FROM card_payment_dues WHERE period = ? AND card_account = ? AND deleted_at IS NULL'
  )
  let created = 0
  const run = db.transaction(() => {
    for (const c of CARDS) {
      if (exists.get(period, c.card_account)) continue
      insert.run(randomUUID(), period, c.card_account, c.pay_account, c.currency, c.label, due)
      created++
    }
  })
  run()
  if (created) console.log(`💳 Cartes à payer : ${created} ligne(s) créée(s) pour ${period}`)
  return { created, period, due_date: due, show_from: showFrom }
}

const SELECT = `
  SELECT d.*, p.cleared_at AS payment_cleared_at, p.payment_date AS paid_on
  FROM card_payment_dues d
  LEFT JOIN treasury_payments p ON p.id = d.treasury_payment_id AND p.deleted_at IS NULL
  WHERE d.deleted_at IS NULL
`

/** Cartes encore à payer : ni réglées, ni écartées pour le mois. */
export function listOpenCardDues() {
  return db.prepare(`${SELECT}
      AND d.dismissed_at IS NULL
      AND (d.treasury_payment_id IS NULL OR p.id IS NULL)
    ORDER BY d.due_date ASC, d.card_account ASC
  `).all()
}

export function getCardDue(id) {
  return db.prepare(`${SELECT} AND d.id = ?`).get(id) || null
}

/** Saisie à la main du solde et de la date. Autosave : un champ à la fois. */
export function updateCardDue(id, body = {}) {
  const row = getCardDue(id)
  if (!row) return { error: 'Ligne introuvable', status: 404 }
  const sets = []
  const values = []
  if ('amount' in body) {
    const v = body.amount === '' || body.amount == null ? null : Number(body.amount)
    // Zéro est une valeur légitime : certains mois la carte n'a servi à rien.
    // C'est une information (« vérifié, rien à payer »), à distinguer de NULL
    // qui veut dire « solde pas encore relevé ».
    if (v != null && (!Number.isFinite(v) || v < 0)) return { error: 'Montant invalide', status: 400 }
    sets.push('amount = ?'); values.push(v == null ? null : r2(v))
  }
  if ('payment_date' in body) {
    const v = dayOnly(body.payment_date)
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: 'payment_date au format YYYY-MM-DD', status: 400 }
    sets.push('payment_date = ?'); values.push(v || null)
  }
  if (!sets.length) return { error: 'Aucun champ modifiable fourni', status: 400 }
  db.prepare(`UPDATE card_payment_dues SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...values, nowIso(), id)
  return { due: getCardDue(id) }
}

/**
 * « Payer » : crée le paiement émis, exactement comme payBill() le fait pour une
 * facture. La ligne quitte la cédule et réapparaît dans « À passer à la banque ».
 */
export function payCardDue(id, { amount = null, payment_date = null } = {}, userId = null) {
  const row = getCardDue(id)
  if (!row) return { error: 'Ligne introuvable', status: 404 }
  if (row.treasury_payment_id && getPayment(row.treasury_payment_id)) {
    return { payment: getPayment(row.treasury_payment_id), created: false }
  }
  const value = Number(amount ?? row.amount)
  if (!Number.isFinite(value) || value < 0) {
    return { error: 'Saisir le solde de la carte avant de la cocher', status: 400 }
  }
  // Solde à zéro : aucune dépense ce mois-ci. Il n'y a pas de paiement à
  // émettre — créer une ligne à 0 $ polluerait « À passer à la banque » et la
  // projection. On classe le mois comme réglé, ce qui est la vérité.
  if (value === 0) {
    db.prepare('UPDATE card_payment_dues SET amount = 0, dismissed_at = ?, updated_at = ? WHERE id = ?')
      .run(nowIso(), nowIso(), id)
    return { payment: null, created: false, nothingToPay: true, due: getCardDue(id) }
  }
  const date = dayOnly(payment_date) || row.payment_date || row.due_date

  // Filet : une clé retenue par un paiement déjà supprimé (annulation faite
  // avant le correctif, ou suppression depuis « À passer à la banque », qui ne
  // passe pas par unpayCardDue) bloquerait l'insertion.
  const key = `carte:${row.period}|${row.card_account}`
  db.prepare('UPDATE treasury_payments SET import_key = NULL WHERE import_key = ? AND deleted_at IS NOT NULL').run(key)

  const payment = createPayment({
    payment_date: date,
    direction: 'out',
    amount: value,
    currency: row.currency,
    account: row.pay_account,
    counterparty_account: row.card_account,
    label: row.label || row.card_account,
    method: 'carte',
    source: 'card',
    // Même convention d'idempotence que pmtsuivi: / soldesheet: — si l'import
    // Pmt_Suivi ramène plus tard la même ligne du Google Sheet, sa clé diffère,
    // mais celle-ci garantit qu'on ne crée pas deux fois le paiement du mois.
    import_key: key,
  }, userId)

  db.prepare('UPDATE card_payment_dues SET treasury_payment_id = ?, amount = ?, payment_date = ?, updated_at = ? WHERE id = ?')
    .run(payment.id, r2(value), date, nowIso(), id)
  return { payment, created: true }
}

/** Annule le paiement et remet la carte dans la cédule, avec son montant. */
export function unpayCardDue(id) {
  const row = getCardDue(id)
  if (!row) return { error: 'Ligne introuvable', status: 404 }
  if (!row.treasury_payment_id) return { ok: true, deleted: 0 }
  const payment = getPayment(row.treasury_payment_id)
  if (payment?.cleared_at) {
    return { error: 'Paiement déjà passé à la banque — le décocher dans « À passer à la banque »', status: 409 }
  }
  if (payment) {
    // La clé d'idempotence doit être RELÂCHÉE en même temps que le paiement est
    // supprimé : l'index UNIQUE `idx_treasury_pmt_import` ne porte que sur
    // `import_key IS NOT NULL`, pas sur `deleted_at IS NULL`. Sans ça, annuler
    // puis re-payer la même carte le même mois échouait sur
    // « UNIQUE constraint failed: treasury_payments.import_key ».
    db.prepare(`
      UPDATE treasury_payments
      SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), import_key = NULL
      WHERE id = ?
    `).run(payment.id)
  }
  db.prepare('UPDATE card_payment_dues SET treasury_payment_id = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id)
  return { ok: true, deleted: payment ? 1 : 0, due: getCardDue(id) }
}

/** « Rien à payer ce mois-ci » — la ligne revient le mois suivant. */
export function dismissCardDue(id, dismissed = true) {
  const row = getCardDue(id)
  if (!row) return { error: 'Ligne introuvable', status: 404 }
  db.prepare('UPDATE card_payment_dues SET dismissed_at = ?, updated_at = ? WHERE id = ?')
    .run(dismissed ? nowIso() : null, nowIso(), id)
  return { due: getCardDue(id) }
}
