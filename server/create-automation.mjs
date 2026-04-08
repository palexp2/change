/**
 * One-time script: creates the "Rappel abonnement en retard" automation.
 * Run: node create-automation.mjs
 * Delete this file after use.
 */
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.cwd(), process.env.DATABASE_PATH)
  : path.join(__dirname, '../data/erp.db')

const db = new Database(dbPath)

// Get first tenant
const tenant = db.prepare('SELECT id, name FROM tenants LIMIT 1').get()
if (!tenant) {
  console.error('Aucun tenant trouvé.')
  process.exit(1)
}
console.log(`Tenant: ${tenant.name} (${tenant.id})`)

// Check if automation already exists
const existing = db.prepare(
  "SELECT id FROM automations WHERE tenant_id = ? AND name = ? AND deleted_at IS NULL"
).get(tenant.id, 'Rappel abonnement en retard')

if (existing) {
  console.log(`Automation déjà existante: ${existing.id}`)
  process.exit(0)
}

const id = 'auto_' + randomBytes(8).toString('hex')

const script = `
// Rappel automatique — abonnements en retard
// Envoi chaque lundi et vendredi à 10h

const subscriptions = query(
  \`SELECT s.id, s.company_id, s.status, s.amount_monthly, s.currency,
          c.name as company_name
   FROM subscriptions s
   LEFT JOIN companies c ON s.company_id = c.id
   WHERE s.tenant_id = ? AND s.status = 'past_due'\`,
  [tenantId]
)

log('Abonnements en retard: ' + subscriptions.length)

for (const sub of subscriptions) {
  if (!sub.company_id) {
    log('Abonnement sans compagnie, ignoré: ' + sub.id)
    continue
  }

  const contacts = query(
    \`SELECT * FROM contacts
     WHERE company_id = ? AND tenant_id = ?
       AND email IS NOT NULL AND email != ''\`,
    [sub.company_id, tenantId]
  )

  if (contacts.length === 0) {
    log('Aucun contact avec courriel pour: ' + (sub.company_name || sub.company_id))
    continue
  }

  for (const contact of contacts) {
    const lang = contact.language || 'French'
    const firstName = contact.first_name || ''
    const companyName = sub.company_name || ''
    const amount = sub.amount_monthly ? sub.amount_monthly.toFixed(2) + ' ' + (sub.currency || 'CAD') : ''

    let subject, body

    if (lang === 'English') {
      subject = 'Reminder: Overdue Subscription Payment'
      body = \`<p>Hello \${firstName},</p>
<p>We noticed that your subscription\${companyName ? ' for <strong>' + companyName + '</strong>' : ''} is <strong>past due</strong>.\${amount ? ' The outstanding amount is <strong>' + amount + '/month</strong>.' : ''}</p>
<p>Please make your payment as soon as possible to avoid any interruption of service.</p>
<p>If you have any questions or need assistance, please don't hesitate to contact us.</p>
<p>Best regards,<br>The Orisha Team</p>\`
    } else {
      subject = 'Rappel : Paiement d\\'abonnement en retard'
      body = \`<p>Bonjour \${firstName},</p>
<p>Nous avons constaté que votre abonnement\${companyName ? ' pour <strong>' + companyName + '</strong>' : ''} est <strong>en retard de paiement</strong>.\${amount ? ' Le montant dû est de <strong>' + amount + '/mois</strong>.' : ''}</p>
<p>Veuillez effectuer votre paiement dans les meilleurs délais afin d\\'éviter toute interruption de service.</p>
<p>Si vous avez des questions ou avez besoin d\\'aide, n\\'hésitez pas à nous contacter.</p>
<p>Cordialement,<br>L\\'équipe Orisha</p>\`
    }

    await sendEmail(contact.email, subject, body)
  }
}

log('Rappels terminés.')
`.trim()

const triggerConfig = JSON.stringify({ cron: '0 10 * * 1,5' })

db.prepare(`
  INSERT INTO automations (id, tenant_id, name, description, trigger_type, trigger_config, action_type, action_config, script, active)
  VALUES (?, ?, ?, ?, 'schedule', ?, 'script', '{}', ?, 1)
`).run(
  id,
  tenant.id,
  'Rappel abonnement en retard',
  'Envoie un rappel par courriel (dans la langue du client) à tous les contacts des compagnies dont l\'abonnement est en retard (past_due). Roule chaque lundi et vendredi à 10h.',
  triggerConfig,
  script
)

console.log(`Automation créée avec succès: ${id}`)
console.log('Cron: 0 10 * * 1,5 (lundi et vendredi à 10h)')
db.close()
