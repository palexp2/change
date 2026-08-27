/**
 * Prépare une boîte Gmail pour l'ingestion de factures AVANT sa connexion OAuth.
 *
 * Sans ça il faut connecter le compte deux fois : les cases de la page
 * Connecteurs ne s'affichent que pour un compte déjà connecté, or le scope
 * gmail.modify (corbeille après import) n'est demandé au consentement que si la
 * boîte figure déjà dans la liste. On sème donc la config d'abord, le compte se
 * connecte ensuite avec le bon consentement du premier coup.
 *
 * Idempotent — relancer ne duplique rien.
 *
 * Usage :
 *   node src/scripts/enable-invoice-mailbox.js <email> [--senders=a.com,b.com] \
 *        [--no-autodetect] [--no-trash] [--no-invoice-only]
 *
 * Exemple :
 *   node src/scripts/enable-invoice-mailbox.js perso@gmail.com --senders=anthropic.com
 */
import db from '../db/database.js'
import { INVOICE_TRASH_KEY, INVOICE_ONLY_KEY, mailboxList } from '../connectors/google.js'

const AUTODETECT_KEY = 'invoice_autodetect_mailboxes'
const SENDERS_KEY = 'invoice_autodetect_senders'

const args = process.argv.slice(2)
const email = (args.find(a => !a.startsWith('--')) || '').toLowerCase().trim()
if (!email || !email.includes('@')) {
  console.error('Usage: node src/scripts/enable-invoice-mailbox.js <email> [--senders=domaine.com,...]')
  process.exit(1)
}
const has = flag => args.includes(flag)
const sendersArg = args.find(a => a.startsWith('--senders='))
const senders = sendersArg
  ? sendersArg.slice('--senders='.length).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : []

const put = db.prepare(`
  INSERT INTO connector_config (connector, key, value) VALUES ('google', ?, ?)
  ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
`)

function addToList(key, enabled) {
  const list = mailboxList(key)
  const present = list.includes(email)
  if (enabled === present) return `${key}: inchangé (${present ? 'déjà présent' : 'absent'})`
  const next = enabled ? [...list, email] : list.filter(e => e !== email)
  put.run(key, JSON.stringify(next))
  return `${key}: ${enabled ? 'ajouté' : 'retiré'}`
}

console.log(addToList(AUTODETECT_KEY, !has('--no-autodetect')))
console.log(addToList(INVOICE_TRASH_KEY, !has('--no-trash')))
console.log(addToList(INVOICE_ONLY_KEY, !has('--no-invoice-only')))

if (senders.length) {
  const row = db.prepare(`SELECT value FROM connector_config WHERE connector='google' AND key=?`).get(SENDERS_KEY)
  let map = {}
  try { map = JSON.parse(row?.value || '{}') } catch { map = {} }
  if (!map || typeof map !== 'object' || Array.isArray(map)) map = {}
  map[email] = senders
  put.run(SENDERS_KEY, JSON.stringify(map))
  console.log(`${SENDERS_KEY}: ${email} → ${senders.join(', ')}`)
}

console.log(`\n✅ ${email} est prêt. Connectez-le maintenant depuis la page Connecteurs.`)
