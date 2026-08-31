// Déboursés mensuels en pièces — automatisation de la procédure Google Docs
// « Procédures_Pieces_Déboursés_mensuels ».
//
// Ce que le comptable faisait à la main chaque mois :
//   1. exporter le grand livre du compte 14000 Stock de Pièces vers Sheets
//   2. supprimer les écritures de journal — ne restent que « Dépense » et
//      « Facture à payer »
//   3. recopier le bloc sommaire du fichier du mois précédent
//   4. Achats du mois + À payer au début − À payer à la fin = Déboursés du mois
//   5. déposer le fichier dans Comptabilité/…/Stocks/Déboursés_Pièces
//   6. envoyer le montant à Guillaume sur Slack
//
// Les étapes 1 à 5 sont mécaniques : l'ERP les fait le 7 du mois. L'étape 6 ne
// part JAMAIS toute seule — l'utilisateur valide le montant dans l'ERP puis
// clique pour envoyer, exactement comme la comptabilisation QB des provisions.
//
// Deux subtilités reprises telles quelles de la procédure :
//   · « À payer au début » = le « À payer à la fin » du mois précédent (les
//     factures dues à la fin du mois passé sont déboursées ce mois-ci) ;
//   · « À payer à la fin » = les factures fournisseurs du mois encore impayées
//     au dernier jour du mois — déterminé par les paiements liés dans QB, ce
//     que le comptable allait chercher à la main dans la fiche du fournisseur.
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import XLSX from 'xlsx'
import db from '../db/database.js'
import { qbGet } from '../connectors/quickbooks.js'
import { resolveAccountByAcctNum } from './quickbooks.js'
import { getDriveClient } from '../connectors/google.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { createNotification } from './notifications.js'
import { completeLiaDescription } from './purchaseLiaMatch.js'
import { APP_URL } from '../config/appUrl.js'
import { round2Safe as round2 } from '../utils/money.js'

export const PIECES_AUTOMATION_ID = 'sys_pieces_disbursements'

const MONTH_LABELS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre']

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

