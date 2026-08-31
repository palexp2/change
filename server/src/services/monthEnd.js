// Écritures de fin de mois — provisions mensuelles.
//
// Remplace les fichiers Drive « 26-27_Provisions_mensuelles_CTB » (onglets
// RSDE et Salaires LB) et « 26-27_R&D_Suivi_Feuilles de temps », ainsi que les
// deux procédures Google Docs qui décrivaient les recopies manuelles.
//
// Deux provisions :
//   • rd_credit    — crédit d'impôt R&D (RS&DE). Heures R&D du mois (hors
//                    sous-traitants) × taux horaire × majoration vacances,
//                    moins le PARI du mois, projeté sur 12 mois, × le taux de
//                    réclamation, ramené sur 1 mois, arrondi.
//                    JE : Dr 15000 Provisions de crédits d'impôt / Cr 72000.
//   • wage_subsidy — subvention salariale (Biotalent, Louis-Bernard). Salaire
//                    brut du mois (paie_items, hors remboursements de dépenses)
//                    × 60 %, plafonné à la contribution maximale et borné à la
//                    fenêtre d'admissibilité — deux garde-fous que le fichier
//                    Excel n'avait pas. JE : Dr 12400 / Cr 49000.
//
// Convention identique aux FPA (services/prepaid.js) : l'ERP calcule et prépare
// la JE, la publication dans QuickBooks se fait après approbation explicite.
// Les mois publiés sont matérialisés avec pushed_at + qb_je_id ; les mois
// historiques importés des fichiers portent pushed_at sans qb_je_id (déjà
// comptabilisés à la main dans QB avant la reprise par l'ERP).
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { qbGet, qbPost, qbEntityUrl } from '../connectors/quickbooks.js'
import { resolveAccountByAcctNum } from './quickbooks.js'
import { logSync } from './syncLog.js'
import { round2Safe as round2 } from '../utils/money.js'

const daysInMonth = (y, m1) => new Date(Date.UTC(y, m1, 0)).getUTCDate()
const isMonth = v => /^\d{4}-\d{2}$/.test(String(v || ''))

export function lastDayOfMonth(month) {
  const y = Number(month.slice(0, 4)); const m = Number(month.slice(5, 7))
  return `${month}-${String(daysInMonth(y, m)).padStart(2, '0')}`
}

// Mois précédent au format YYYY-MM.
function prevMonth(month) {
  let y = Number(month.slice(0, 4)); let m = Number(month.slice(5, 7)) - 1
  if (m === 0) { m = 12; y -= 1 }
  return `${y}-${String(m).padStart(2, '0')}`
}

// Suite de mois inclusive de `from` à `to`.
function monthRange(from, to) {
  const out = []
  let cur = from
  while (cur <= to && out.length < 240) { out.push(cur); cur = nextMonth(cur) }
  return out
}

function nextMonth(month) {
  let y = Number(month.slice(0, 4)); let m = Number(month.slice(5, 7)) + 1
  if (m === 13) { m = 1; y += 1 }
  return `${y}-${String(m).padStart(2, '0')}`
}

const parseJson = (s, fallback = {}) => { try { return JSON.parse(s) || fallback } catch { return fallback } }

// ── Définitions ─────────────────────────────────────────────────────────────

export function listProvisions({ includeInactive = false } = {}) {
  const rows = db.prepare(`
    SELECT * FROM month_end_provisions WHERE deleted_at IS NULL
    ${includeInactive ? '' : 'AND active = 1'}
    ORDER BY sort_order, label
  `).all()
  return rows.map(r => ({ ...r, config: parseJson(r.config) }))
}

export function getProvision(id) {
  const r = db.prepare('SELECT * FROM month_end_provisions WHERE id = ? AND deleted_at IS NULL').get(id)
  return r ? { ...r, config: parseJson(r.config) } : null
}

