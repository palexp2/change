// Suivi du budget marketing (Émilie) — automatisation de la procédure Drive
// « Suivi - Budget marketing (Émilie) » :
//
//   1. DÉTECTION — plusieurs fois par jour (cron aux 3 h, cf. index.js), le
//      rapport GeneralLedger de QuickBooks est interrogé sur les
//      comptes de dépenses marketing (75910 Consultants, 75915 Partenaires,
//      75920 Publicité et promotion, 75925 Événements/Conférences, 75930 Repas
//      aux fins de promotion). Toute nouvelle ligne devient une dépense « à
//      valider » dans la page Budget marketing.
//   2. TRI — l'utilisateur tranche : pertinente (activités visant de nouveaux
//      clients au Canada anglais / USA) ou non. Un fournisseur récurrent jamais
//      pertinent (ex. repas d'équipe) devient une règle d'exclusion : ses
//      prochaines dépenses sont écartées automatiquement à l'ingestion.
//   3. ENVOI — chaque mardi, un message Slack court part à Émilie avec les
//      dépenses validées pertinentes depuis le dernier envoi (ou « aucune »).
//      Seules les dépenses DÉJÀ validées partent — jamais une ligne en attente.
//
// Le Budget vs Réel (remplace le fichier « Annual Marketing budget », trop
// fragile pour être modifié programmatiquement) vit dans l'ERP :
// marketing_budget_lines (budget saisi) × marketing_expenses pertinentes (réel).
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { sendSlackWebhook } from './slack.js'
import { shiftDate, localDay } from '../utils/datetime.js'
export { localDay }

export const MARKETING_SYNC_AUTOMATION_ID = 'sys_marketing_expense_sync'
export const MARKETING_SLACK_AUTOMATION_ID = 'sys_marketing_weekly_slack'

const r2 = n => Math.round(Number(n) * 100) / 100

// Comptes QB de la procédure. Le libellé sert de catégorie au Budget vs Réel.
export const MARKETING_ACCOUNTS = [
  { acctnum: '75910', label: 'Consultants' },
  { acctnum: '75915', label: 'Partenaires' },
  { acctnum: '75920', label: 'Publicité et promotion' },
  { acctnum: '75925', label: 'Événements/Conférences' },
  { acctnum: '75930', label: 'Repas aux fins de promotion' },
]

export const MARKETING_SYNC_DEFAULT_CONFIG = {
  accounts: MARKETING_ACCOUNTS.map(a => a.acctnum).join(','),
  start_date: '2026-06-01',   // début de l'onglet « 2026 Réel » du fichier historique
  lookback_days: '45',        // rebalayage pour attraper les saisies tardives QB
}

export const MARKETING_SLACK_DEFAULT_CONFIG = {
  send_weekday: '2',          // ISO : 1=lundi … 7=dimanche. 2 = mardi (jour de la procédure).
  slack_webhook_env: 'SLACK_WEBHOOK_MARKETING',
  recipient: 'Émilie',
}

function loadConfig(automationId, defaults) {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(automationId)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...defaults }
  for (const k of Object.keys(defaults)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

export const getMarketingSyncConfig = () => loadConfig(MARKETING_SYNC_AUTOMATION_ID, MARKETING_SYNC_DEFAULT_CONFIG)
export const getMarketingSlackConfig = () => loadConfig(MARKETING_SLACK_AUTOMATION_ID, MARKETING_SLACK_DEFAULT_CONFIG)

// ── Normalisation fournisseur (même esprit que vendor_profiles) ─────────────
export const vendorKey = s => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '')

// ── Parsing du rapport GeneralLedger (pur, testé) ────────────────────────────

// Aplati les Rows imbriquées (sections/sous-totaux) du rapport GL.
function walkRows(rows, out) {
  for (const r of rows || []) {
    if (r.Rows?.Row) walkRows(r.Rows.Row, out)
    if (r.ColData) out.push(r.ColData)
  }
  return out
}