export function monthLabel(month) {
  return `${MONTH_LABELS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
}

// Nom du fichier Drive : convention des mois précédents (Mars26, Avril26, Mai26).
export function driveFileName(month) {
  return `Pièces_Déboursés_${MONTH_LABELS[Number(month.slice(5, 7)) - 1]}${month.slice(2, 4)}`
}

export function monthBounds(month) {
  const [y, m] = month.split('-').map(Number)
  const end = new Date(Date.UTC(y, m, 0))
  return { start: `${month}-01`, end: end.toISOString().slice(0, 10) }
}

export function previousMonth(month) {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return d.toISOString().slice(0, 7)
}


// ── Config de l'automation (page Automations) ───────────────────────────────

export function piecesConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id = ?').get(PIECES_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch { /* config cassée = valeurs par défaut */ }
  return {
    acctnum: String(cfg.acctnum || '14000').trim(),
    driveFolderId: String(cfg.drive_folder_id || '').trim() || null,
    googleAccountEmail: String(cfg.google_account_email || '').trim() || null,
    slackWebhookEnv: String(cfg.slack_webhook_env || 'SLACK_WEBHOOK_GUILLAUME').trim(),
    recipient: String(cfg.recipient || 'Guillaume').trim(),
  }
}

// ── Lecture du grand livre QuickBooks ───────────────────────────────────────

function walkRows(rows, out = []) {
  for (const r of rows || []) {
    if (r.Rows?.Row) walkRows(r.Rows.Row, out)
    if (r.ColData) out.push(r.ColData)
  }
  return out
}

const isJournal = type => /journal/i.test(type || '')
const isBill = type => /facture à payer|^bill$/i.test(type || '')

// Lignes du compte de stock pour la période, écritures de journal exclues.
// La colonne retenue est `subt_nat_amount_home_nt` : le montant en devise
// maison (CAD). `debt_amt`/`credit_amt` portent le montant en devise de la
// transaction — une facture en USD y apparaîtrait à sa valeur USD et fausserait
// le total du mois.
export async function fetchPiecesLines(acctnum, start, end) {
  const accountId = await resolveAccountByAcctNum(acctnum)
  if (!accountId) throw new Error(`Compte QuickBooks ${acctnum} introuvable`)
  const cols = 'tx_date,txn_type,doc_num,name,memo,split_acc,subt_nat_amount_home_nt'
  const data = await qbGet(
    `/reports/GeneralLedger?start_date=${start}&end_date=${end}&account=${accountId}&columns=${cols}`
  )
  const keys = (data.Columns?.Column || []).map(c => c.MetaData?.find(m => m.Name === 'ColKey')?.Value)
  const i = k => keys.indexOf(k)
  const lines = []
  for (const cols of walkRows(data.Rows?.Row)) {
    const date = cols[i('tx_date')]?.value
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) continue // « Solde initial », totaux
    const typeCol = cols[i('txn_type')]
    const type = typeCol?.value || ''
    if (isJournal(type)) continue
    lines.push({
      date,
      type,
      qb_id: typeCol?.id ? String(typeCol.id) : null,
      doc_num: cols[i('doc_num')]?.value || '',
      name: cols[i('name')]?.value || '',
      // Une description réduite au code (« LIA-1961 ») est complétée avec le nom de la
      // pièce depuis la table Achats : le fichier doit se lire sans aller chercher à quoi
      // renvoie le code, comme les lignes saisies à la main les mois précédents.
      memo: completeLiaDescription(cols[i('memo')]?.value || ''),
      split_acc: cols[i('split_acc')]?.value || '',
      amount: round2(String(cols[i('subt_nat_amount_home_nt')]?.value || 0).replace(/[^\d.-]/g, '')),
    })
  }
  return lines
}

// Date du dernier paiement d'une facture QB au plus tard le `asOf`, ou null si
// elle était encore impayée à cette date.
// Le type lié est `BillPaymentCheck` / `BillPaymentCreditCard`, jamais
// `BillPayment` tout court — filtrer sur l'égalité stricte rendrait toutes les
// factures « impayées » et gonflerait « À payer à la fin » de tout le mois.
async function billPaidBy(billId, asOf, cache) {
  if (cache.has(billId)) return cache.get(billId)
  let paidAt = null
  try {
    const bill = (await qbGet(`/bill/${billId}`)).Bill
    for (const link of (bill?.LinkedTxn || []).filter(l => /^BillPayment/.test(l.TxnType))) {
      const payment = (await qbGet(`/billpayment/${link.TxnId}`)).BillPayment
      const date = payment?.TxnDate
      if (date && date <= asOf && (!paidAt || date > paidAt)) paidAt = date
    }
  } catch {
    // Une facture illisible (supprimée, droits) ne doit pas faire échouer le
    // mois entier : elle est comptée comme impayée et signalée en avertissement.
    return cache.set(billId, { error: true, paidAt: null }).get(billId)
  }
  cache.set(billId, { error: false, paidAt })
  return cache.get(billId)
}

// Factures du mois encore dues au dernier jour du mois, ligne par ligne.
async function unpaidBillLines(lines, end, cache) {
  const out = []
  const warnings = []
  for (const line of lines.filter(l => isBill(l.type))) {
    if (!line.qb_id) { out.push(line); warnings.push(`Facture « ${line.name} » sans identifiant QB — comptée comme impayée`); continue }
    const { error, paidAt } = await billPaidBy(line.qb_id, end, cache)
    if (error) { out.push(line); warnings.push(`Facture QB #${line.qb_id} (${line.name}) illisible — comptée comme impayée`); continue }
    if (!paidAt) out.push({ ...line, paid_at: null })
  }
  return { lines: out, warnings }
}

// ── Calcul d'un mois ────────────────────────────────────────────────────────

// `À payer à la fin` du mois précédent = `À payer au début` du mois courant.
// On préfère la valeur enregistrée (elle peut porter une correction manuelle),
// sinon on la recalcule depuis QB. Un seul niveau de récursion : le mois
// précédent n'a jamais besoin de son propre prédécesseur ici.
async function openingPayable(month, acctnum) {
  const prev = previousMonth(month)
  const saved = getSavedMonth(prev)
  if (saved) return { amount: round2(effectiveClosing(saved)), source: `enregistré (${monthLabel(prev)})` }
  const { start, end } = monthBounds(prev)
  const lines = await fetchPiecesLines(acctnum, start, end)
  const { lines: unpaid } = await unpaidBillLines(lines, end, new Map())
  return { amount: round2(unpaid.reduce((s, l) => s + l.amount, 0)), source: `recalculé (${monthLabel(prev)})` }
}

