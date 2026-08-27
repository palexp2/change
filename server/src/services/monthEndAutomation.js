// Préparation automatique de la clôture mensuelle.
//
// Le 1er de chaque mois, l'ERP fait à la place du comptable les étapes
// mécaniques des deux procédures Google Docs : aller chercher la feuille de
// temps du mois écoulé dans le Drive, en tirer les heures R&D, recalculer les
// provisions et prévenir que les écritures sont prêtes à être approuvées.
//
// La comptabilisation dans QuickBooks n'est JAMAIS automatique : la préparation
// s'arrête au moment où un humain doit regarder les montants.
import db from '../db/database.js'
import { importRdHours, parseContractors } from './rdTimesheetImport.js'
import { monthEndState } from './monthEnd.js'
import { createNotification } from './notifications.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

export const MONTH_END_AUTOMATION_ID = 'sys_month_end_provisions'

// Config éditable de l'automation (page Automations) : compte Google qui a
// accès au dossier des feuilles de temps et liste des sous-traitants. Lue à
// chaque exécution pour que l'import manuel et le cron suivent le même réglage.
export function monthEndAutomationConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id = ?').get(MONTH_END_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  return {
    googleAccountEmail: String(cfg.google_account_email || '').trim() || null,
    contractors: parseContractors(cfg.contractors),
  }
}

function notifyAdmins({ title, body }) {
  const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin' AND active = 1`).all()
  for (const u of admins) {
    createNotification({ userId: u.id, type: 'month_end', title, body, link: '/fin-de-mois' })
  }
}

// Mois à clôturer : celui qui vient de se terminer.
export function closingMonth(today = new Date()) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
  d.setUTCMonth(d.getUTCMonth() - 1)
  return d.toISOString().slice(0, 7)
}

function summarize(month, state, importResult, importError) {
  const parts = [`Clôture ${month}`]
  if (importResult) {
    parts.push(`${importResult.file.name} : ${importResult.employee_hours} h employés`)
    if (importResult.skipped.length) parts.push(`${importResult.skipped.length} ligne(s) manuelle(s) conservée(s)`)
  } else if (importError) {
    parts.push(`import des heures impossible (${importError})`)
  }
  for (const p of state.provisions.filter(x => x.active)) {
    parts.push(`${p.label} : ${p.amount.toFixed(2)} $${p.pushed_at ? ' (déjà comptabilisé)' : ''}`)
  }
  return parts.join(' · ')
}

// `dryRun` = bouton « Simuler » de la page Automations : calcule et résume sans
// rien importer ni notifier.
export async function prepareMonthEnd({ trigger = 'cron', dryRun = false, month = null } = {}) {
  const t0 = Date.now()
  const target = month || closingMonth()

  if (dryRun) {
    const state = monthEndState(target)
    return { summary: summarize(target, state, null, null), month: target, dry_run: true }
  }

  if (!isSystemAutomationActive(MONTH_END_AUTOMATION_ID)) return { skipped: 'automation inactive' }

  let importResult = null
  let importError = null
  try {
    importResult = await importRdHours(target, monthEndAutomationConfig())
  } catch (e) {
    // Un fichier de feuille de temps absent ou en retard ne doit pas empêcher
    // le calcul et la notification : les provisions restent visibles, la carte
    // des heures signalera qu'il n'y a rien à provisionner.
    importError = e.message
  }

  try {
    const state = monthEndState(target)
    const pending = state.provisions.filter(p => p.active && !p.pushed_at && p.amount > 0)
    const summary = summarize(target, state, importResult, importError)

    if (pending.length || importError) {
      const total = pending.reduce((s, p) => s + p.amount, 0)
      const title = pending.length
        ? `Écritures de fin de mois prêtes — ${target}`
        : `Clôture ${target} : heures R&D à vérifier`
      const missing = importResult?.missing_from_previous?.length
        ? ` ⚠️ Sans onglet ce mois-ci : ${importResult.missing_from_previous.join(', ')}.`
        : ''
      const body = pending.length
        ? `${pending.map(p => `${p.label} : ${p.amount.toFixed(2)} $`).join(' · ')} — total ${total.toFixed(2)} $ à approuver.`
          + (importError ? ` ⚠️ Import des heures : ${importError}` : '') + missing
        : `Import des heures impossible : ${importError}`

      // Notification in-app aux admins — la cloche de l'ERP, pas un courriel :
      // l'action à faire se trouve dans l'ERP même.
      notifyAdmins({ title, body })
    }

    logSystemRun(MONTH_END_AUTOMATION_ID, {
      status: 'success',
      result: importError ? `${summary} · ⚠️ ${importError}` : summary,
      triggerData: { trigger, month: target },
      duration_ms: Date.now() - t0,
    })
    return { month: target, summary, pending: pending.length, import_error: importError }
  } catch (e) {
    logSystemRun(MONTH_END_AUTOMATION_ID, { status: 'error', error: e, duration_ms: Date.now() - t0, triggerData: { trigger, month: target } })
    // Un échec de préparation ne doit jamais être silencieux : sans cette
    // alerte, on ne s'en apercevrait qu'en ouvrant la page — peut-être des
    // semaines plus tard, la clôture du mois passée.
    try {
      notifyAdmins({
        title: `Clôture ${target} : la préparation automatique a échoué`,
        body: `${e.message} — ouvrir la page « Écritures de fin de mois » pour relancer l'import et vérifier les provisions.`,
      })
    } catch { /* la notification ne doit pas masquer l'erreur d'origine */ }
    throw e
  }
}