// Rapport GL d'UN compte → lignes de dépense normalisées. Le montant maison
// (CAD) fait foi ; le montant en devise de la transaction est gardé pour
// l'affichage. Les lignes sans date (« Solde initial », totaux) sont ignorées.
// Une même transaction peut porter plusieurs lignes identiques (rarissime) :
// l'occurrence est suffixée à la clé de dédup pour ne rien perdre.
export function entriesFromGlReport(report, { acctnum, accountLabel }) {
  const colKeys = (report.Columns?.Column || []).map(c => c.MetaData?.find(m => m.Name === 'ColKey')?.Value)
  const idx = k => colKeys.indexOf(k)
  const [iDate, iType, iDoc, iName, iMemo, iCur, iDebit, iCredit, iDebitHome, iCreditHome] =
    ['tx_date', 'txn_type', 'doc_num', 'name', 'memo', 'currency', 'debt_amt', 'credit_amt', 'debt_home_amt', 'credit_home_amt'].map(idx)
  const entries = []
  const seen = new Map()
  for (const cols of walkRows(report.Rows?.Row, [])) {
    const date = cols[iDate]?.value || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const debitHome = Number(cols[iDebitHome]?.value || 0)
    const creditHome = Number(cols[iCreditHome]?.value || 0)
    const amount = r2(debitHome - creditHome)   // dépense = débit positif ; crédit/remboursement = négatif
    if (!amount) continue
    const debit = Number(cols[iDebit]?.value || 0)
    const credit = Number(cols[iCredit]?.value || 0)
    const currency = cols[iCur]?.value || 'CAD'
    const foreign = r2(debit - credit)
    const memo = (cols[iMemo]?.value || '').trim() || null
    const vendor = (cols[iName]?.value || '').trim() || null
    const qbTxnId = cols[iType]?.id ? String(cols[iType].id) : null
    const base = [acctnum, qbTxnId || 'noid', date, amount.toFixed(2), vendorKey(vendor), vendorKey(memo)].join('|')
    const n = (seen.get(base) || 0) + 1
    seen.set(base, n)
    entries.push({
      import_key: n > 1 ? `${base}#${n}` : base,
      qb_txn_id: qbTxnId,
      qb_txn_type_label: cols[iType]?.value || null,
      txn_date: date,
      acctnum,
      account_name: accountLabel,
      vendor,
      memo,
      doc_num: (cols[iDoc]?.value || '').trim() || null,
      amount,
      amount_foreign: currency === 'CAD' ? null : (foreign || null),
      currency,
    })
  }
  return entries
}

// Libellés GL (FR/EN) → entité des URLs QB /app/<entity>?txnId= (sous-ensemble
// des types qui touchent des comptes de dépense).
const TXN_TYPE_ENTITY = {
  'Dépense': 'expense', 'Expense': 'expense',
  'Chèque': 'check', 'Cheque': 'check', 'Check': 'check',
  'Facture à payer': 'bill', 'Bill': 'bill', 'Facture fournisseur': 'bill',
  'Écriture de journal': 'journal', 'Journal Entry': 'journal',
  'Crédit sur carte de crédit': 'creditcardcredit', 'Credit Card Credit': 'creditcardcredit',
  'Crédit de fournisseur': 'vendorcredit', 'Vendor Credit': 'vendorcredit',
}
export const qbEntityForGlType = label => TXN_TYPE_ENTITY[label] || null

// ── Règles d'exclusion ───────────────────────────────────────────────────────

export function listRules() {
  return db.prepare('SELECT * FROM marketing_expense_rules WHERE deleted_at IS NULL ORDER BY vendor_label COLLATE NOCASE').all()
}

// Règle applicable à une dépense (fournisseur normalisé qui se contient dans un
// sens ou l'autre, compte identique ou règle sans compte). Pur — testé.
export function matchRule(rules, { vendor, acctnum }) {
  const k = vendorKey(vendor)
  if (!k) return null
  return (rules || []).find(r =>
    (!r.acctnum || r.acctnum === acctnum) &&
    (r.vendor_key === k || k.includes(r.vendor_key) || r.vendor_key.includes(k))
  ) || null
}