export async function computePiecesMonth(month) {
  const { acctnum } = piecesConfig()
  const { start, end } = monthBounds(month)

  const lines = await fetchPiecesLines(acctnum, start, end)
  const cache = new Map()
  const { lines: unpaid, warnings } = await unpaidBillLines(lines, end, cache)

  const achats = round2(lines.reduce((s, l) => s + l.amount, 0))
  const closing = round2(unpaid.reduce((s, l) => s + l.amount, 0))
  const opening = await openingPayable(month, acctnum)

  if (!lines.length) warnings.push(`Aucune dépense ni facture de pièces dans le compte ${acctnum} pour ${monthLabel(month)}`)

  return {
    month,
    account: acctnum,
    lines,
    unpaid_lines: unpaid,
    achats,
    a_payer_debut: opening.amount,
    a_payer_debut_source: opening.source,
    a_payer_fin: closing,
    debourses: round2(achats + opening.amount - closing),
    warnings,
  }
}

// ── Persistance ─────────────────────────────────────────────────────────────

function getSavedMonth(month) {
  return db.prepare('SELECT * FROM pieces_disbursements WHERE month = ? AND deleted_at IS NULL').get(month) || null
}

// Un override saisi à la main l'emporte sur le calcul — le comptable reste
// maître du chiffre (cas d'une facture réglée hors QB, d'un décalage connu…).
const effectiveOpening = row => row.override_debut ?? row.a_payer_debut ?? 0
const effectiveClosing = row => row.override_fin ?? row.a_payer_fin ?? 0

function saveMonth(computed) {
  const existing = getSavedMonth(computed.month)
  const payload = {
    achats: computed.achats,
    a_payer_debut: computed.a_payer_debut,
    a_payer_fin: computed.a_payer_fin,
    lines_json: JSON.stringify({ lines: computed.lines, unpaid: computed.unpaid_lines }),
  }
  if (existing) {
    db.prepare(`
      UPDATE pieces_disbursements
      SET achats = ?, a_payer_debut = ?, a_payer_fin = ?, lines_json = ?, updated_at = ${NOW}
      WHERE month = ?
    `).run(payload.achats, payload.a_payer_debut, payload.a_payer_fin, payload.lines_json, computed.month)
  } else {
    db.prepare(`
      INSERT INTO pieces_disbursements (month, achats, a_payer_debut, a_payer_fin, lines_json)
      VALUES (?,?,?,?,?)
    `).run(computed.month, payload.achats, payload.a_payer_debut, payload.a_payer_fin, payload.lines_json)
  }
  return getSavedMonth(computed.month)
}

// État complet servi à la page : chiffres calculés + corrections + fichier
// Drive + envoi Slack.
export function piecesMonthState(month) {
  const row = getSavedMonth(month)
  if (!row) return { month, computed: false }
  let parsed = { lines: [], unpaid: [] }
  try { parsed = JSON.parse(row.lines_json || '{}') } catch { /* json cassé = pas de détail */ }
  const opening = effectiveOpening(row)
  const closing = effectiveClosing(row)
  const achats = row.achats ?? 0
  return {
    month,
    computed: true,
    lines: parsed.lines || [],
    unpaid_lines: parsed.unpaid || [],
    achats,
    a_payer_debut: opening,
    a_payer_fin: closing,
    a_payer_debut_calcule: row.a_payer_debut ?? 0,
    a_payer_fin_calcule: row.a_payer_fin ?? 0,
    override_debut: row.override_debut,
    override_fin: row.override_fin,
    debourses: round2(achats + opening - closing),
    drive_file_id: row.drive_file_id,
    drive_url: row.drive_url,
    drive_name: row.drive_name,
    generated_at: row.generated_at,
    slack_sent_at: row.slack_sent_at,
    slack_text: row.slack_text,
    updated_at: row.updated_at,
  }
}