function materializedMonth(provisionId, month) {
  return db.prepare(`
    SELECT * FROM month_end_provision_months
    WHERE provision_id = ? AND month = ? AND deleted_at IS NULL
  `).get(provisionId, month) || null
}

// ── Heures R&D ──────────────────────────────────────────────────────────────

export function rdHours(month) {
  const rows = db.prepare(`
    SELECT * FROM rd_month_hours WHERE month = ? AND deleted_at IS NULL
    ORDER BY contractor, employee_name
  `).all(month)
  const employee = rows.filter(r => !r.contractor)
  const contractor = rows.filter(r => r.contractor)
  return {
    rows,
    employee_hours: round2(employee.reduce((s, r) => s + (Number(r.hours) || 0), 0)),
    contractor_hours: round2(contractor.reduce((s, r) => s + (Number(r.hours) || 0), 0)),
    employee_count: employee.length,
  }
}

// ── Plausibilité des heures ─────────────────────────────────────────────────

const normName = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()

// Seuil au-delà duquel l'écart d'heures d'un mois à l'autre mérite un regard :
// un onglet oublié dans la feuille de temps ou une formule cassée se voit ici,
// pas dans le montant final (qui reste plausible en apparence).
const HOURS_DEVIATION_THRESHOLD = 0.4

// Compare les heures du mois à celles du mois précédent. Pur (pas d'accès DB)
// pour être testable : `current` et `previous` sont deux résultats de rdHours().
// Retourne des avertissements, jamais des blocages — c'est le comptable qui
// tranche, l'ERP se contente de pointer ce qui détonne.
export function hoursPlausibilityFromSeries(current, previous, { prevLabel = 'le mois précédent' } = {}) {
  const warnings = []
  if (!previous?.rows?.length || !current?.rows?.length) return warnings

  const curNames = new Set(current.rows.map(r => normName(r.employee_name)))
  const missing = previous.rows.filter(r => (Number(r.hours) || 0) > 0 && !curNames.has(normName(r.employee_name)))
  if (missing.length) {
    warnings.push(
      `${missing.map(r => r.employee_name).join(', ')} : des heures ${prevLabel} mais aucune ligne ce mois-ci — onglet manquant dans la feuille de temps ?`,
    )
  }

  if (previous.employee_hours > 0 && current.employee_hours > 0) {
    const delta = (current.employee_hours - previous.employee_hours) / previous.employee_hours
    if (Math.abs(delta) > HOURS_DEVIATION_THRESHOLD) {
      const sens = delta > 0 ? 'de plus' : 'de moins'
      warnings.push(
        `${Math.round(Math.abs(delta) * 100)} % d'heures employés ${sens} que ${prevLabel} `
        + `(${current.employee_hours} h vs ${previous.employee_hours} h) — vérifier la feuille de temps avant de comptabiliser.`,
      )
    }
  }
  return warnings
}

// Deux écarts à rendre visibles sur la carte des heures :
//   • la ligne « total » de l'onglet ne couvre pas toutes ses lignes (formule
//     SUM incomplète) — l'ERP retient son propre total, mais la feuille de
//     temps reste à corriger à la source ;
//   • la valeur retenue en base ne correspond plus à l'addition des lignes du
//     dernier import (mois importé avant un changement de règle) — un
//     réimport la remet d'aplomb.
// Les lignes corrigées à la main (source='manuel') sont laissées tranquilles :
// l'écart y est voulu.
export function hoursFileDivergence(rows = []) {
  const fmt = n => `${new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 2 }).format(n)} h`
  const gap = (a, b) => fmt(Math.round(Math.abs(a - b) * 100) / 100)
  const out = []
  for (const r of rows) {
    if (r.source === 'manuel' || r.day_hours == null) continue
    if (Math.abs(r.day_hours - r.hours) > 0.005) {
      out.push(
        `${r.employee_name} : l'ERP additionne ${fmt(r.day_hours)} sur la feuille de temps, mais ${fmt(r.hours)} sont retenues `
        + `(écart de ${gap(r.day_hours, r.hours)}) — réimporter la feuille de temps pour appliquer le total recalculé.`,
      )
    } else if (r.file_total_hours != null && Math.abs(r.file_total_hours - r.day_hours) > 0.005) {
      out.push(
        `${r.employee_name} : la ligne « total » de la feuille de temps affiche ${fmt(r.file_total_hours)} alors que ses lignes `
        + `en totalisent ${fmt(r.day_hours)} (écart de ${gap(r.file_total_hours, r.day_hours)}) — c'est le total recalculé qui est `
        + `retenu ; la formule du fichier est à corriger dans le Drive.`,
      )
    }
  }
  return out
}