export function createRule({ vendor_label, acctnum = null, note = null }, userId = null) {
  const label = String(vendor_label || '').trim()
  const key = vendorKey(label)
  if (!key) throw new Error('Fournisseur requis')
  const existing = db.prepare(
    'SELECT * FROM marketing_expense_rules WHERE vendor_key=? AND COALESCE(acctnum,\'\')=COALESCE(?,\'\') AND deleted_at IS NULL'
  ).get(key, acctnum)
  if (existing) return existing
  const id = randomUUID()
  db.prepare(`
    INSERT INTO marketing_expense_rules (id, vendor_key, vendor_label, acctnum, note, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(id, key, label, acctnum || null, note || null, userId)
  return db.prepare('SELECT * FROM marketing_expense_rules WHERE id=?').get(id)
}

// Applique une règle nouvellement créée aux dépenses encore en attente (les
// décisions déjà prises ne sont jamais écrasées).
export function applyRuleToPending(rule) {
  const pending = db.prepare(
    "SELECT id, vendor, acctnum FROM marketing_expenses WHERE status='pending' AND deleted_at IS NULL"
  ).all()
  const upd = db.prepare(`
    UPDATE marketing_expenses SET status='not_relevant', rule_id=?, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?
  `)
  let n = 0
  for (const e of pending) {
    if (matchRule([rule], e)) { upd.run(rule.id, e.id); n++ }
  }
  return n
}

// ── Sync GL → marketing_expenses ─────────────────────────────────────────────

/**
 * Interroge le GL QB compte par compte depuis max(dernière dépense − lookback,
 * start_date) et insère les lignes inédites (dédup par import_key). Les règles
 * d'exclusion s'appliquent à l'ingestion : la dépense naît directement
 * « non pertinente » avec la règle en référence.
 */
export async function syncMarketingExpenses({ trigger = 'schedule', force = false } = {}) {
  const t0 = Date.now()
  try {
    if (!force && !isSystemAutomationActive(MARKETING_SYNC_AUTOMATION_ID)) return { skipped: 'inactive' }
    const cfg = getMarketingSyncConfig()
    const { resolveAccountByAcctNum } = await import('./quickbooks.js')
    const { qbGet } = await import('../connectors/quickbooks.js')

    const acctnums = cfg.accounts.split(',').map(s => s.trim()).filter(Boolean)
    const lookback = Math.min(365, Math.max(1, Number(cfg.lookback_days) || 45))
    const last = db.prepare('SELECT MAX(txn_date) AS d FROM marketing_expenses WHERE deleted_at IS NULL').get()?.d
    const since = last && shiftDate(last, -lookback) > cfg.start_date ? shiftDate(last, -lookback) : cfg.start_date
    const today = localDay()

    const rules = listRules()
    const insert = db.prepare(`
      INSERT OR IGNORE INTO marketing_expenses (
        id, import_key, qb_txn_id, qb_txn_type, txn_date, acctnum, account_name,
        vendor, memo, doc_num, amount, amount_foreign, currency, status, rule_id, decided_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)

    const cols = 'tx_date,txn_type,doc_num,name,memo,currency,debt_amt,credit_amt,debt_home_amt,credit_home_amt'
    let inserted = 0, excluded = 0, scanned = 0
    const details = []
    for (const acctnum of acctnums) {
      const meta = MARKETING_ACCOUNTS.find(a => a.acctnum === acctnum)
      const qbAccountId = await resolveAccountByAcctNum(acctnum)
      if (!qbAccountId) { details.push(`⚠️ compte ${acctnum} introuvable dans QB`); continue }
      const report = await qbGet(
        `/reports/GeneralLedger?start_date=${since}&end_date=${today}&account=${qbAccountId}&columns=${cols}`
      )
      const entries = entriesFromGlReport(report, { acctnum, accountLabel: meta?.label || acctnum })
      scanned += entries.length
      for (const e of entries) {
        const rule = matchRule(rules, e)
        const info = insert.run(
          randomUUID(), e.import_key, e.qb_txn_id, qbEntityForGlType(e.qb_txn_type_label),
          e.txn_date, e.acctnum, e.account_name, e.vendor, e.memo, e.doc_num,
          e.amount, e.amount_foreign, e.currency,
          rule ? 'not_relevant' : 'pending', rule?.id || null,
          rule ? new Date().toISOString() : null,
        )
        if (info.changes) { inserted++; if (rule) excluded++ }
      }
    }

    const result = `${scanned} ligne(s) GL depuis le ${since} · ${inserted} nouvelle(s) ` +
      `(${excluded} exclue(s) par règle, ${inserted - excluded} à valider)` +
      (details.length ? ` · ${details.join(' · ')}` : '')
    logSystemRun(MARKETING_SYNC_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger, since }, result,
    })
    return { ok: true, scanned, inserted, excluded, since, result }
  } catch (e) {
    logSystemRun(MARKETING_SYNC_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e,
    })
    console.error('marketingBudget sync:', e.message)
    return { error: e.message }
  }
}