export function updatePiecesMonth(month, patch) {
  const row = getSavedMonth(month)
  if (!row) throw new Error('Ce mois n\'a pas encore été calculé')
  const fields = []
  const values = []
  for (const key of ['override_debut', 'override_fin']) {
    if (patch[key] === undefined) continue
    const v = patch[key] === null || patch[key] === '' ? null : Number(patch[key])
    if (v !== null && !Number.isFinite(v)) throw new Error(`${key} invalide`)
    fields.push(`${key} = ?`)
    values.push(v)
  }
  if (fields.length) {
    db.prepare(`UPDATE pieces_disbursements SET ${fields.join(', ')}, updated_at = ${NOW} WHERE month = ?`)
      .run(...values, month)
  }
  return piecesMonthState(month)
}

// ── Fichier Drive ───────────────────────────────────────────────────────────

const fmtAmount = n => new Intl.NumberFormat('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

// Reproduit la mise en page des fichiers des mois précédents : le tableau des
// opérations, puis le bloc sommaire en bas à droite et la liste des factures
// encore dues à gauche. Les totaux sont des FORMULES, pas des constantes — le
// comptable doit pouvoir corriger une ligne dans le Sheet et voir le déboursé
// se recalculer, comme dans ses fichiers actuels.
export function buildPiecesWorkbook(state) {
  const headers = ['Date de l’opération', 'Type d’opération', 'Nº', 'Nom', 'Description', 'Compte de répartition', 'Montant']
  const rows = [headers, ...state.lines.map(l => [l.date, l.type, l.doc_num, l.name, l.memo, l.split_acc, l.amount])]

  const firstLine = 2
  const lastLine = rows.length // 1-indexé : ligne du dernier mouvement
  const ws = XLSX.utils.aoa_to_sheet(rows)

  const sumRow = rows.length + 1
  const summaryStart = sumRow + 2
  const cell = (r, c, v) => { ws[XLSX.utils.encode_cell({ r: r - 1, c })] = v }
  const money = v => ({ t: 'n', v, z: '#,##0.00' })
  const formula = (f, z = '#,##0.00') => ({ t: 'n', f, z })

  // Total de la colonne Montant, juste sous le tableau.
  if (state.lines.length) cell(sumRow, 6, formula(`SUM(G${firstLine}:G${lastLine})`))

  // Bloc sommaire (colonnes F/G) — le cœur de la procédure.
  const block = [
    ['Achats du mois', state.lines.length ? formula(`SUM(G${firstLine}:G${lastLine})`) : money(0)],
    ['(+) À payer au début', money(state.a_payer_debut)],
    ['(-) À payer à la fin', money(-state.a_payer_fin)],
  ]
  block.forEach(([label, value], i) => {
    cell(summaryStart + i, 5, { t: 's', v: label })
    cell(summaryStart + i, 6, value)
  })
  cell(summaryStart + 3, 5, { t: 's', v: 'Déboursés du mois' })
  cell(summaryStart + 3, 6, formula(`SUM(G${summaryStart}:G${summaryStart + 2})`))

  // Détail des factures encore dues au dernier jour du mois (colonnes A-C) :
  // c'est ce que le comptable allait vérifier fournisseur par fournisseur.
  cell(summaryStart, 0, { t: 's', v: 'À payer - fin du mois' })
  state.unpaid_lines.forEach((l, i) => {
    cell(summaryStart + 1 + i, 0, { t: 's', v: l.name || '' })
    cell(summaryStart + 1 + i, 1, { t: 's', v: l.doc_num || '' })
    cell(summaryStart + 1 + i, 2, money(l.amount))
  })

  const lastRow = Math.max(summaryStart + 3, summaryStart + state.unpaid_lines.length)
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow - 1, c: 6 } })
  ws['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 16 }, { wch: 26 }, { wch: 52 }, { wch: 30 }, { wch: 14 }]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Déboursés')
  return wb
}

