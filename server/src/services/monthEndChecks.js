// Vérifications de préparation de la clôture mensuelle.
//
// La page « Écritures de fin de mois » affiche cette checklist en tête : tout
// ce qui peut faire échouer l'import ou la comptabilisation est vérifié AVANT
// que le comptable clique — connexions (Google pour le Drive, QuickBooks pour
// les JE), fraîcheur de la feuille de temps (fichier modifié après le dernier
// import = à réimporter), paies présentes pour la subvention salariale et
// comptes QB configurés.
//
// Appelée sur une route séparée (/month/:month/checks) : la recherche du
// fichier dans le Drive prend une seconde, la page ne doit pas l'attendre pour
// afficher les provisions.
import db from '../db/database.js'
import { findTimesheetFile, timesheetFileName } from './rdTimesheetImport.js'
import { listProvisions, grossSalaryForMonth } from './monthEnd.js'

const ok = (key, label, detail = null) => ({ key, label, status: 'ok', detail })
const warn = (key, label, detail = null) => ({ key, label, status: 'warn', detail })
const error = (key, label, detail = null) => ({ key, label, status: 'error', detail })

function connectorRow(connector, email = null) {
  if (email) {
    return db.prepare(`
      SELECT account_email FROM connector_oauth
      WHERE connector = ? AND account_email = ? AND refresh_token IS NOT NULL
    `).get(connector, email) || null
  }
  return db.prepare(`
    SELECT account_email FROM connector_oauth
    WHERE connector = ? AND refresh_token IS NOT NULL
    ORDER BY updated_at DESC LIMIT 1
  `).get(connector) || null
}

function checkQuickBooks() {
  const row = connectorRow('quickbooks')
  return row
    ? ok('quickbooks', 'QuickBooks connecté', 'Les écritures pourront être comptabilisées.')
    : error('quickbooks', 'QuickBooks non connecté', 'La comptabilisation échouera — reconnecter QuickBooks dans Connecteurs.')
}

function checkGoogle(preferredEmail) {
  if (preferredEmail) {
    if (connectorRow('google', preferredEmail)) {
      return ok('google', `Google connecté (${preferredEmail})`, 'Le Drive des feuilles de temps est accessible.')
    }
    const fallback = connectorRow('google')
    if (fallback) {
      return warn('google', `Compte Google ${preferredEmail} non connecté`,
        `L'import passera par ${fallback.account_email}, qui n'a peut-être pas accès au dossier des feuilles de temps.`)
    }
    return error('google', 'Aucun compte Google connecté', "L'import de la feuille de temps échouera — connecter un compte dans Connecteurs.")
  }
  const row = connectorRow('google')
  return row
    ? ok('google', `Google connecté (${row.account_email})`)
    : error('google', 'Aucun compte Google connecté', "L'import de la feuille de temps échouera — connecter un compte dans Connecteurs.")
}

// Fraîcheur de la feuille de temps : le fichier du Drive fait foi. S'il a été
// modifié après le dernier import (heures ajoutées le 2 du mois, correction
// d'un onglet), les provisions affichées sont calculées sur des heures périmées.
async function checkTimesheet(month, googleAccountEmail) {
  const expectedName = timesheetFileName(month)
  const lastImport = db.prepare(`
    SELECT MAX(updated_at) AS t FROM rd_month_hours
    WHERE month = ? AND source = 'import' AND deleted_at IS NULL
  `).get(month)?.t || null
  const hasRows = !!db.prepare(`
    SELECT 1 FROM rd_month_hours WHERE month = ? AND deleted_at IS NULL LIMIT 1
  `).get(month)

  let file = null
  try {
    ({ file } = await findTimesheetFile(month, { googleAccountEmail }))
  } catch (e) {
    return error('timesheet', 'Feuille de temps inaccessible', `${expectedName} : ${e.message}`)
  }

  if (!file) {
    return hasRows
      ? warn('timesheet', `Fichier « ${expectedName} » introuvable dans le Drive`,
        'Des heures sont saisies dans l\'ERP, mais le fichier source est absent — impossible de réimporter ou de vérifier.')
      : error('timesheet', `Fichier « ${expectedName} » introuvable dans le Drive`,
        'Aucune heure R&D pour ce mois. Déposer le fichier dans le Drive, puis importer.')
  }
  if (!lastImport) {
    return warn('timesheet', `« ${file.name} » trouvé mais jamais importé`,
      'Cliquer « Importer la feuille de temps » pour charger les heures du mois.')
  }
  if (file.modifiedTime && file.modifiedTime > lastImport) {
    return warn('timesheet', `« ${file.name} » modifié après le dernier import`,
      `Fichier modifié le ${file.modifiedTime.slice(0, 10)}, importé le ${lastImport.slice(0, 10)} — réimporter pour recalculer sur les dernières heures.`)
  }
  return ok('timesheet', `Feuille de temps à jour (${file.name})`,
    `Importée le ${lastImport.slice(0, 10)}, fichier inchangé depuis.`)
}

// Paies du mois : la subvention salariale se calcule sur les paies débitées.
// Zéro paie dans la fenêtre d'admissibilité = la paie n'est pas encore
// synchronisée, la provision serait comptabilisée à 0 par erreur.
function checkPaie(month) {
  const subsidies = listProvisions().filter(p => p.kind === 'wage_subsidy')
  const results = []
  for (const p of subsidies) {
    const cfg = p.config || {}
    if (!cfg.employee_id) {
      results.push(warn(`paie_${p.id}`, `${p.label} : aucun employé configuré`,
        'Choisir l\'employé dans les paramètres de la provision.'))
      continue
    }
    const from = cfg.eligible_from ? String(cfg.eligible_from).slice(0, 7) : null
    const to = cfg.eligible_to ? String(cfg.eligible_to).slice(0, 7) : null
    if ((from && month < from) || (to && month > to)) continue // hors fenêtre : rien à vérifier
    const { gross, pay_count } = grossSalaryForMonth(cfg.employee_id, month)
    results.push(pay_count
      ? ok(`paie_${p.id}`, `Paies du mois présentes (${p.label})`, `${pay_count} paie(s) débitée(s), ${gross.toFixed(2)} $ brut.`)
      : warn(`paie_${p.id}`, `Aucune paie débitée en ${month} (${p.label})`,
        'La synchronisation de la paie n\'est peut-être pas passée — la provision serait à 0.'))
  }
  return results
}

function checkAccounts() {
  const missing = listProvisions()
    .filter(p => !p.debit_acctnum || !p.credit_acctnum)
    .map(p => p.label)
  return missing.length
    ? error('accounts', 'Comptes QuickBooks manquants', `À renseigner dans les paramètres de : ${missing.join(', ')}.`)
    : ok('accounts', 'Comptes QuickBooks configurés sur toutes les provisions')
}

export async function monthEndChecks(month, { googleAccountEmail = null } = {}) {
  const checks = [
    checkQuickBooks(),
    checkGoogle(googleAccountEmail),
    await checkTimesheet(month, googleAccountEmail),
    ...checkPaie(month),
    checkAccounts(),
  ]
  return {
    month,
    checks,
    ready: checks.every(c => c.status === 'ok'),
  }
}