// La détection tourne d'elle-même plusieurs fois par jour (cron aux 3 h dans
// index.js). Pour que ce soit VISIBLE — sinon l'utilisateur ne peut pas
// distinguer « ça tourne » de « le bouton est la seule chose qui marche » — la
// page Budget marketing affiche l'état du dernier passage automatique.
export function lastSyncInfo() {
  const auto = db.prepare('SELECT active FROM automations WHERE id=?').get(MARKETING_SYNC_AUTOMATION_ID)
  // Seuls les passages AUTOMATIQUES comptent : afficher un clic sur le bouton
  // comme « dernier passage automatique » masquerait un cron en panne.
  const log = db.prepare(`
    SELECT created_at, status, result, error FROM automation_logs
    WHERE automation_id=? AND trigger_data LIKE '%cron%' ORDER BY created_at DESC LIMIT 1
  `).get(MARKETING_SYNC_AUTOMATION_ID)
  return {
    active: !!auto?.active,
    schedule: 'aux 3 heures, de 6 h 30 à 18 h 30 (5 passages par jour)',
    at: log?.created_at || null,
    status: log?.status || null,
    detail: log?.error || log?.result || null,
  }
}

// ── Message Slack hebdomadaire ───────────────────────────────────────────────

const fmtMoney = (n, currency = 'CAD') => {
  try { return new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(n) }
  catch { return `${Number(n).toFixed(2)} ${currency}` }
}

function fmtDateFr(dayIso) {
  const d = new Date(`${dayIso}T12:00:00Z`)
  return new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d)
}

// Le message hebdo annonce toujours les dépenses de la semaine PRÉCÉDENTE
// (lundi-dimanche avant dayIso, le jour d'envoi) — jamais celle en cours.
// Pur — testé.
export function previousWeekRangeFr(dayIso) {
  const d = new Date(`${dayIso}T12:00:00Z`)
  const dow = (d.getUTCDay() + 6) % 7 // 0 = lundi
  const thisMonday = new Date(d)
  thisMonday.setUTCDate(d.getUTCDate() - dow)
  const start = new Date(thisMonday)
  start.setUTCDate(thisMonday.getUTCDate() - 7)
  const end = new Date(start)
  end.setUTCDate(start.getUTCDate() + 6)
  const sameMonth = start.getUTCMonth() === end.getUTCMonth()
  const startLabel = sameMonth
    ? new Intl.DateTimeFormat('fr-CA', { day: 'numeric', timeZone: 'UTC' }).format(start)
    : new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(start)
  const endLabel = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(end)
  return `${startLabel} au ${endLabel}`
}

// Dépenses validées pertinentes pas encore annoncées à Émilie.
export function unnotifiedRelevantExpenses() {
  return db.prepare(`
    SELECT * FROM marketing_expenses
    WHERE status='relevant' AND notified_at IS NULL AND deleted_at IS NULL
    ORDER BY txn_date, vendor COLLATE NOCASE
  `).all()
}

export function pendingCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM marketing_expenses WHERE status='pending' AND deleted_at IS NULL").get().n
}

// Message court et clair : une puce par dépense (date, fournisseur, montant
// maison + devise d'origine si étrangère, catégorie), total, ou « aucune ».
// Pur — testé.
export function buildWeeklyMessage(expenses, { dayIso }) {
  const header = `:chart_with_upwards_trend: *Budget marketing — semaine du ${previousWeekRangeFr(dayIso)}*`
  if (!expenses.length) {
    return `${header}\nAucune nouvelle dépense pertinente comptabilisée cette semaine.`
  }
  const lines = expenses.map(e => {
    const foreign = e.currency !== 'CAD' && e.amount_foreign
      ? ` (${fmtMoney(e.amount_foreign, e.currency)})` : ''
    const what = [e.vendor, e.memo].filter(Boolean).join(' — ') || 'Dépense'
    return `• ${fmtDateFr(e.txn_date)} · ${what} · ${fmtMoney(e.amount)}${foreign} _(${e.account_name})_`
  })
  const total = r2(expenses.reduce((s, e) => s + Number(e.amount), 0))
  return `${header}\n${lines.join('\n')}\n*Total : ${fmtMoney(total)}*`
}

// Semaine ISO (clé d'idempotence : un seul envoi planifié par semaine).
export function isoWeekKey(dayIso) {
  const d = new Date(`${dayIso}T12:00:00Z`)
  const day = (d.getUTCDay() + 6) % 7 // 0 = lundi
  d.setUTCDate(d.getUTCDate() - day + 3) // jeudi de la semaine
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4, 12))
  const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function isoWeekday(dayIso) {
  const d = new Date(`${dayIso}T12:00:00Z`)
  return ((d.getUTCDay() + 6) % 7) + 1 // 1 = lundi … 7 = dimanche
}