export function hoursPlausibility(month) {
  const prev = prevMonth(month)
  const current = rdHours(month)
  return [
    ...hoursFileDivergence(current.rows),
    ...hoursPlausibilityFromSeries(current, rdHours(prev), { prevLabel: `en ${prev}` }),
  ]
}

// ── Calculs ─────────────────────────────────────────────────────────────────

const RD_DEFAULTS = { hourly_rate: 40, uplift_pct: 33, claim_pct: 60, round_to: 100 }

// Grille RSDE, reproduite pas à pas pour rester lisible à côté du fichier Excel
// d'origine (la projection ×12 puis ÷12 s'annule mathématiquement, mais chaque
// palier est affiché tel quel dans l'interface pour que la comparaison avec la
// grille historique reste possible).
// Cœur du calcul, sans accès à la base — testable directement contre les
// colonnes du fichier RSDE.
export function rdCreditFromHours(config, employeeHours, pari = 0) {
  const cfg = { ...RD_DEFAULTS, ...(config || {}) }
  const gross = round2(employeeHours * cfg.hourly_rate * (1 + cfg.uplift_pct / 100))
  const rsdeMonth = round2(Math.max(0, gross - Math.max(0, Number(pari) || 0)))
  const projected12 = round2(rsdeMonth * 12)
  const claimable = round2(projected12 * cfg.claim_pct / 100)
  const raw = claimable / 12
  const roundTo = Number(cfg.round_to) || 1
  return {
    amount: round2(Math.round(raw / roundTo) * roundTo),
    gross, rsde_month: rsdeMonth, projected_12m: projected12, claimable,
    before_rounding: round2(raw), round_to: roundTo,
    hourly_rate: cfg.hourly_rate, uplift_pct: cfg.uplift_pct, claim_pct: cfg.claim_pct,
  }
}

export function computeRdCredit(provision, month, inputs = {}) {
  const hours = rdHours(month)
  const pari = Math.max(0, Number(inputs.pari) || 0)
  const calc = rdCreditFromHours(provision.config, hours.employee_hours, pari)
  return {
    amount: calc.amount,
    detail: {
      ...calc,
      hours: hours.employee_hours,
      contractor_hours: hours.contractor_hours,
      pari,
      by_employee: hours.rows.map(r => ({
        name: r.employee_name, hours: r.hours, contractor: !!r.contractor, source: r.source,
      })),
    },
    warnings: hours.employee_count
      ? []
      : [`Aucune heure R&D saisie pour ${month} — importer la feuille de temps du mois.`],
  }
}

const SUBSIDY_DEFAULTS = { pct: 60, cap_total: null, eligible_from: null, eligible_to: null, employee_id: null }

// Salaire brut du mois : somme des paies débitées dans le mois, remboursements
// de dépenses exclus (colonne « Paie sans remb. dépenses » de la procédure).
export function grossSalaryForMonth(employeeId, month) {
  const row = db.prepare(`
    SELECT ROUND(SUM(COALESCE(total_pay, 0) - COALESCE(expense_reimb, 0)), 2) AS gross,
           COUNT(*) AS n
    FROM paie_items
    WHERE employee_id = ? AND substr(debited_date, 1, 7) = ?
  `).get(employeeId, month)
  return { gross: round2(row?.gross || 0), pay_count: row?.n || 0 }
}

