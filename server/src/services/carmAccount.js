// Compte ASFC (CARM) — solde, nature comptable des lignes, alerte de solde bas.
//
// MODÈLE COMPTABLE
// Le compte ASFC EST le solde du fournisseur « ASFC » dans les Comptes
// fournisseurs (21000) : aucun compte de passage à créer, rien dans les frais
// payés d'avance, et la fiche fournisseur de QuickBooks reproduit le relevé du
// portail.
//   • Notre versement (ex. 500 $ par carte) → Dépense sur la carte, imputée à
//     21000 avec ASFC en fournisseur. Aucune taxe : c'est une avance.
//   • Évaluation B3 → facture fournisseur ASFC : droits de douane en coût
//     (duty_acctnum) et TPS à l'importation en CTI 100 % RÉCUPÉRABLE. Passer un
//     B3 en bloc dans une dépense ferait perdre le CTI et gonflerait les charges.
//   • Intérêts (IN) → charge financière, hors champ, aucun CTI.
//   • Corrections (C1) → même ventilation que le B3 corrigé, en sens inverse.
//   • Ligne réglée par un courtier (FedEx, UPS, Axxess paient l'ASFC puis nous
//     refacturent) → RIEN ici : la dépense et la TPS arrivent par sa facture.
//   • Dépôt de garantie (597 $) → caution permanente, déjà comptabilisée, hors
//     solde consommable.
// Le crédit laissé au portail par un versement supérieur aux charges (202,68 $
// le 2026-08-03) apparaît naturellement comme solde débiteur du fournisseur.
// Pas de TVQ à la frontière sur les biens commerciaux d'un inscrit : seule la
// TPS de 5 % sur la valeur en douane est en jeu.
//
// SIGNE : montant positif = dû à l'ASFC (charge), négatif = paiement/crédit.
// Le solde disponible = solde d'ouverture − somme des montants.
import db from '../db/database.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

export const CARM_AUTOMATION_ID = 'sys_carm_balance_alert'

export const CARM_DEFAULT_CONFIG = {
  // Solde du compte au portail à la date d'ouverture — le relevé importé ne
  // contient que l'activité, pas le point de départ. Sans lui, le solde
  // affiché n'est qu'une variation et l'alerte ne veut rien dire.
  opening_balance: '0',
  opening_date: '',
  threshold: '50',               // alerte quand le solde disponible passe sous ce montant
  ap_acctnum: '21000',           // Comptes fournisseurs CAD — le compte ASFC lui-même
  duty_acctnum: '65000',         // droits de douane → Expédition, livraison et poste
  interest_acctnum: '79200',     // intérêts ASFC → Frais d'intérêts
  penalty_acctnum: '70100',      // pénalités → Intérêts et pénalités non déductibles
  card_acctnum: '22000',         // Mastercard BNC — versements « Lot de cartes »
  bank_acctnum: '10000',         // Compte chèques BNC — versements électroniques
  vendor_name: 'ASFC',           // fournisseur QB qui porte le compte
  gst_tax_code_name: 'TPS',      // code de taxe du CTI à l'importation
  notax_tax_code_name: 'Hors champ',
  post_since: '',                // ne rien comptabiliser avant cette date
  max_batch: '50',               // groupes poussés par lot
  delta_tolerance: '0.02',       // écart toléré entre le relevé et l'écriture
  broker_names: 'Federal Express Canada, United Parcells, AXXESS INTERNAtional',
  slack_webhook_env: 'SLACK_WEBHOOK_TREASURY',
}

