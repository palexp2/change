// Suivi de PLAFOND des cartes de crédit d'opération.
//
// Le trou que ça comble : l'automation « Rappel de paiement des cartes »
// (cardPaymentReminder.js) rappelle de PAYER la carte avant sa date cible. Elle
// ne dit rien de la question qui bloque réellement les opérations : « la carte
// a-t-elle encore de la place ? ». La Mastercard BNC (limite 15 000 $) sert à
// payer une partie des fournisseurs et son paiement est PRÉ-PROGRAMMÉ le 4 —
// charger 12 000 $ la veille, c'est se retrouver sans moyen de paiement pendant
// une semaine. Les deux automations coexistent : celle-ci ne remplace rien.
//
// Trois principes portent le calcul :
//
//   1. Le solde vient de QuickBooks — c'est la seule source qui fasse foi pour
//      la comptabilité. Un compte de type « Credit Card » y a un CurrentBalance
//      NÉGATIF quand il est dû ; on le retourne en « montant dû » positif, comme
//      partout ailleurs dans le module trésorerie.
//   2. QuickBooks est en retard sur la réalité. Les achats du relevé bancaire
//      pas encore comptabilisés (bank_transactions à traiter / facture reçue)
//      sont ajoutés, sinon on sous-estime le solde — l'erreur exactement dans le
//      mauvais sens pour une alerte de plafond. Les deux chiffres restent
//      SÉPARÉS à l'écran : « comptabilisé » et « en attente » ne se vérifient
//      pas de la même façon.
//   3. Le montant recommandé est ce qu'il faut payer pour repasser SOUS le
//      plafond, arrondi au dollar supérieur. Arrondir vers le bas laisserait la
//      carte à un cheveu du plafond après le paiement.
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { qbGet } from '../connectors/quickbooks.js'
import { resolveAccountByAcctNum } from './quickbooks.js'
import { payDateForDue } from '../utils/bankDays.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { logSync } from './syncLog.js'
import { sendSlack } from './slack.js'
import { APP_URL } from '../config/appUrl.js'
import { nowIso, localDay } from '../utils/datetime.js'
export { localDay }

export const CARD_CEILING_AUTOMATION_ID = 'sys_card_ceiling_alert'

export const CARD_CEILING_DEFAULT_CONFIG = {
  // Comptes QB (numéros) suivis. Une carte de la table qui n'est pas listée ici
  // reste affichée dans l'ERP mais n'alerte pas.
  acctnums: '22000',
  // J-N avant le prélèvement pré-programmé.
  lead_days: '5',
  // Dépassement minimal (CAD) pour qu'une alerte parte — un franchissement de
  // 3 $ n'est pas une information.
  min_alert_amount: '100',
  // Ancienneté maximale d'une transaction « pas encore comptabilisée » comptée
  // dans le solde en attente. Au-delà, c'est un retard de tenue de livres, pas
  // un achat qui manque au solde (le relevé de ce mois-là est payé depuis
  // longtemps) — l'ajouter ferait crier l'alerte pour rien.
  pending_lookback_days: '90',
  // À '0', l'alerte J-N ne part que s'il y a un paiement à faire (plafond
  // franchi). À '1', elle part tous les mois même quand tout va bien.
  // Défaut '0' : le canal comptabilité est volontairement silencieux.
  lead_always: '0',
  slack_channel: '#comptabilite',
  slack_webhook_url: '',
  slack_webhook_env: 'SLACK_WEBHOOK_TREASURY',
}

const r2 = n => Math.round(Number(n || 0) * 100) / 100
const dayOnly = v => String(v || '').slice(0, 10)

// Midi UTC : additionner des jours sans se faire piéger par l'heure avancée.
const dayToDate = iso => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayOnly(iso))
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)) : null
}
const dateToDay = d => d.toISOString().slice(0, 10)
export const daysBetween = (a, b) => Math.round((dayToDate(b) - dayToDate(a)) / 86400000)