// `cumulativeBefore` est fourni par l'appelant (il connaît la série complète) —
// le plafond de contribution s'applique au cumul, pas au mois isolé.
// Cœur du calcul, sans accès à la base. Le plafond et la fenêtre
// d'admissibilité sont les deux garde-fous absents du fichier Excel : sans eux,
// la provision continue de courir après l'épuisement de la contribution.
export function wageSubsidyFromSalary(config, gross, month, cumulativeBefore = 0) {
  const cfg = { ...SUBSIDY_DEFAULTS, ...(config || {}) }
  const warnings = []
  const raw = round2(gross * cfg.pct / 100)

  let eligible = true
  if (cfg.eligible_from && month < String(cfg.eligible_from).slice(0, 7)) eligible = false
  if (cfg.eligible_to && month > String(cfg.eligible_to).slice(0, 7)) eligible = false
  if (!eligible) warnings.push(`${month} est hors de la fenêtre d'admissibilité (${cfg.eligible_from || '—'} → ${cfg.eligible_to || '—'}).`)

  let amount = eligible ? raw : 0
  let capped = false
  let remaining = null
  if (cfg.cap_total != null) {
    remaining = round2(Math.max(0, Number(cfg.cap_total) - cumulativeBefore))
    if (amount > remaining) {
      amount = remaining
      capped = true
      warnings.push(`Plafonné : la contribution maximale de ${Number(cfg.cap_total).toLocaleString('fr-CA')} $ ne laisse que ${remaining.toLocaleString('fr-CA')} $ pour ce mois (provision calculée : ${raw.toLocaleString('fr-CA')} $).`)
    }
  }

  return {
    amount: round2(amount),
    detail: {
      gross: round2(gross), pct: cfg.pct, raw,
      cap_total: cfg.cap_total, cumulative_before: round2(cumulativeBefore),
      cap_remaining: remaining, capped, eligible,
      eligible_from: cfg.eligible_from, eligible_to: cfg.eligible_to,
    },
    warnings,
  }
}

export function computeWageSubsidy(provision, month, _inputs = {}, cumulativeBefore = 0) {
  const cfg = { ...SUBSIDY_DEFAULTS, ...(provision.config || {}) }
  if (!cfg.employee_id) {
    return { amount: 0, detail: { gross: 0, pct: cfg.pct }, warnings: ['Aucun employé configuré sur cette provision.'] }
  }
  const { gross, pay_count } = grossSalaryForMonth(cfg.employee_id, month)
  const out = wageSubsidyFromSalary(cfg, gross, month, cumulativeBefore)
  if (out.detail.eligible && !pay_count) out.warnings.push(`Aucune paie débitée en ${month} pour cet employé.`)
  return { ...out, detail: { ...out.detail, pay_count } }
}

// Montant effectif d'un mois : override manuel > montant matérialisé > calcul.
// `cumulativeBefore` n'est utilisé que par les provisions plafonnées.
function evaluateMonth(provision, month, cumulativeBefore = 0) {
  const mat = materializedMonth(provision.id, month)
  const inputs = parseJson(mat?.inputs, {})
  const computed = provision.kind === 'rd_credit'
    ? computeRdCredit(provision, month, inputs)
    : computeWageSubsidy(provision, month, inputs, cumulativeBefore)

  let amount = computed.amount
  let source = 'auto'
  if (mat?.override_amount != null) { amount = round2(mat.override_amount); source = 'manuel' }
  else if (mat && mat.source === 'import') { amount = round2(mat.amount); source = 'import' }
  else if (mat?.pushed_at != null && mat.amount != null) { amount = round2(mat.amount); source = mat.source }

  return {
    month,
    amount,
    computed_amount: computed.amount,
    source,
    inputs,
    detail: computed.detail,
    warnings: computed.warnings,
    qb_je_id: mat?.qb_je_id || null,
    pushed_at: mat?.pushed_at || null,
    row_id: mat?.id || null,
  }
}