export function getCarmConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id = ?').get(CARM_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...CARM_DEFAULT_CONFIG }
  for (const k of Object.keys(CARM_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

export function setCarmConfig(patch) {
  const row = db.prepare('SELECT action_config FROM automations WHERE id = ?').get(CARM_AUTOMATION_ID)
  if (!row) throw new Error(`Automation ${CARM_AUTOMATION_ID} introuvable`)
  let cfg = {}
  try { cfg = JSON.parse(row.action_config || '{}') } catch {}
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in CARM_DEFAULT_CONFIG)) continue
    cfg[k] = v == null ? '' : String(v).trim()
  }
  db.prepare(`UPDATE automations SET action_config = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(JSON.stringify(cfg), CARM_AUTOMATION_ID)
  return getCarmConfig()
}

// ── Nature comptable ─────────────────────────────────────────────────────────
// Codes du relevé CARM. B3 = déclaration en détail (formulaire B3-3), C1 =
// correction / relevé de rajustement, IN = intérêts, LP = lot de paiements,
// LD = lot de cartes (paiement par carte), K23 = pénalité.
const TYPE_CATEGORY = {
  b3: 'evaluation', b2: 'correction', c1: 'correction', das: 'correction',
  in: 'interet', k23: 'penalite', pen: 'penalite',
  lp: 'paiement', ld: 'paiement', pmt: 'paiement', pay: 'paiement', rc: 'paiement',
}

export const CARM_CATEGORIES = ['evaluation', 'correction', 'interet', 'penalite', 'paiement', 'autre']

export const CATEGORY_LABELS = {
  evaluation: 'Évaluation (B3)',
  correction: 'Correction',
  interet: 'Intérêts',
  penalite: 'Pénalité',
  paiement: 'Paiement',
  autre: 'Autre',
}

// Nature déduite du code, avec repli sur le libellé puis sur le signe.
export function carmCategory({ transaction_type, description, amount }) {
  const code = String(transaction_type || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  if (TYPE_CATEGORY[code]) return TYPE_CATEGORY[code]
  const text = `${transaction_type || ''} ${description || ''}`.toLowerCase()
  if (/int[ée]r[êe]t|interest/.test(text)) return 'interet'
  if (/p[ée]nalit|penalty|amende/.test(text)) return 'penalite'
  if (/paiement|payment|versement|carte|card/.test(text)) return 'paiement'
  if (/correction|rajust|adjust/.test(text)) return 'correction'
  if (/[ée]valuation|d[ée]claration|assessment|b3/.test(text)) return 'evaluation'
  return Number(amount) < 0 ? 'paiement' : 'autre'
}

// Classe les lignes qui n'ont pas encore de nature (import antérieur au champ,
// ou nature effacée). Idempotent : ne touche jamais une nature déjà posée.
export function backfillCarmCategories() {
  const rows = db.prepare(`
    SELECT id, transaction_type, description, amount FROM carm_transactions
    WHERE deleted_at IS NULL AND (category IS NULL OR category = '')
  `).all()
  if (!rows.length) return 0
  const upd = db.prepare('UPDATE carm_transactions SET category = ? WHERE id = ?')
  const tx = db.transaction(() => { for (const r of rows) upd.run(carmCategory(r), r.id) })
  tx()
  return rows.length
}

// ── Solde et état du compte ──────────────────────────────────────────────────

const round2 = n => Math.round((Number(n) || 0) * 100) / 100

// État complet du compte : solde disponible, consommation récente, autonomie
// estimée, TPS à l'importation récupérable, lignes à ventiler.
export function carmAccountState() {
  const cfg = getCarmConfig()
  const opening = Number(cfg.opening_balance) || 0
  const threshold = Number(cfg.threshold) || 0
  const all = db.prepare(`
    SELECT id, transaction_date, amount, category, kind, payer, duty_amount, gst_amount,
           posting_state, skip_reason
    FROM carm_transactions WHERE deleted_at IS NULL
      ${cfg.opening_date ? 'AND transaction_date >= ?' : ''}
    ORDER BY transaction_date
  `).all(...(cfg.opening_date ? [cfg.opening_date] : []))
  // Le dépôt de garantie (caution permanente MAP) ne finance aucune importation :
  // il sort du solde consommable et de la consommation mensuelle.
  const rows = all.filter(r => r.kind !== 'garantie')
  const guarantee = round2(all.filter(r => r.kind === 'garantie' && Number(r.amount) > 0)
    .reduce((s, r) => s + Number(r.amount), 0))

  let charges = 0, payments = 0
  const chargesByMonth = new Map()
  for (const r of rows) {
    const a = Number(r.amount) || 0
    if (a >= 0) {
      charges += a
      const m = String(r.transaction_date).slice(0, 7)
      chargesByMonth.set(m, (chargesByMonth.get(m) || 0) + a)
    } else payments += -a
  }
  const balance = round2(opening + payments - charges)

  // Consommation mensuelle moyenne sur les 3 derniers mois ayant de l'activité
  // — sert à estimer l'autonomie et à contextualiser l'alerte.
  const months = [...chargesByMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-3)
  const monthlyBurn = months.length ? round2(months.reduce((s, [, v]) => s + v, 0) / months.length) : 0
  const daysLeft = monthlyBurn > 0 && balance > 0 ? Math.floor((balance / monthlyBurn) * 30) : null

  const gstClaimable = round2(rows.reduce((s, r) => s + (Number(r.gst_amount) || 0), 0))
  const toSplit = rows.filter(r =>
    (r.category === 'evaluation' || r.category === 'correction') &&
    r.duty_amount == null && r.gst_amount == null).length

  const last = db.prepare(`
    SELECT MAX(transaction_date) AS d FROM carm_transactions WHERE deleted_at IS NULL
  `).get()

  // Ce qui reste dû / disponible d'après le lettrage FIFO (carmPosting.js).
  const alloc = db.prepare(`
    SELECT charge_txn_id, payment_txn_id, SUM(amount) AS amt FROM carm_allocations
    WHERE deleted_at IS NULL GROUP BY charge_txn_id, payment_txn_id
  `).all()
  const settledByCharge = new Map(), usedByPayment = new Map()
  for (const a of alloc) {
    settledByCharge.set(a.charge_txn_id, round2((settledByCharge.get(a.charge_txn_id) || 0) + a.amt))
    usedByPayment.set(a.payment_txn_id, round2((usedByPayment.get(a.payment_txn_id) || 0) + a.amt))
  }
  const ours = rows.filter(r => !String(r.skip_reason || '').startsWith('via_courtier') && r.payer !== 'courtier')
  const creditAvailable = round2(ours.filter(r => Number(r.amount) < 0)
    .reduce((s, r) => s + (-r.amount - (usedByPayment.get(r.id) || 0)), 0))
  const unpaid = round2(ours.filter(r => Number(r.amount) > 0)
    .reduce((s, r) => s + (r.amount - (settledByCharge.get(r.id) || 0)), 0))
  const countBy = st => rows.filter(r => r.posting_state === st).length

  return {
    balance,
    guarantee_balance: guarantee,
    credit_available: creditAvailable,
    unpaid,
    to_post: countBy('a_comptabiliser'),
    posted: countBy('comptabilise'),
    awaiting: countBy('attente_imputation'),
    via_broker: rows.filter(r => String(r.skip_reason || '').startsWith('via_courtier')).length,
    to_verify: countBy('a_verifier') + countBy('erreur'),
    opening_balance: opening,
    opening_date: cfg.opening_date || null,
    threshold,
    low: balance < threshold,
    negative: balance < 0,
    charges: round2(charges),
    payments: round2(payments),
    monthly_burn: monthlyBurn,
    days_left: daysLeft,
    gst_claimable: gstClaimable,
    lines_to_split: toSplit,
    last_activity: last?.d || null,
    count: rows.length,
  }
}

// ── Alerte de solde bas ──────────────────────────────────────────────────────

async function sendSlackWebhook(envName, text) {
  const url = process.env[envName]
  if (!url) throw new Error(`Variable d'environnement manquante : ${envName}`)
  const resp = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!resp.ok) throw new Error(`Slack HTTP ${resp.status}`)
}