export function getCardCeilingConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(CARD_CEILING_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...CARD_CEILING_DEFAULT_CONFIG }
  for (const k of Object.keys(CARD_CEILING_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

// ── Calcul pur ───────────────────────────────────────────────────────────────

/**
 * Prochaine occurrence du jour de prélèvement, à partir de `todayIso` (inclus).
 * Bornée à la fin du mois : février n'a pas de 31.
 */
export function nextDraftDate(todayIso, draftDay) {
  const d = dayToDate(todayIso)
  if (!d || !Number.isInteger(Number(draftDay))) return null
  const day = Math.min(31, Math.max(1, Number(draftDay)))
  const at = (y, m) => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
    return dateToDay(new Date(Date.UTC(y, m, Math.min(day, last), 12)))
  }
  const thisMonth = at(d.getUTCFullYear(), d.getUTCMonth())
  if (thisMonth >= dayOnly(todayIso)) return thisMonth
  return at(d.getUTCFullYear(), d.getUTCMonth() + 1)
}

/**
 * Les chiffres d'une carte. Pur — c'est le calcul que l'alerte doit pouvoir
 * justifier ligne à ligne, et celui que les tests couvrent.
 *
 * `posted` = solde dû comptabilisé dans QuickBooks (positif = dette).
 * `pending` = achats connus de l'ERP pas encore comptabilisés (positif = dette).
 */
export function computeCardCeiling({
  posted = 0, pending = 0, ceiling = 0, credit_limit = 0, draft_day = null, today,
}) {
  const projected = r2(Number(posted) + Number(pending))
  const ceil = Number(ceiling) || 0
  const limit = Number(credit_limit) || 0
  // Marge restante AVANT le plafond cible (pas avant la limite de la carte) :
  // c'est le plafond qui pilote la décision, la limite n'est qu'un garde-fou.
  const room = ceil > 0 ? r2(ceil - projected) : null
  // Assez pour repasser SOUS le plafond, arrondi au dollar SUPÉRIEUR : payer
  // 4 253,40 $ pile laisserait le solde collé au plafond au cent près.
  const recommended = ceil > 0 && projected > ceil ? Math.ceil(projected - ceil) : 0
  const draft_date = draft_day ? nextDraftDate(today, draft_day) : null
  const pay = draft_date ? payDateForDue(draft_date, today) : null
  return {
    posted: r2(posted),
    pending: r2(pending),
    projected,
    ceiling: ceil || null,
    credit_limit: limit || null,
    room,
    room_to_limit: limit > 0 ? r2(limit - projected) : null,
    recommended,
    over_ceiling: ceil > 0 && projected > ceil,
    over_limit: limit > 0 && projected > limit,
    draft_date,
    days_to_draft: draft_date ? daysBetween(today, draft_date) : null,
    pay_date: pay?.date || null,
    pay_reason: pay?.reason || null,
    pay_holiday: pay?.holiday || null,
  }
}

/**
 * Faut-il alerter, et de quel type ? Pur, pour être testable sans DB ni Slack.
 *
 * `sentKinds` = types déjà envoyés pour cette carte CE MOIS-CI (Set/array).
 * C'est là que se joue l'anti-doublon : une alerte par carte, par mois et par
 * type. Les deux types ne s'excluent pas — une carte qui a déjà crié « plafond
 * franchi » le 20 doit quand même recevoir son rappel J-5 avec le montant.
 */
export function decideCardAlert(outlook, {
  leadDays = 5, minAmount = 0, leadAlways = false, sentKinds = [],
} = {}) {
  const sent = new Set(Array.isArray(sentKinds) ? sentKinds : [...sentKinds])
  const inWindow = outlook.days_to_draft != null
    && outlook.days_to_draft >= 0 && outlook.days_to_draft <= Number(leadDays)
  const excess = outlook.ceiling ? r2(outlook.projected - outlook.ceiling) : 0
  const material = outlook.over_ceiling && excess >= Number(minAmount || 0)

  if (inWindow) {
    if (sent.has('lead')) return null
    if (!material && !leadAlways) return null
    return { kind: 'lead' }
  }
  // Hors fenêtre : on ne parle que d'un franchissement réel, et une seule fois.
  if (!material) return null
  if (sent.has('breach')) return null
  return { kind: 'breach' }
}

// ── Cartes suivies (configuration) ───────────────────────────────────────────

const SELECT_CARDS = `
  SELECT c.*, b.name AS bank_account_name
  FROM card_ceilings c
  LEFT JOIN bank_accounts b ON b.id = c.bank_account_id AND b.deleted_at IS NULL
  WHERE c.deleted_at IS NULL
`

export function listCards() {
  return db.prepare(`${SELECT_CARDS} ORDER BY c.name COLLATE NOCASE`).all()
}

export function getCard(id) {
  return db.prepare(`${SELECT_CARDS} AND c.id = ?`).get(id) || null
}

const NUMERIC_FIELDS = new Set(['credit_limit', 'ceiling'])
const EDITABLE = ['name', 'qb_acctnum', 'bank_account_id', 'credit_limit', 'ceiling', 'draft_day', 'currency', 'active']

/** Autosave : un champ à la fois, validé côté serveur (jamais côté front seul). */
export function updateCard(id, body = {}) {
  const row = getCard(id)
  if (!row) return { error: 'Carte introuvable', status: 404 }
  const sets = []
  const values = []
  for (const k of EDITABLE) {
    if (!(k in body)) continue
    let v = body[k]
    if (k === 'name') {
      v = String(v || '').trim()
      if (!v) return { error: 'Le nom de la carte est obligatoire', status: 400 }
    } else if (k === 'qb_acctnum') {
      v = String(v ?? '').trim() || null
      if (v && !/^\d{1,10}$/.test(v)) return { error: 'Le compte QuickBooks est un numéro de compte (chiffres)', status: 400 }
    } else if (NUMERIC_FIELDS.has(k)) {
      v = v === '' || v == null ? null : Number(v)
      if (v != null && (!Number.isFinite(v) || v < 0)) return { error: `${k} : montant invalide`, status: 400 }
      if (v != null) v = r2(v)
    } else if (k === 'draft_day') {
      v = v === '' || v == null ? null : Number(v)
      if (v != null && (!Number.isInteger(v) || v < 1 || v > 31)) {
        return { error: 'Le jour de prélèvement est un jour du mois (1 à 31)', status: 400 }
      }
    } else if (k === 'active') {
      v = v ? 1 : 0
    } else {
      v = v === '' || v == null ? null : String(v)
    }
    sets.push(`${k} = ?`)
    values.push(v)
  }
  if (!sets.length) return { error: 'Aucun champ modifiable fourni', status: 400 }
  // Le plafond au-dessus de la limite n'a aucun sens : il ne protégerait rien.
  const next = { ...row, ...body }
  const ceil = Number(next.ceiling), lim = Number(next.credit_limit)
  if (ceil > 0 && lim > 0 && ceil > lim) {
    return { error: 'Le plafond cible doit rester sous la limite de crédit', status: 400 }
  }
  db.prepare(`UPDATE card_ceilings SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id)
  return { card: getCard(id) }
}

export function createCard(body = {}) {
  const name = String(body.name || '').trim()
  if (!name) return { error: 'Le nom de la carte est obligatoire', status: 400 }
  if (db.prepare('SELECT 1 FROM card_ceilings WHERE name = ? AND deleted_at IS NULL').get(name)) {
    return { error: 'Une carte porte déjà ce nom', status: 409 }
  }
  const id = randomUUID()
  db.prepare(`
    INSERT INTO card_ceilings (id, name, qb_acctnum, bank_account_id, credit_limit, ceiling, draft_day, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name,
    String(body.qb_acctnum ?? '').trim() || null,
    body.bank_account_id || null,
    body.credit_limit == null || body.credit_limit === '' ? null : r2(body.credit_limit),
    body.ceiling == null || body.ceiling === '' ? null : r2(body.ceiling),
    body.draft_day == null || body.draft_day === '' ? null : Number(body.draft_day),
    String(body.currency || 'CAD'),
  )
  return { card: getCard(id) }
}

/** Soft delete — la carte sort du suivi, son historique d'alertes reste. */
export function deleteCard(id) {
  const row = getCard(id)
  if (!row) return { error: 'Carte introuvable', status: 404 }
  db.prepare('UPDATE card_ceilings SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id)
  return { ok: true }
}

/**
 * Seed idempotent de la Mastercard BNC (limite 15 000 $, plafond 10 000 $,
 * prélèvement le 4). N'écrase JAMAIS une config existante et ne ressuscite pas
 * une carte que l'utilisateur a retirée du suivi (on teste sans filtrer
 * deleted_at, volontairement).
 */
export function seedCardCeilings() {
  const seeds = [
    { name: 'MasterCard BNC', qb_acctnum: '22000', credit_limit: 15000, ceiling: 10000, draft_day: 4, currency: 'CAD' },
  ]
  let created = 0
  for (const s of seeds) {
    const exists = db.prepare('SELECT 1 FROM card_ceilings WHERE qb_acctnum = ? OR name = ?').get(s.qb_acctnum, s.name)
    if (exists) continue
    const bank = db.prepare('SELECT id FROM bank_accounts WHERE name = ? AND deleted_at IS NULL').get(s.name)
    db.prepare(`
      INSERT INTO card_ceilings (id, name, qb_acctnum, bank_account_id, credit_limit, ceiling, draft_day, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), s.name, s.qb_acctnum, bank?.id || null, s.credit_limit, s.ceiling, s.draft_day, s.currency)
    created++
  }
  if (created) console.log(`💳 Plafonds de cartes : ${created} carte(s) seedée(s)`)
  return { created }
}

// ── Lecture des soldes ───────────────────────────────────────────────────────

// Le CurrentBalance de QB ne bouge que quand une transaction y est saisie : un
// cache court évite d'interroger l'API à chaque rafraîchissement de la page,
// sans jamais montrer un chiffre de la veille.
const QB_CACHE_TTL_MS = 5 * 60 * 1000
const qbCache = new Map()

/** Solde COMPTABILISÉ dans QuickBooks, en « montant dû » positif. */
export async function readQbCardBalance(acctnum, { refresh = false } = {}) {
  const key = String(acctnum || '')
  if (!key) return { error: 'Aucun compte QuickBooks configuré' }
  const hit = qbCache.get(key)
  if (!refresh && hit && Date.now() - hit.at < QB_CACHE_TTL_MS) return hit.value
  const id = await resolveAccountByAcctNum(key)
  if (!id) return { error: `Compte QuickBooks ${key} introuvable` }
  const data = await qbGet(`/account/${id}`)
  const acc = data?.Account
  // Convention QB : un passif (carte de crédit) porte un CurrentBalance NÉGATIF
  // quand il est dû. On renvoie la dette en positif, comme le reste du module.
  const value = {
    qb_account_id: id,
    qb_account_name: acc?.Name || null,
    owed: r2(-Number(acc?.CurrentBalance || 0)),
    read_at: nowIso(),
  }
  qbCache.set(key, { at: Date.now(), value })
  return value
}

export function clearQbCardCache() { qbCache.clear() }

/**
 * Achats connus de l'ERP mais PAS encore comptabilisés : le relevé bancaire est
 * importé bien avant que la facture soit saisie dans QuickBooks. Les ignorer
 * sous-estimerait le solde — l'erreur dans le mauvais sens pour un plafond.
 * Un montant négatif au relevé = un achat = une dette de plus.
 *
 * Fenêtre bornée (`lookbackDays`, défaut 90) : une transaction encore « à
 * traiter » un an après coup n'est pas un achat qui manque au solde, c'est un
 * retard de tenue de livres — son relevé a été payé depuis longtemps. L'ajouter
 * gonflerait le solde projeté et ferait crier l'alerte pour rien. Les lignes
 * écartées sont comptées et remontées : rien n'est caché.
 */
export function pendingChargesFor(bankAccountId, { today = null, lookbackDays = 90 } = {}) {
  if (!bankAccountId) return { pending: 0, count: 0, stale_count: 0, stale_amount: 0, since: null, rows: [] }
  const dayIso = today || localDay()
  const since = dateToDay(new Date(dayToDate(dayIso).getTime() - Number(lookbackDays) * 86400000))
  const all = db.prepare(`
    SELECT id, txn_date, amount, COALESCE(details, description) AS label, status
    FROM bank_transactions
    WHERE account_id = ? AND deleted_at IS NULL AND status IN ('a_traiter', 'facture_recue')
    ORDER BY txn_date DESC
  `).all(bankAccountId)
  const rows = all.filter(r => dayOnly(r.txn_date) >= since)
  const stale = all.filter(r => dayOnly(r.txn_date) < since)
  return {
    pending: r2(rows.reduce((s, r) => s - Number(r.amount || 0), 0)),
    count: rows.length,
    stale_count: stale.length,
    stale_amount: r2(stale.reduce((s, r) => s - Number(r.amount || 0), 0)),
    since,
    rows: rows.slice(0, 12),
  }
}

/**
 * L'état complet d'une carte : chiffres QB, en attente, projection, marge et
 * paiement recommandé. Ne throw jamais sur une panne QuickBooks — la carte
 * remonte avec `qb_error` et l'UI le dit, plutôt qu'un dashboard blanc.
 */
export async function buildCardOutlook(card, { today = null, refresh = false, lookbackDays = 90 } = {}) {
  const dayIso = today || localDay()
  let qb = null, qbError = null
  try {
    const r = await readQbCardBalance(card.qb_acctnum, { refresh })
    if (r.error) qbError = r.error
    else qb = r
  } catch (e) {
    qbError = e.message || 'QuickBooks indisponible'
  }
  const pend = pendingChargesFor(card.bank_account_id, { today: dayIso, lookbackDays })
  const numbers = computeCardCeiling({
    posted: qb?.owed ?? 0,
    pending: pend.pending,
    ceiling: card.ceiling,
    credit_limit: card.credit_limit,
    draft_day: card.draft_day,
    today: dayIso,
  })
  return {
    id: card.id,
    name: card.name,
    qb_acctnum: card.qb_acctnum,
    qb_account_id: qb?.qb_account_id || null,
    qb_account_name: qb?.qb_account_name || null,
    bank_account_id: card.bank_account_id,
    bank_account_name: card.bank_account_name || null,
    currency: card.currency,
    draft_day: card.draft_day,
    active: card.active,
    qb_error: qbError,
    qb_read_at: qb?.read_at || null,
    pending_count: pend.count,
    pending_rows: pend.rows,
    pending_since: pend.since,
    pending_stale_count: pend.stale_count,
    pending_stale_amount: pend.stale_amount,
    today: dayIso,
    ...numbers,
  }
}

/**
 * Toutes les cartes suivies, chiffrées. Alimente la carte de /comptabilite.
 * `logRun` : journaliser la lecture QuickBooks dans sync_log. Réservé aux
 * passages de l'automation — l'affichage d'une page ne doit pas noyer le
 * journal de syncs.
 */
export async function buildCardCeilings({ today = null, refresh = false, logRun = false, trigger = 'scheduled' } = {}) {
  const t0 = Date.now()
  const lookbackDays = Math.max(1, Number(getCardCeilingConfig().pending_lookback_days) || 90)
  const cards = listCards()
  const out = []
  for (const c of cards) out.push(await buildCardOutlook(c, { today, refresh, lookbackDays }))
  if (logRun) {
    const failed = out.filter(o => o.qb_error)
    logSync('card_ceiling', trigger === 'manuel' ? 'manual' : 'scheduled', {
      status: failed.length ? 'error' : 'success',
      modified: out.length,
      error: failed.length ? failed.map(f => `${f.name} : ${f.qb_error}`).join(' · ') : null,
      durationMs: Date.now() - t0,
    })
  }
  return { cards: out, generated_at: nowIso() }
}

// ── Alerte Slack ─────────────────────────────────────────────────────────────

const fmtCad = n => new Intl.NumberFormat('fr-CA', {
  style: 'currency', currency: 'CAD', minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format(Number(n || 0))

const fmtDateFr = dayIso => {
  const d = dayToDate(dayIso)
  return d ? new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d) : String(dayIso)
}

/** Types d'alertes déjà envoyés pour cette carte au cours du mois `period`. */
export function sentKindsFor(cardId, period) {
  return db.prepare(`
    SELECT kind FROM card_ceiling_alerts
    WHERE card_id = ? AND period = ? AND deleted_at IS NULL
  `).all(cardId, period).map(r => r.kind)
}

export function recordCardAlert(cardId, period, kind, outlook) {
  try {
    db.prepare(`
      INSERT INTO card_ceiling_alerts (id, card_id, period, kind, projected, recommended)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), cardId, period, kind, outlook.projected, outlook.recommended)
    return true
  } catch {
    // Course entre deux passages (cron + exécution manuelle) : l'index UNIQUE a
    // tranché, l'autre a déjà envoyé. Ne pas envoyer deux fois.
    return false
  }
}

export function buildCeilingMessage(o, kind) {
  const appUrl = APP_URL
  // L'en-tête décrit l'ÉTAT, pas seulement le type d'alerte : un envoi forcé
  // hors fenêtre et sous le plafond ne doit pas crier « plafond franchi ».
  const head = kind === 'lead'
    ? `:credit_card: *${o.name} — prélèvement le ${fmtDateFr(o.draft_date)}* (dans ${o.days_to_draft} j)`
    : o.over_ceiling
      ? `:rotating_light: *${o.name} — plafond franchi*`
      : `:credit_card: *${o.name} — état de la carte*`
  const lines = [
    head,
    `Solde projeté *${fmtCad(o.projected)}* = ${fmtCad(o.posted)} comptabilisé + ${fmtCad(o.pending)} en attente.`,
    o.ceiling
      ? (o.over_ceiling
        ? `Plafond ${fmtCad(o.ceiling)} dépassé de *${fmtCad(o.projected - o.ceiling)}*.`
        : `Marge avant le plafond de ${fmtCad(o.ceiling)} : *${fmtCad(o.room)}*.`)
      : 'Aucun plafond configuré.',
  ]
  if (o.recommended > 0) {
    lines.push(`Paiement recommandé : *${fmtCad(o.recommended)}*, à passer le *${fmtDateFr(o.pay_date)}*`
      + (o.pay_reason === 'weekend' ? ' (le prélèvement tombe une fin de semaine)' : '')
      + (o.pay_reason === 'holiday' ? ` (le prélèvement tombe un férié : ${o.pay_holiday})` : '')
      + '.')
  }
  if (o.over_limit) lines.push(`:warning: La limite de crédit ${fmtCad(o.credit_limit)} est elle aussi dépassée.`)
  lines.push(`<${appUrl}/erp/comptabilite|Dashboard comptabilité>`)
  return lines.join('\n')
}

/**
 * Passage quotidien. Silencieux la plupart du temps : c'est voulu, le canal
 * comptabilité ne doit porter que ce qui appelle une action.
 * `force` court-circuite la fenêtre et l'anti-doublon (bouton « Exécuter »).
 */
export async function checkCardCeilings({ force = false, trigger = 'schedule', today = null, dryRun = false } = {}) {
  const t0 = Date.now()
  try {
    if (!force && !isSystemAutomationActive(CARD_CEILING_AUTOMATION_ID)) return { skipped: 'inactive' }
    const cfg = getCardCeilingConfig()
    const leadDays = Math.max(0, Number(cfg.lead_days) || 5)
    const minAmount = Math.max(0, Number(cfg.min_alert_amount) || 0)
    const leadAlways = cfg.lead_always === '1'
    const watched = String(cfg.acctnums || '').split(/[,\s]+/).filter(Boolean)
    const dayIso = today || localDay()
    const period = dayIso.slice(0, 7)

    const { cards } = await buildCardCeilings({ today: dayIso, refresh: true, logRun: true, trigger })
    const results = []
    for (const o of cards) {
      if (!o.active) { results.push({ card: o.name, skipped: 'suivi désactivé' }); continue }
      if (watched.length && !watched.includes(String(o.qb_acctnum))) {
        results.push({ card: o.name, skipped: 'compte QB hors périmètre' }); continue
      }
      if (o.qb_error) { results.push({ card: o.name, skipped: `QuickBooks : ${o.qb_error}` }); continue }

      const sent = force ? [] : sentKindsFor(o.id, period)
      // Un passage forcé (bouton « Exécuter » / « Simuler ») envoie l'état
      // ACTUEL sans condition : cliquer et ne rien recevoir ne se distingue pas
      // d'une automation cassée. Il ne consomme pas l'anti-doublon du mois,
      // donc la vraie alerte partira quand même le moment venu.
      const decision = force
        ? { kind: o.days_to_draft != null && o.days_to_draft >= 0 && o.days_to_draft <= leadDays ? 'lead' : 'breach' }
        : decideCardAlert(o, { leadDays, minAmount, leadAlways, sentKinds: sent })
      if (!decision) {
        results.push({
          card: o.name,
          skipped: sent.length ? 'déjà alerté ce mois-ci' : 'rien à signaler',
          projected: o.projected, room: o.room,
        })
        continue
      }
      const message = buildCeilingMessage(o, decision.kind)
      if (dryRun) { results.push({ card: o.name, would_send: decision.kind, message }); continue }
      // On réserve la place AVANT d'envoyer : si deux passages se croisent, un
      // seul gagne l'index UNIQUE et un seul message part.
      if (!force && !recordCardAlert(o.id, period, decision.kind, o)) {
        results.push({ card: o.name, skipped: 'déjà alerté ce mois-ci' }); continue
      }
      const res = await sendSlack({
        channel: cfg.slack_channel,
        url: cfg.slack_webhook_url,
        envName: cfg.slack_webhook_env,
        text: message,
        fallbackNote: `${cfg.slack_webhook_env} n'est pas configuré — l'alerte de plafond de ${o.name} a été redirigée ici.`,
      })
      results.push({
        card: o.name, sent: decision.kind, projected: o.projected,
        recommended: o.recommended, channel: res.channel || res.env || null,
      })
    }

    const sentCount = results.filter(r => r.sent).length
    // Un passage muet ne logge pas : sinon le journal de l'automation devient
    // illisible (une ligne par jour pour dire « rien »).
    if (sentCount || dryRun || force) {
      logSystemRun(CARD_CEILING_AUTOMATION_ID, {
        status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger, day: dayIso },
        result: dryRun
          ? `SIMULATION — ${results.map(r => `${r.card} : ${r.would_send || r.skipped}`).join(' · ')}`
          : `PLAFOND — ${results.filter(r => r.sent).map(r => `${r.card} (${r.sent}) projeté ${fmtCad(r.projected)}, recommandé ${fmtCad(r.recommended)}`).join(' · ') || 'aucune alerte'}`,
      })
    }
    return { ok: true, day: dayIso, period, sent: sentCount, results }
  } catch (e) {
    logSystemRun(CARD_CEILING_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e,
    })
    console.error('cardCeiling:', e.message)
    return { error: e.message }
  }
}

/** Diagnostic (bouton « Simuler ») : les chiffres et ce qui partirait, sans envoi. */
export async function diagnoseCardCeilings() {
  return await checkCardCeilings({ trigger: 'manuel', dryRun: true, force: true })
}
