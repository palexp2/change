// « Facture manquante » — la liste que Charles constitue à la main depuis le
// relevé, et le message qu'il envoie à ses collègues sur Slack.
//
// Deux choses distinctes, à ne pas confondre :
//   • invoice_needs        → détection automatique (pastille « N sans facture »)
//   • missing_invoice_requests → ce que Charles a explicitement demandé
// Rien ne passe de l'une à l'autre : la liste ne se remplit que par le bouton
// « Facture manquante » de la barre de sélection (décision de Charles,
// 2026-09-29).
//
// `in_send` sépare « je cherche encore cette facture » de « je la mets dans le
// message » : décocher une ligne la sort de l'envoi, jamais de la liste.
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { nowIso } from '../utils/datetime.js'
import { sendSlack } from './slack.js'
import { resolveVendorFromBankLabel } from './scrapers/vendorFromBankLabel.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

export const MISSING_INVOICE_AUTOMATION_ID = 'sys_missing_invoice_request'

const DEFAULT_CONFIG = {
  slack_channel: '',
  slack_webhook_url: '',
  slack_webhook_env: '',
  intro: 'Je cherche {n} facture{s} ({total}) pour fermer les livres.',
  outro: 'Si vous en avez une, répondez ici ou envoyez-la à factures@orisha.io — merci !',
}

export function getMissingInvoiceConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(MISSING_INVOICE_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...DEFAULT_CONFIG }
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

// Le fournisseur affiché : son nom de fiche quand le libellé du relevé le
// désigne, sinon le libellé lui-même — un collègue doit reconnaître l'achat.
function vendorOf(row) {
  const hit = resolveVendorFromBankLabel(row.label)
  if (hit?.profile?.name) return hit.profile.name
  // Pas de fiche fournisseur : le libellé du relevé colle la ville et la
  // province derrière une longue suite d'espaces — on ne garde que le début,
  // seul morceau qu'un collègue reconnaît.
  const raw = String(row.label || '').trim()
  return raw.split(/\s{2,}/)[0] || raw || '(sans description)'
}

const money = (amount, currency) =>
  `${Math.abs(Number(amount) || 0).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency === 'USD' ? '$ US' : '$'}`

const frDate = (iso) => {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return String(iso || '')
  return d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

const ageDays = (iso) =>
  Math.max(0, Math.round((Date.now() - new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).getTime()) / 86400_000))

/** La liste complète, la plus vieille d'abord — c'est l'ancienneté qui presse. */
export function listRequests() {
  const rows = db.prepare(`
    SELECT r.id, r.bank_txn_id, r.in_send, r.last_sent_at, r.created_at,
           t.txn_date, t.amount, t.reference, t.check_number,
           COALESCE(NULLIF(t.details, ''), t.description) AS label,
           t.description, a.name AS account_name, a.currency
    FROM missing_invoice_requests r
    JOIN bank_transactions t ON t.id = r.bank_txn_id
    JOIN bank_accounts a ON a.id = t.account_id
    WHERE t.deleted_at IS NULL
    ORDER BY t.txn_date ASC
  `).all()
  return rows.map((r) => ({
    ...r,
    in_send: r.in_send ? 1 : 0,
    vendor: vendorOf(r),
    amount_label: money(r.amount, r.currency),
    age_days: ageDays(r.txn_date),
  }))
}

export function addRequests(txnIds = [], user = null) {
  const ins = db.prepare(`
    INSERT INTO missing_invoice_requests (id, bank_txn_id, in_send, created_by, updated_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(bank_txn_id) DO UPDATE SET in_send = 1, updated_at = excluded.updated_at
  `)
  const run = db.transaction((ids) => {
    for (const id of ids) {
      const t = db.prepare('SELECT id FROM bank_transactions WHERE id=? AND deleted_at IS NULL').get(id)
      if (t) ins.run(newRecordId(), id, user, nowIso())
    }
  })
  run(txnIds.filter(Boolean))
  return listRequests()
}

export function removeRequest(txnId) {
  db.prepare('DELETE FROM missing_invoice_requests WHERE bank_txn_id=?').run(txnId)
  return listRequests()
}

export function setInSend(txnId, on) {
  db.prepare('UPDATE missing_invoice_requests SET in_send=?, updated_at=? WHERE bank_txn_id=?')
    .run(on ? 1 : 0, nowIso(), txnId)
  return listRequests()
}

/**
 * Le message : une phrase, puis une ligne par facture (date · fournisseur ·
 * montant · compte, nommé comme l'onglet du relevé). Slack ne sait pas faire de
 * tableau : les colonnes tiennent dans un bloc à chasse fixe.
 */
export function buildMessage(rows = null) {
  const list = (rows || listRequests()).filter((r) => r.in_send)
  if (!list.length) return null
  const cfg = getMissingInvoiceConfig()
  // Deux devises dans la même demande : on ne les additionne pas, on les
  // montre côte à côte (« 2 422,99 $ US + 49,84 $ »).
  const byCurrency = new Map()
  for (const r of list) {
    byCurrency.set(r.currency, (byCurrency.get(r.currency) || 0) + Math.abs(Number(r.amount) || 0))
  }
  const total = [...byCurrency.entries()].map(([cur, sum]) => money(sum, cur)).join(' + ')
  const intro = cfg.intro
    .replace('{n}', String(list.length))
    .replace('{s}', list.length > 1 ? 's' : '')
    .replace('{total}', total)
  // Colonnes calées sur le contenu réel : un montant en dollars US est plus
  // large qu'un montant canadien, la colonne suit.
  const vendorW = Math.min(30, Math.max(...list.map((r) => String(r.vendor).length)))
  const amountW = Math.max(...list.map((r) => String(r.amount_label).length))
  const lines = list.map((r) =>
    `${String(frDate(r.txn_date)).padEnd(9)} ${String(r.vendor).slice(0, vendorW).padEnd(vendorW)}  ${String(r.amount_label).padStart(amountW)}  ${r.account_name}`)
  return [intro, '```', ...lines, '```', cfg.outro].filter(Boolean).join('\n')
}

/** Envoi manuel — un clic de Charles, jamais un planificateur. */
export async function sendRequests({ user = null } = {}) {
  const started = Date.now()
  if (!isSystemAutomationActive(MISSING_INVOICE_AUTOMATION_ID)) {
    return { sent: false, reason: 'inactive' }
  }
  const rows = listRequests().filter((r) => r.in_send)
  if (!rows.length) return { sent: false, reason: 'vide' }
  const text = buildMessage(rows)
  const cfg = getMissingInvoiceConfig()
  try {
    const res = await sendSlack({
      channel: cfg.slack_channel,
      url: cfg.slack_webhook_url,
      envName: cfg.slack_webhook_env,
      text,
      fallbackNote: "Le canal des factures manquantes n'est pas configuré — le message a été redirigé ici.",
    })
    if (!res.sent) throw new Error('Aucun canal Slack joignable')
    const at = nowIso()
    const mark = db.prepare('UPDATE missing_invoice_requests SET last_sent_at=?, updated_at=? WHERE bank_txn_id=?')
    db.transaction(() => { for (const r of rows) mark.run(at, at, r.bank_txn_id) })()
    logSystemRun(MISSING_INVOICE_AUTOMATION_ID, {
      status: 'success',
      result: { count: rows.length, via: res.via, by: user },
      duration_ms: Date.now() - started,
    })
    return { sent: true, count: rows.length, text, requests: listRequests() }
  } catch (e) {
    logSystemRun(MISSING_INVOICE_AUTOMATION_ID, {
      status: 'error', error: e.message, duration_ms: Date.now() - started,
    })
    throw e
  }
}
