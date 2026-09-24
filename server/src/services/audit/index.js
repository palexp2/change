// Contrôles comptables — le passage.
//
// Un contrôle = { id, label, domain, needsLedger, run(ctx) → constatations }.
// Le passage construit UNE fois le contexte (comptes suivis, index du grand
// livre partagé) et le prête à chaque contrôle : dix contrôles ne font pas dix
// lectures de QuickBooks.
//
// Rien n'est corrigé, rien n'est publié : le résultat est une liste de
// constatations, écrites dans audit_findings, qu'un humain écarte ou règle.
import db from '../../db/database.js'
import { BANK_CHECKS } from './checks/bank.js'
import { syncCheck, findingsSummary } from './store.js'
import { mappedAccounts, getSharedLedgerIndex } from '../bankQbVerify.js'
import { isSystemAutomationActive, logSystemRun } from '../systemAutomations.js'
import { shiftDate } from '../../utils/datetime.js'

export const AUDIT_AUTOMATION_ID = 'sys_audit_controles'

// Le grand livre est plafonné à 90 jours : au-delà, sur douze identifiants de
// compte, QuickBooks répond 500 (déjà vécu par la vérification bancaire).
const LEDGER_DAYS = 90

export const CHECKS = [...BANK_CHECKS]

// Les exercices clos. Avant cette date les écarts ne seront plus corrigés :
// les constater chaque nuit n'aide personne, et les constatations de 2025 qui
// traînaient noyaient les vraies (Charles, 2026-09-19 : la barre est au 1er juin
// 2026). La configuration de l'automation peut la déplacer (« closed_before »),
// la vider l'enlève.
export const CLOSED_BEFORE = '2026-06-01'

export function closedBefore(config = auditConfig()) {
  const v = config.closed_before
  if (v === '' || v === 'off') return null
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : CLOSED_BEFORE
}

// Une constatation qui porte sur une transaction d'un exercice clos est
// écartée avant même d'être écrite.
export function closedYearsFiltered(findings, config = auditConfig()) {
  const floor = closedBefore(config)
  if (!floor) return findings
  const dateOf = db.prepare('SELECT txn_date FROM bank_transactions WHERE id=?')
  return findings.filter((f) => {
    if (f.entity_type !== 'bank_transaction' || !f.entity_id) return true
    const d = f.data?.date || dateOf.get(f.entity_id)?.txn_date
    return !d || d >= floor
  })
}

export function checkById(id) {
  return CHECKS.find((c) => c.id === id) || null
}

export function auditConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(AUDIT_AUTOMATION_ID)
  try { return JSON.parse(row?.action_config || '{}') } catch { return {} }
}

// Un contrôle est actif sauf si la configuration de l'automation le dit éteint
// (« bank_ecart_solde »: « off »).
export function isCheckEnabled(id, config = auditConfig()) {
  const v = config[id]
  return !(v === 'off' || v === 'non' || v === '0' || v === false)
}

/**
 * @param {string[]} [opts.checks]  identifiants à passer (défaut : tous les actifs)
 * @param {boolean}  [opts.dryRun]  calculer sans rien écrire
 */
export async function runAudit({ checks = null, dryRun = false, trigger = 'manuel' } = {}) {
  const t0 = Date.now()
  const config = auditConfig()
  const selected = CHECKS.filter((c) => (checks ? checks.includes(c.id) : isCheckEnabled(c.id, config)))
  const accounts = mappedAccounts()
  const todayIso = new Date().toISOString().slice(0, 10)
  const window = { from: shiftDate(todayIso, -LEDGER_DAYS), to: shiftDate(todayIso, 5) }

  let index = null
  if (selected.some((c) => c.needsLedger)) {
    index = await getSharedLedgerIndex(window.from, window.to)
  }

  const ctx = { accounts, index, window, config }
  const results = []
  for (const check of selected) {
    const started = Date.now()
    try {
      const findings = closedYearsFiltered((await check.run(ctx)) || [])
      const written = dryRun ? { open: findings.length, resolved: 0 } : syncCheck(check.id, findings)
      results.push({
        check_id: check.id, label: check.label, found: findings.length,
        resolved: written.resolved, ms: Date.now() - started,
        findings: dryRun ? findings : undefined,
      })
    } catch (e) {
      results.push({ check_id: check.id, label: check.label, error: e.message, ms: Date.now() - started })
    }
  }

  const found = results.reduce((s, r) => s + (r.found || 0), 0)
  const errors = results.filter((r) => r.error)
  const out = {
    checks: results,
    found,
    resolved: results.reduce((s, r) => s + (r.resolved || 0), 0),
    summary: `${selected.length} contrôle(s) · ${found} constatation(s)${errors.length ? ` · ${errors.length} en erreur` : ''}`,
    duration_ms: Date.now() - t0,
    open: findingsSummary(),
  }
  if (!dryRun) {
    logSystemRun(AUDIT_AUTOMATION_ID, {
      status: errors.length ? 'error' : 'success',
      result: out.summary,
      error: errors.map((e) => `${e.check_id}: ${e.error}`).join(' · ') || null,
      duration_ms: out.duration_ms,
      triggerData: { trigger },
    })
  }
  return out
}

/** Passage planifié : silencieux, rien n'est envoyé nulle part. */
export async function scheduledAudit({ trigger = 'planifie' } = {}) {
  if (!isSystemAutomationActive(AUDIT_AUTOMATION_ID)) return null
  return runAudit({ trigger })
}