// Série complète depuis le premier mois de la provision jusqu'à `month`, avec
// cumul courant. Les provisions plafonnées ont besoin de la série pour évaluer
// un mois donné — d'où l'évaluation en avant plutôt que ponctuelle.
export function provisionSeries(provision, throughMonth) {
  const cfg = provision.config || {}
  const first = db.prepare(`
    SELECT MIN(month) AS m FROM month_end_provision_months
    WHERE provision_id = ? AND deleted_at IS NULL
  `).get(provision.id)?.m
  const startCandidates = [
    cfg.start_month,
    cfg.eligible_from ? String(cfg.eligible_from).slice(0, 7) : null,
    first,
    throughMonth,
  ].filter(Boolean)
  const start = startCandidates.sort()[0]
  const out = []
  let cumulative = 0
  for (const m of monthRange(start, throughMonth)) {
    const ev = evaluateMonth(provision, m, cumulative)
    cumulative = round2(cumulative + ev.amount)
    out.push({ ...ev, cumulative })
  }
  return out
}

export function evaluateProvisionMonth(provision, month) {
  const series = provisionSeries(provision, month)
  return series[series.length - 1]
}

// ── État d'un mois ──────────────────────────────────────────────────────────

// Vue complète de la clôture d'un mois : une entrée par provision, plus
// l'écriture FPA préparée par le module des comptes prépayés (même mois, même
// bouton de publication — le hub de fin de mois les présente ensemble).
const fmtMoney = n => `${new Intl.NumberFormat('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0)} $`

// Une écriture publiée est figée : si les intrants changent après coup (heures
// réimportées, paie corrigée), le montant dans QuickBooks ne bouge plus. Le
// signaler plutôt que de laisser croire que la carte reflète ce qui est
// comptabilisé. Réservé aux écritures réellement publiées par l'ERP (qb_je_id) —
// les mois repris de l'historique n'ont pas d'intrants comparables.
function publishedDriftWarnings(ev) {
  if (!hasDrift(ev)) return []
  return [
    `Le calcul actuel donne ${fmtMoney(ev.computed_amount)}, alors que ${fmtMoney(ev.amount)} a été comptabilisé `
    + `(JE #${ev.qb_je_id}) — corriger l'écriture ci-dessous, ou la laisser telle quelle si l'écart n'a pas à être rattrapé.`,
  ]
}

function hasDrift(ev) {
  return !!ev.qb_je_id && ev.computed_amount != null && Math.abs(ev.computed_amount - ev.amount) > 0.005
}

export function monthEndState(month) {
  if (!isMonth(month)) throw new Error('Mois invalide (YYYY-MM attendu)')
  const provisions = listProvisions({ includeInactive: true }).map(p => {
    const ev = evaluateProvisionMonth(p, month)
    return {
      id: p.id, label: p.label, kind: p.kind, description: p.description,
      active: p.active, config: p.config,
      debit_acctnum: p.debit_acctnum, credit_acctnum: p.credit_acctnum, memo: p.memo,
      ...ev,
      qb_je_url: ev.qb_je_id ? qbEntityUrl('journal', ev.qb_je_id) : null,
      warnings: [...ev.warnings, ...publishedDriftWarnings(ev)],
      ready: p.active && !ev.pushed_at && ev.amount > 0 && !!p.debit_acctnum && !!p.credit_acctnum,
      correctable: p.active && hasDrift(ev),
      missing_accounts: [
        !p.debit_acctnum ? 'compte au débit' : null,
        !p.credit_acctnum ? 'compte au crédit' : null,
      ].filter(Boolean),
    }
  })
  return { month, provisions, hours: { ...rdHours(month), warnings: hoursPlausibility(month) } }
}

// ── Publication dans QuickBooks ─────────────────────────────────────────────

