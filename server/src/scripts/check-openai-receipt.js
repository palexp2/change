/**
 * Vérifie si le reçu OpenAI du cycle courant est bien arrivé dans l'ERP.
 *
 * Contexte : l'adresse du compte ChatGPT a été changée le 2026-07-21 vers
 * achat@orisha.io (alias livré dans la boîte de pap@, où l'autodétection est
 * active). Aucun reçu OpenAI n'a été reçu par courriel depuis le 2026-06-03 —
 * celui du 1er juillet a dû être téléversé à la main. On contrôle donc les deux
 * bouts : la boîte Gmail ET la table sale_receipts.
 *
 * Dépose une notification in-app (cloche de l'ERP) avec le verdict.
 *
 * Usage : node src/scripts/check-openai-receipt.js [--since=YYYY-MM-DD]
 */
import db from '../db/database.js'
import { getGmailClient } from '../connectors/google.js'
import { createNotification } from '../services/notifications.js'

const sinceArg = process.argv.find(a => a.startsWith('--since='))?.split('=')[1]
const since = sinceArg || new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10)
const header = (hs, n) => (hs || []).find(h => h.name.toLowerCase() === n)?.value || ''

// 1. Reçus OpenAI entrés dans l'ERP depuis la date de référence.
const inErp = db.prepare(`
  SELECT original_name, total, currency, receipt_date, source, status, created_at
  FROM sale_receipts
  WHERE deleted_at IS NULL AND created_at >= ? AND (company LIKE '%OpenAI%' OR original_name LIKE '%openai%')
  ORDER BY created_at
`).all(since)

// 2. Courriels de facturation OpenAI/Stripe reçus dans les boîtes connectées.
const days = Math.max(1, Math.ceil((Date.now() - Date.parse(since)) / 864e5))
const q = `(from:openai.com OR from:stripe.com) (receipt OR invoice OR facture OR reçu) newer_than:${days}d`
const inGmail = []
for (const acc of db.prepare(
  `SELECT id, account_email FROM connector_oauth WHERE connector='google' AND refresh_token IS NOT NULL`
).all()) {
  let gmail
  try { gmail = await getGmailClient(acc.id) } catch { continue }
  let msgs = []
  try { msgs = (await gmail.users.messages.list({ userId: 'me', q, maxResults: 10 })).data.messages || [] }
  catch { continue }
  for (const m of msgs) {
    const msg = await gmail.users.messages.get({
      userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'],
    })
    const hs = msg.data.payload?.headers
    inGmail.push({
      boite: acc.account_email, date: header(hs, 'date'),
      de: header(hs, 'from'), a: header(hs, 'to'), sujet: header(hs, 'subject'),
    })
  }
}

const openaiMail = inGmail.filter(m => /openai|chatgpt/i.test(`${m.de} ${m.sujet}`))
console.log(`--- Contrôle reçu OpenAI (depuis ${since}) — ${new Date().toISOString()} ---`)
console.log(`Dans l'ERP : ${inErp.length}`)
for (const r of inErp) console.log(`  ${r.created_at.slice(0, 16)} | ${r.total} ${r.currency || ''} | ${r.status} | ${r.original_name}`)
console.log(`Courriels de facturation OpenAI : ${openaiMail.length}`)
for (const m of openaiMail) console.log(`  [${m.boite}] ${m.date.slice(0, 22)} | à=${m.a} | ${m.sujet}`)

// 3. Verdict → notification in-app.
let title, body
if (inErp.length) {
  title = `Reçu OpenAI arrivé dans l'ERP (${inErp.length})`
  body = inErp.map(r => `${r.original_name} — ${r.total} ${r.currency || ''} (${r.status})`).join(' · ')
} else if (openaiMail.length) {
  title = 'Courriel OpenAI reçu, mais aucun reçu créé'
  body = `${openaiMail.length} courriel(s) de facturation OpenAI dans les boîtes connectées sans reçu correspondant. `
    + `Adressé à : ${[...new Set(openaiMail.map(m => m.a))].join(', ')}. À vérifier dans /comptabilite.`
} else {
  title = 'Toujours aucun reçu OpenAI'
  body = `Rien depuis ${since} : ni courriel de facturation dans les boîtes connectées, ni reçu dans l'ERP. `
    + `L'adresse de facturation du compte ChatGPT est probablement encore achat@orisha.io plutôt que factures@orisha.io.`
}
console.log(`\n→ ${title}\n  ${body}`)

const recipient = db.prepare(`SELECT id FROM users WHERE email='pap@orisha.io'`).get()
if (recipient) {
  createNotification({ userId: recipient.id, type: 'system', title, body, link: '/comptabilite' })
  console.log('Notification in-app déposée.')
} else {
  console.warn('Aucun destinataire (pap@orisha.io introuvable) — notification non déposée.')
}
process.exit(0)