const fmtCad = n => new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(Number(n) || 0)

export function carmAlertText(state) {
  const bits = [
    state.negative
      ? `:rotating_light: *Douanes ASFC* — le compte CARM est à découvert : ${fmtCad(state.balance)}. L'ASFC facture des intérêts tant que le solde est négatif.`
      : `:warning: *Douanes ASFC* — solde du compte CARM : ${fmtCad(state.balance)} (seuil ${fmtCad(state.threshold)}).`,
  ]
  if (state.monthly_burn > 0) {
    bits.push(`Consommation récente : ${fmtCad(state.monthly_burn)}/mois` +
      (state.days_left != null ? ` — environ ${state.days_left} jour(s) d'autonomie.` : '.'))
  }
  bits.push('Recharger le compte dans le portail CARM, puis importer le relevé mis à jour dans l\'ERP.')
  return bits.join('\n')
}

// Vérifie le solde et alerte s'il passe sous le seuil. Anti-spam : au plus une
// alerte par 20 h (comme la trésorerie) ; `force` court-circuite.
export async function checkCarmBalanceAlert({ force = false, trigger = 'schedule' } = {}) {
  const t0 = Date.now()
  try {
    if (!force && !isSystemAutomationActive(CARM_AUTOMATION_ID)) return { skipped: 'inactive' }
    backfillCarmCategories()
    const cfg = getCarmConfig()
    const state = carmAccountState()
    if (!state.low) {
      logSystemRun(CARM_AUTOMATION_ID, {
        status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger },
        result: `OK — solde ${fmtCad(state.balance)} (seuil ${fmtCad(state.threshold)})`,
      })
      return { ok: true, alerted: false, state }
    }
    const recent = force ? null : db.prepare(`
      SELECT 1 FROM automation_logs
      WHERE automation_id = ? AND status = 'success' AND result LIKE 'ALERTE%'
        AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 hours')
      LIMIT 1
    `).get(CARM_AUTOMATION_ID)
    if (recent) {
      logSystemRun(CARM_AUTOMATION_ID, {
        status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger },
        result: `SOUS LE SEUIL — solde ${fmtCad(state.balance)} · alerte déjà envoyée dans les 20 dernières heures`,
      })
      return { ok: true, alerted: false, throttled: true, state }
    }
    const text = carmAlertText(state)
    let sent = 'aucun canal configuré'
    if (cfg.slack_webhook_env) {
      await sendSlackWebhook(cfg.slack_webhook_env, text)
      sent = `Slack (${cfg.slack_webhook_env})`
    }
    logSystemRun(CARM_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger },
      result: `ALERTE — solde ${fmtCad(state.balance)} sous le seuil ${fmtCad(state.threshold)} · envoyé : ${sent}`,
    })
    return { ok: true, alerted: true, state, text }
  } catch (e) {
    logSystemRun(CARM_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e.message,
    })
    console.error('carmAccount.checkCarmBalanceAlert:', e.message)
    return { error: e.message }
  }
}