function alreadySentThisWeek(dayIso) {
  return !!db.prepare(`
    SELECT 1 FROM automation_logs
    WHERE automation_id = ? AND status = 'success' AND result LIKE ?
    LIMIT 1
  `).get(MARKETING_SLACK_AUTOMATION_ID, `HEBDO ${isoWeekKey(dayIso)}%`)
}

/**
 * Faut-il envoyer le message planifié ? Pur — testé.
 *
 * « Aucune nouvelle dépense pertinente cette semaine » n'est vrai que si TOUT a
 * été trié. S'il reste des dépenses en attente de validation et que rien n'est
 * validé, ce message serait une FAUSSE information pour Émilie (elle conclurait
 * qu'il ne s'est rien passé, alors que des dépenses attendent seulement un tri).
 * Dans ce cas on retient l'envoi et le journal dit pourquoi — les dépenses ne
 * sont pas perdues, elles partiront dès qu'elles seront tranchées.
 *
 * Rien à annoncer ET rien en attente = semaine réellement vide → on envoie
 * « aucune dépense », qui est alors exact et rassure sur le fait que le suivi
 * tourne.
 */
export function shouldSendWeekly({ relevantCount, pendingCount: pending }) {
  if (relevantCount > 0) return { send: true }
  if (pending > 0) {
    return {
      send: false,
      reason: `${pending} dépense(s) encore à valider et aucune validée — message retenu ` +
        `(dire « aucune dépense pertinente » serait faux)`,
    }
  }
  return { send: true }
}

/**
 * Scan quotidien : n'envoie que le jour configuré (mardi), une fois par
 * semaine. Une sync est faite juste avant pour que le message reflète le GL du
 * jour. Seules les dépenses validées partent ; les lignes en attente restent
 * dans l'ERP (elles partiront un mardi suivant, une fois tranchées).
 * `force` court-circuite jour et idempotence (bouton « Exécuter »).
 */
export async function checkWeeklyMarketingSlack({ force = false, trigger = 'schedule', today = null } = {}) {
  const t0 = Date.now()
  try {
    if (!isSystemAutomationActive(MARKETING_SLACK_AUTOMATION_ID)) return { skipped: 'inactive' }
    const cfg = getMarketingSlackConfig()
    const dayIso = today || localDay()
    const sendDay = Math.min(7, Math.max(1, Number(cfg.send_weekday) || 2))

    if (!force) {
      if (isoWeekday(dayIso) !== sendDay) return { ok: true, sent: false, reason: "pas le jour d'envoi" }
      if (alreadySentThisWeek(dayIso)) return { ok: true, sent: false, reason: 'déjà envoyé cette semaine' }
    }

    // Rafraîchit le GL pour ne pas annoncer une semaine amputée des dernières
    // saisies QB. Un échec de sync n'empêche pas l'envoi de ce qui est validé.
    await syncMarketingExpenses({ trigger: `avant envoi Slack (${trigger})` })

    const expenses = unnotifiedRelevantExpenses()
    const pending = pendingCount()

    // Envoi planifié : ne jamais annoncer « aucune dépense » alors que des
    // lignes attendent seulement d'être triées. Un envoi forcé (bouton
    // « Envoyer maintenant ») passe outre — c'est un choix explicite.
    const gate = shouldSendWeekly({ relevantCount: expenses.length, pendingCount: pending })
    if (!force && !gate.send) {
      logSystemRun(MARKETING_SLACK_AUTOMATION_ID, {
        status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger, day: dayIso },
        result: `RETENU ${isoWeekKey(dayIso)} — ${gate.reason}`,
      })
      return { ok: true, sent: false, reason: gate.reason, pending }
    }

    const message = buildWeeklyMessage(expenses, { dayIso })
    await sendSlackWebhook(cfg.slack_webhook_env, message)

    const markSent = db.prepare(`
      UPDATE marketing_expenses SET notified_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?
    `)
    const tx = db.transaction(() => { for (const e of expenses) markSent.run(e.id) })
    tx()

    // Seul l'envoi planifié porte le préfixe HEBDO <semaine> : c'est lui qui
    // consomme l'idempotence. Un envoi forcé ne fait pas sauter le mardi suivant.
    const scheduled = isoWeekday(dayIso) === sendDay && !force
    logSystemRun(MARKETING_SLACK_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger, day: dayIso },
      result: `${scheduled ? `HEBDO ${isoWeekKey(dayIso)}` : 'ENVOI MANUEL'} — ${expenses.length} dépense(s) annoncée(s) à ${cfg.recipient}` +
        (pending ? ` · ⚠️ ${pending} en attente de validation (non incluses)` : ''),
    })
    return { ok: true, sent: true, count: expenses.length, pending, message }
  } catch (e) {
    logSystemRun(MARKETING_SLACK_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e,
    })
    console.error('marketingBudget slack:', e.message)
    return { error: e.message }
  }
}