function resolveGoogleAccount(email) {
  const row = email
    ? db.prepare("SELECT id, account_email FROM connector_oauth WHERE connector='google' AND account_email=? AND refresh_token IS NOT NULL").get(email)
    : db.prepare("SELECT id, account_email FROM connector_oauth WHERE connector='google' AND refresh_token IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get()
  if (!row) throw new Error(email ? `Compte Google ${email} non connecté` : 'Aucun compte Google connecté')
  return row
}

// Dépose (ou remplace) le Google Sheet du mois dans le dossier Déboursés_Pièces.
// Régénérer un mois écrase le fichier existant plutôt que d'en créer un
// deuxième : deux « Pièces_Déboursés_Juillet26 » dans le dossier, et personne
// ne sait plus lequel fait foi.
export async function generatePiecesSheet(month) {
  const state = piecesMonthState(month)
  if (!state.computed) throw new Error('Calculer le mois avant de générer le fichier')
  const cfg = piecesConfig()
  if (!cfg.driveFolderId) throw new Error('Dossier Drive non configuré (page Automations)')

  const account = resolveGoogleAccount(cfg.googleAccountEmail)
  const drive = await getDriveClient(account.id)
  const name = driveFileName(month)

  const tmpPath = join(tmpdir(), `pieces-${month}-${process.pid}.xlsx`)
  writeFileSync(tmpPath, XLSX.write(buildPiecesWorkbook(state), { type: 'buffer', bookType: 'xlsx' }))

  try {
    const media = {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: (await import('fs')).createReadStream(tmpPath),
    }
    let file
    if (state.drive_file_id) {
      file = (await drive.files.update({
        fileId: state.drive_file_id,
        requestBody: { name },
        media,
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
      })).data
    } else {
      file = (await drive.files.create({
        requestBody: {
          name,
          parents: [cfg.driveFolderId],
          mimeType: 'application/vnd.google-apps.spreadsheet', // conversion en Google Sheet
        },
        media,
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
      })).data
    }
    db.prepare(`
      UPDATE pieces_disbursements
      SET drive_file_id = ?, drive_url = ?, drive_name = ?, generated_at = ${NOW}, updated_at = ${NOW}
      WHERE month = ?
    `).run(file.id, file.webViewLink || null, file.name, month)
    return piecesMonthState(month)
  } finally {
    try { unlinkSync(tmpPath) } catch { /* fichier temporaire déjà parti */ }
  }
}

// ── Message Slack ───────────────────────────────────────────────────────────

// Le texte validé avec l'utilisateur. Le lien pointe vers la section
// « Déboursés de pièces » de l'ERP (syntaxe Slack <url|libellé>) plutôt que
// vers le fichier Drive — l'interface y est plus lisible pour Guillaume.
export function piecesSlackText(state) {
  const mois = MONTH_LABELS[Number(state.month.slice(5, 7)) - 1].toLowerCase()
  const appUrl = APP_URL
  const parts = [
    'Mon général :saluting_face:',
    '',
    `Les déboursés du mois de ${mois} en pièces correspondent à ${fmtAmount(state.debourses)} $.`,
    '',
    `Le détail est ici : <${appUrl}/erp/fin-de-mois|Déboursés de pièces>`,
  ]
  return parts.join('\n')
}

export function piecesSlackPreview(month) {
  const state = piecesMonthState(month)
  if (!state.computed) throw new Error('Ce mois n\'a pas encore été calculé')
  const cfg = piecesConfig()
  return {
    text: piecesSlackText(state),
    recipient: cfg.recipient,
    webhook_env: cfg.slackWebhookEnv,
    webhook_configured: !!process.env[cfg.slackWebhookEnv],
    already_sent_at: state.slack_sent_at,
    debourses: state.debourses,
    drive_url: state.drive_url,
  }
}

export async function sendPiecesSlack(month, { userId = null } = {}) {
  const state = piecesMonthState(month)
  if (!state.computed) throw new Error('Ce mois n\'a pas encore été calculé')
  const cfg = piecesConfig()
  const url = process.env[cfg.slackWebhookEnv]
  if (!url) throw new Error(`Webhook Slack manquant : ajouter ${cfg.slackWebhookEnv} dans server/.env`)

  const text = piecesSlackText(state)
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Slack HTTP ${resp.status}${body ? ` : ${body.slice(0, 160)}` : ''}`)
  }

  db.prepare(`
    UPDATE pieces_disbursements
    SET slack_sent_at = ${NOW}, slack_text = ?, slack_sent_by = ?, updated_at = ${NOW}
    WHERE month = ?
  `).run(text, userId, month)
  logSystemRun(PIECES_AUTOMATION_ID, {
    status: 'success',
    result: `Message envoyé à ${cfg.recipient} — déboursés ${monthLabel(month)} : ${fmtAmount(state.debourses)} $`,
    triggerData: { trigger: 'envoi manuel', month },
  })
  return piecesMonthState(month)
}

// ── Préparation automatique (cron du 7) ─────────────────────────────────────

// Mois à traiter le 7 : celui qui vient de se terminer.
export function targetMonth(today = new Date()) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
  d.setUTCMonth(d.getUTCMonth() - 1)
  return d.toISOString().slice(0, 7)
}

// Recalcule le mois, dépose le fichier, et prévient les admins qu'il reste à
// valider le montant puis à l'envoyer. N'envoie RIEN sur Slack.
export async function preparePiecesMonth({ trigger = 'cron', dryRun = false, month = null } = {}) {
  const t0 = Date.now()
  const target = month || targetMonth()

  if (dryRun) {
    const computed = await computePiecesMonth(target)
    return {
      month: target,
      dry_run: true,
      summary: `${monthLabel(target)} — achats ${fmtAmount(computed.achats)} $, `
        + `à payer au début ${fmtAmount(computed.a_payer_debut)} $, à payer à la fin ${fmtAmount(computed.a_payer_fin)} $ `
        + `→ déboursés ${fmtAmount(computed.debourses)} $ (aucun fichier déposé, aucun message envoyé)`,
    }
  }

  if (!isSystemAutomationActive(PIECES_AUTOMATION_ID)) return { skipped: 'automation inactive' }

  try {
    const computed = await computePiecesMonth(target)
    saveMonth(computed)

    let fileError = null
    let state = piecesMonthState(target)
    try {
      state = await generatePiecesSheet(target)
    } catch (e) {
      fileError = e.message
    }

    const summary = `${monthLabel(target)} — déboursés ${fmtAmount(state.debourses)} $ `
      + `(achats ${fmtAmount(state.achats)} $ + début ${fmtAmount(state.a_payer_debut)} $ − fin ${fmtAmount(state.a_payer_fin)} $)`
      + (fileError ? ` · ⚠️ fichier Drive : ${fileError}` : ` · ${state.drive_name} déposé`)

    const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin' AND active = 1`).all()
    for (const u of admins) {
      createNotification({
        userId: u.id,
        type: 'pieces_disbursements',
        title: `Déboursés de pièces prêts — ${monthLabel(target)}`,
        body: `${fmtAmount(state.debourses)} $ à valider avant l'envoi à ${piecesConfig().recipient}.`
          + (fileError ? ` ⚠️ Fichier Drive non déposé : ${fileError}` : ''),
        link: '/fin-de-mois',
      })
    }

    logSystemRun(PIECES_AUTOMATION_ID, {
      status: fileError ? 'warning' : 'success',
      result: summary,
      triggerData: { trigger, month: target },
      duration_ms: Date.now() - t0,
    })
    return { month: target, summary, debourses: state.debourses, file_error: fileError }
  } catch (e) {
    logSystemRun(PIECES_AUTOMATION_ID, {
      status: 'error', error: e, duration_ms: Date.now() - t0, triggerData: { trigger, month: target },
    })
    // Un échec silencieux se découvrirait des semaines plus tard, le mois passé
    // et Guillaume sans chiffre — même logique que la clôture de fin de mois.
    try {
      const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin' AND active = 1`).all()
      for (const u of admins) {
        createNotification({
          userId: u.id,
          type: 'pieces_disbursements',
          title: `Déboursés de pièces ${monthLabel(target)} : la préparation a échoué`,
          body: `${e.message} — ouvrir « Écritures de fin de mois » pour relancer le calcul.`,
          link: '/fin-de-mois',
        })
      }
    } catch { /* la notification ne doit pas masquer l'erreur d'origine */ }
    throw e
  }
}

// Recalcul à la demande (bouton de la page) — mêmes chiffres que le cron.
export async function recomputePiecesMonth(month) {
  const computed = await computePiecesMonth(month)
  saveMonth(computed)
  return { ...piecesMonthState(month), warnings: computed.warnings, a_payer_debut_source: computed.a_payer_debut_source }
}