// Numéro d'écriture déterministe (provision + mois) : si le POST réussit dans
// QB mais que la réponse se perd (timeout, redémarrage), le rollback libère le
// mois côté ERP alors que la JE existe. Au push suivant, on retrouve la JE par
// son DocNumber au lieu d'en créer une deuxième. Limite QB : 21 caractères.
export function provisionDocNumber(provisionId, month) {
  const slug = String(provisionId).replace(/^prov_/, '').replace(/[^a-z0-9]/gi, '').slice(0, 8)
  return `FDM-${month}-${slug}`.slice(0, 21)
}

// Cherche une JE déjà créée dans QB pour ce DocNumber. Meilleur effort : une
// erreur de la requête ne bloque pas la publication (le POST échouera de toute
// façon si QB est réellement injoignable).
async function findExistingJeByDocNumber(docNumber) {
  try {
    const q = new URLSearchParams({ query: `SELECT Id FROM JournalEntry WHERE DocNumber = '${docNumber.replace(/'/g, "\\'")}'` })
    const res = await qbGet(`/query?${q}`)
    return res.QueryResponse?.JournalEntry?.[0]?.Id || null
  } catch {
    return null
  }
}

// Claim AVANT le POST puis rollback si le POST échoue — même pattern que
// publishFpaMonth : une JE ne doit jamais exister dans QB sans trace dans
// l'ERP, ni l'inverse.
export async function publishProvisionMonth(provisionId, month, { userId = null } = {}) {
  if (!isMonth(month)) throw new Error('Mois invalide (YYYY-MM attendu)')
  const provision = getProvision(provisionId)
  if (!provision) throw new Error('Provision introuvable')
  if (!provision.active) throw new Error('Provision inactive')

  const ev = evaluateProvisionMonth(provision, month)
  if (ev.pushed_at) throw new Error('Ce mois est déjà comptabilisé')
  if (!(ev.amount > 0)) throw new Error('Montant nul — rien à comptabiliser')
  if (!provision.debit_acctnum || !provision.credit_acctnum) {
    throw new Error('Comptes QuickBooks manquants sur la provision')
  }

  const now = new Date().toISOString()
  const existing = materializedMonth(provisionId, month)
  let rowId = existing?.id || null
  const claim = db.transaction(() => {
    if (existing) {
      // Garde `pushed_at IS NULL` dans le WHERE : deux publications lancées en
      // même temps (double-clic, relance réseau) ne doivent produire qu'une JE
      // — la seconde échoue ici au lieu de repartir vers QuickBooks.
      const r = db.prepare(`
        UPDATE month_end_provision_months
        SET amount = ?, computed = ?, pushed_at = ?, updated_at = ?
        WHERE id = ? AND pushed_at IS NULL
      `).run(ev.amount, JSON.stringify(ev.detail), now, now, existing.id)
      if (r.changes !== 1) throw new Error('Ce mois est déjà comptabilisé')
    } else {
      rowId = randomUUID()
      try {
        db.prepare(`
          INSERT INTO month_end_provision_months (id, provision_id, month, amount, inputs, computed, source, pushed_at)
          VALUES (?,?,?,?,?,?,'auto',?)
        `).run(rowId, provisionId, month, ev.amount, JSON.stringify(ev.inputs || {}), JSON.stringify(ev.detail), now)
      } catch (e) {
        // Course entre deux publications simultanées : l'index unique
        // (provision_id, month) fait foi, on traduit en message lisible.
        if (String(e.message).includes('UNIQUE')) throw new Error('Ce mois est déjà comptabilisé')
        throw e
      }
    }
  })
  claim()

  try {
    // Une JE portant déjà ce DocNumber = un push précédent a abouti dans QB
    // mais sa réponse s'est perdue avant d'être enregistrée côté ERP. On
    // raccroche l'écriture existante au lieu d'en créer une deuxième.
    const docNumber = provisionDocNumber(provisionId, month)
    const recoveredJeId = await findExistingJeByDocNumber(docNumber)
    if (recoveredJeId) {
      db.prepare(`UPDATE month_end_provision_months SET qb_je_id = ?, updated_at = ? WHERE id = ?`)
        .run(String(recoveredJeId), new Date().toISOString(), rowId)
      logSync('month_end', 'manual', { status: 'success', modified: 1 })
      return { qb_je_id: String(recoveredJeId), month, provision_id: provisionId, amount: ev.amount, published_by: userId, recovered: true }
    }

    const debitId = await resolveAccountByAcctNum(provision.debit_acctnum)
    if (!debitId) throw new Error(`Compte QB #${provision.debit_acctnum} introuvable`)
    const creditId = await resolveAccountByAcctNum(provision.credit_acctnum)
    if (!creditId) throw new Error(`Compte QB #${provision.credit_acctnum} introuvable`)

    const description = `${provision.memo || provision.label} — ${month}`
    const je = {
      TxnDate: lastDayOfMonth(month),
      DocNumber: docNumber,
      PrivateNote: `${description} (ERP, écritures de fin de mois)`,
      Line: [
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: ev.amount,
          Description: description,
          JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: debitId } },
        },
        {
          DetailType: 'JournalEntryLineDetail',
          Amount: ev.amount,
          Description: description,
          JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: creditId } },
        },
      ],
    }
    const result = await qbPost('/journalentry', je)
    const jeId = result.JournalEntry?.Id
    if (!jeId) throw new Error("QB n'a pas retourné d'Id pour le JournalEntry")
    db.prepare(`UPDATE month_end_provision_months SET qb_je_id = ?, updated_at = ? WHERE id = ?`)
      .run(String(jeId), new Date().toISOString(), rowId)
    logSync('month_end', 'manual', { status: 'success', modified: 1 })
    return { qb_je_id: String(jeId), month, provision_id: provisionId, amount: ev.amount, published_by: userId }
  } catch (e) {
    const rollback = db.transaction(() => {
      const row = db.prepare('SELECT source, override_amount, inputs FROM month_end_provision_months WHERE id = ?').get(rowId)
      // Ligne créée uniquement pour le claim et sans contenu propre → on la
      // retire ; sinon on se contente de libérer pushed_at.
      const hasOwnContent = row && (row.override_amount != null || (row.inputs && row.inputs !== '{}') || row.source !== 'auto')
      if (row && !hasOwnContent) {
        db.prepare('DELETE FROM month_end_provision_months WHERE id = ? AND qb_je_id IS NULL').run(rowId)
      } else {
        db.prepare('UPDATE month_end_provision_months SET pushed_at = NULL WHERE id = ? AND qb_je_id IS NULL').run(rowId)
      }
    })
    rollback()
    logSync('month_end', 'manual', { status: 'error', error: e.message })
    throw e
  }
}