/** Aperçu (bouton « Simuler ») : message qui partirait, sans envoi ni marquage. */
export function previewWeeklyMarketingSlack() {
  const cfg = getMarketingSlackConfig()
  const dayIso = localDay()
  const expenses = unnotifiedRelevantExpenses()
  const pending = pendingCount()
  const gate = shouldSendWeekly({ relevantCount: expenses.length, pendingCount: pending })
  return {
    summary: `${expenses.length} dépense(s) validée(s) à annoncer · ${pending} en attente de validation · ` +
      `envoi le jour ISO ${cfg.send_weekday} (2 = mardi), en fin d'après-midi · ` +
      (process.env[cfg.slack_webhook_env]
        ? `canal : ${cfg.slack_webhook_env} ✓ configuré`
        : `⚠️ ${cfg.slack_webhook_env} absent de server/.env — l'envoi échouera tant que le webhook n'est pas configuré`) +
      (gate.send ? '' : ` · ⚠️ envoi automatique RETENU : ${gate.reason}`),
    apercu: buildWeeklyMessage(expenses, { dayIso }),
  }
}

// ── Budget vs Réel ───────────────────────────────────────────────────────────

// Année financière Orisha : avril → mars. fyStart = 'YYYY' (année du 1er avril).
export function fiscalMonths(fyStart) {
  const y = Number(fyStart)
  const months = []
  for (let i = 0; i < 12; i++) {
    const m = 4 + i
    months.push(`${m > 12 ? y + 1 : y}-${String(((m - 1) % 12) + 1).padStart(2, '0')}`)
  }
  return months
}

export function budgetSummary(fyStart) {
  const months = fiscalMonths(fyStart)
  const [first, last] = [months[0], months[months.length - 1]]
  const budgets = db.prepare(`
    SELECT acctnum, month, budget FROM marketing_budget_lines
    WHERE deleted_at IS NULL AND month >= ? AND month <= ?
  `).all(first, last)
  const reals = db.prepare(`
    SELECT acctnum, substr(txn_date, 1, 7) AS month, SUM(amount) AS total
    FROM marketing_expenses
    WHERE status='relevant' AND deleted_at IS NULL AND substr(txn_date, 1, 7) >= ? AND substr(txn_date, 1, 7) <= ?
    GROUP BY acctnum, substr(txn_date, 1, 7)
  `).all(first, last)
  const categories = MARKETING_ACCOUNTS.map(a => {
    const budget = {}, real = {}
    for (const b of budgets.filter(x => x.acctnum === a.acctnum)) budget[b.month] = r2(b.budget)
    for (const r of reals.filter(x => x.acctnum === a.acctnum)) real[r.month] = r2(r.total)
    return {
      acctnum: a.acctnum, label: a.label,
      budget, real,
      budget_total: r2(Object.values(budget).reduce((s, v) => s + v, 0)),
      real_total: r2(Object.values(real).reduce((s, v) => s + v, 0)),
    }
  })
  return { fy: String(fyStart), months, categories }
}

export function upsertBudgetCell({ acctnum, month, budget }) {
  if (!MARKETING_ACCOUNTS.some(a => a.acctnum === String(acctnum))) throw new Error('Compte inconnu')
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new Error('month au format YYYY-MM')
  const amount = r2(budget)
  if (!Number.isFinite(amount) || amount < 0) throw new Error('budget doit être un nombre ≥ 0')
  const existing = db.prepare(
    'SELECT id FROM marketing_budget_lines WHERE acctnum=? AND month=? AND deleted_at IS NULL'
  ).get(String(acctnum), month)
  if (existing) {
    db.prepare(`UPDATE marketing_budget_lines SET budget=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
      .run(amount, existing.id)
    return existing.id
  }
  const id = randomUUID()
  db.prepare('INSERT INTO marketing_budget_lines (id, acctnum, month, budget) VALUES (?,?,?,?)')
    .run(id, String(acctnum), month, amount)
  return id
}
