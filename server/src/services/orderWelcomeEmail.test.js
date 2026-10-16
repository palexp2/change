import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { welcomeEmailPlan, buildWelcomeEmail, selectDueWelcomeEmails } from './orderWelcomeEmail.js'

const ctrl = { name: 'Contrôleur central US ETH 5GHz', product_type: 'Orisha - Core', cf_type_de_document: 'Installation' }
const lte = { name: 'Contrôleur central US ETH 5GHz LTECAN', product_type: 'Orisha - Extra', cf_type_de_document: 'Installation' }
const meteo = { name: 'Boîtier météo', product_type: 'Orisha - Core', cf_type_de_document: 'Installation' }
const cote = { name: 'Module de côtés ouvrants', product_type: 'Orisha - Core', cf_type_de_document: 'Installation' }
const piece = { name: 'Antenne LoRa externe', product_type: 'Antennes', cf_type_de_document: 'Installation' }
const repl = it => ({ ...it, cf_type_de_document: 'Remplacement' })

test('Core en Installation → installation, contenu selon les articles', () => {
  assert.deepEqual(welcomeEmailPlan([cote]), { install: true, controller: false, lte: false, weather: false })
  assert.deepEqual(welcomeEmailPlan([ctrl, meteo]), { install: true, controller: true, lte: false, weather: true })
})

test('Contrôleur LTE (Extra) déclenche l’installation, avec la connexion mobile', () => {
  const p = welcomeEmailPlan([lte])
  assert.equal(p.install, true); assert.equal(p.lte, true)
  assert.match(buildWelcomeEmail({ items: [lte] }).html, /connexion internet mobile/)
})

test('Remplacements et pièces seules → vérification d’adresse seulement', () => {
  assert.equal(welcomeEmailPlan([repl(ctrl), repl(meteo), piece]).install, false)
  assert.equal(welcomeEmailPlan([{ ...ctrl, item_type: 'Remplacement', cf_type_de_document: null }]).install, false)
  assert.equal(welcomeEmailPlan([{ ...ctrl, item_type: 'Remplacement' }]).install, true)
  const e = buildWelcomeEmail({ lang: 'en', items: [piece], address: { name: 'Ferme', line1: '1 rue' } })
  assert.equal(e.subject, 'Your Orisha order: confirming the address')
  assert.doesNotMatch(e.html, /plywood/)
})

test('Aucun délai promis', () => {
  for (const lang of ['fr', 'en']) assert.doesNotMatch(buildWelcomeEmail({ lang, items: [ctrl, meteo] }).html, /semaine|week/i)
})

test('Envoi de 17 h : commandes récentes, non vides, pas encore écrites', () => {
  const m = new Database(':memory:')
  m.exec(`CREATE TABLE orders (id TEXT, address_id TEXT, status TEXT, created_at TEXT, deleted_at TEXT);
    CREATE TABLE order_welcome_emails (order_id TEXT)`)
  const add = (id, created_at, o = {}) => m.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?)')
    .run(id, o.address_id === undefined ? 'a' : o.address_id, o.status || 'En attente', created_at, o.deleted_at || null)
  add('ok', '2026-10-20T15:00:00Z')
  add('ancienne', '2026-10-01T15:00:00Z')
  add('vide', '2026-10-20T15:00:00Z', { status: 'Commande vide' })
  add('sans-adresse', '2026-10-20T15:00:00Z', { address_id: null })
  add('supprimee', '2026-10-20T15:00:00Z', { deleted_at: '2026-10-20' })
  add('deja', '2026-10-20T15:00:00Z')
  add('recente', '2026-10-25T15:00:00Z')
  m.prepare("INSERT INTO order_welcome_emails VALUES ('deja')").run()
  assert.deepEqual(selectDueWelcomeEmails(m, '2026-10-26T21:00:00Z'), ['ok', 'recente'])
  // Au-delà de 14 jours, une commande n'est plus rattrapée.
  assert.deepEqual(selectDueWelcomeEmails(m, '2026-11-04T21:00:00Z'), ['recente'])
})