// Corrige une écriture DÉJÀ comptabilisée pour suivre le calcul actuel — le cas
// que publishedDriftWarnings() signale (heures corrigées après coup, etc.).
// Sparse update dans QB (Id + SyncToken, Line réécrite avec le nouveau montant
// sur les deux mêmes comptes) puis alignement de la ligne matérialisée.
export async function correctProvisionMonth(provisionId, month, { userId = null } = {}) {
  if (!isMonth(month)) throw new Error('Mois invalide (YYYY-MM attendu)')
  const provision = getProvision(provisionId)
  if (!provision) throw new Error('Provision introuvable')
  const existing = materializedMonth(provisionId, month)
  if (!existing?.pushed_at) throw new Error('Ce mois n\'est pas encore comptabilisé — rien à corriger')
  if (!existing.qb_je_id) throw new Error('Mois repris de l\'historique, sans écriture ERP dans QuickBooks — correction manuelle requise')

  const ev = evaluateProvisionMonth(provision, month)
  const newAmount = ev.computed_amount
  if (!(newAmount > 0)) throw new Error('Montant calculé nul — rien à comptabiliser')
  if (Math.abs(newAmount - existing.amount) <= 0.005) throw new Error('Le calcul actuel correspond déjà au montant comptabilisé')

  const je = await qbGet(`/journalentry/${existing.qb_je_id}`)
  const current = je.JournalEntry
  if (!current) throw new Error(`JournalEntry #${existing.qb_je_id} introuvable dans QuickBooks`)
  const description = `${provision.memo || provision.label} — ${month}`
  const update = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    sparse: true,
    TxnDate: current.TxnDate,
    DocNumber: current.DocNumber,
    PrivateNote: `${description} (ERP, corrigé le ${new Date().toISOString().slice(0, 10)} — était ${existing.amount.toFixed(2)} $)`,
    Line: current.Line.map(l => ({ ...l, Amount: newAmount })),
  }
  const result = await qbPost('/journalentry', update)
  const jeId = result.JournalEntry?.Id
  if (!jeId) throw new Error("QB n'a pas retourné d'Id pour le JournalEntry corrigé")

  const now = new Date().toISOString()
  db.prepare(`
    UPDATE month_end_provision_months SET amount = ?, computed = ?, updated_at = ? WHERE id = ?
  `).run(newAmount, JSON.stringify(ev.detail), now, existing.id)
  logSync('month_end', 'manual', { status: 'success', modified: 1 })
  return { qb_je_id: String(jeId), month, provision_id: provisionId, amount: newAmount, previous_amount: existing.amount, corrected_by: userId }
}

// ── Intrants et overrides ───────────────────────────────────────────────────

// Upsert de la ligne du mois (intrants comme le PARI, override de montant).
// Un mois déjà comptabilisé est verrouillé : corriger passerait par une
// contre-écriture dans QB, pas par une réécriture silencieuse côté ERP.
export function updateProvisionMonth(provisionId, month, patch = {}) {
  if (!isMonth(month)) throw new Error('Mois invalide (YYYY-MM attendu)')
  const provision = getProvision(provisionId)
  if (!provision) throw new Error('Provision introuvable')
  const existing = materializedMonth(provisionId, month)
  if (existing?.pushed_at) throw new Error('Ce mois est déjà comptabilisé — impossible de le modifier')

  const inputs = { ...parseJson(existing?.inputs, {}), ...(patch.inputs || {}) }
  const override = patch.override_amount === undefined
    ? existing?.override_amount ?? null
    : (patch.override_amount === null || patch.override_amount === '' ? null : Number(patch.override_amount))
  if (override != null && !Number.isFinite(override)) throw new Error('Montant manuel invalide')

  const now = new Date().toISOString()
  if (existing) {
    db.prepare(`
      UPDATE month_end_provision_months
      SET inputs = ?, override_amount = ?, source = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(inputs), override, override != null ? 'manuel' : 'auto', now, existing.id)
  } else {
    db.prepare(`
      INSERT INTO month_end_provision_months (id, provision_id, month, inputs, override_amount, source)
      VALUES (?,?,?,?,?,?)
    `).run(randomUUID(), provisionId, month, JSON.stringify(inputs), override, override != null ? 'manuel' : 'auto')
  }
  return evaluateProvisionMonth(provision, month)
}

export function updateProvision(id, patch = {}) {
  const provision = getProvision(id)
  if (!provision) throw new Error('Provision introuvable')
  const fields = []
  const values = []
  for (const k of ['label', 'description', 'debit_acctnum', 'credit_acctnum', 'memo']) {
    if (patch[k] !== undefined) { fields.push(`${k} = ?`); values.push(patch[k] === '' ? null : patch[k]) }
  }
  if (patch.active !== undefined) { fields.push('active = ?'); values.push(patch.active ? 1 : 0) }
  if (patch.config !== undefined) {
    const merged = { ...provision.config, ...patch.config }
    fields.push('config = ?'); values.push(JSON.stringify(merged))
  }
  if (!fields.length) return provision
  fields.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
  db.prepare(`UPDATE month_end_provisions SET ${fields.join(', ')} WHERE id = ?`).run(...values, id)
  return getProvision(id)
}

export { prevMonth, monthRange, nextMonth }
