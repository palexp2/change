// Garde anti-boucle du write-back ERP → Airtable.
//
// Quand l'ERP pousse une modif vers Airtable (PATCH), Airtable renvoie un webhook
// d'« echo » de notre propre écriture. Sans garde, le sync entrant ré-applique
// cette valeur dans l'ERP → boucle infinie avec sys_airtable_webhook_router.
// recordWriteback() mémorise les champs poussés ; consumeWritebackEcho() reconnaît
// l'echo (mêmes valeurs, à usage unique, TTL borné) pour que le sync l'ignore.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-writeback-${process.pid}.db`)

const db = (await import('../db/database.js')).default
// schema.js n'est pas exécuté en test : on recrée les tables utilisées à l'identique.
db.exec(`CREATE TABLE IF NOT EXISTS airtable_writeback_guard (
  airtable_id TEXT PRIMARY KEY,
  fields_json TEXT NOT NULL,
  written_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)`)
db.exec(`CREATE TABLE IF NOT EXISTS airtable_field_directions (
  module TEXT NOT NULL,
  field_key TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'both',
  PRIMARY KEY (module, field_key)
)`)

const {
  recordWriteback, consumeWritebackEcho,
  setFieldDirection, dynamicFieldDirection, fieldMapDirection, writebackModuleForTable,
} = await import('./airtableWriteback.js')

test('echo reconnu : mêmes valeurs poussées puis reçues → ignoré par le sync', () => {
  recordWriteback('recEchoSame', { Statut: 'Reçu', 'Prix unitaire': 12.5 })
  assert.equal(consumeWritebackEcho('recEchoSame', { Statut: 'Reçu', 'Prix unitaire': 12.5 }), true)
})

test('garde à usage unique : un second webhook pour le même write n’est plus un echo', () => {
  recordWriteback('recOnce', { Notes: 'abc' })
  assert.equal(consumeWritebackEcho('recOnce', { Notes: 'abc' }), true)
  // Deuxième passage (ou vrai changement ultérieur) : plus de garde → le sync traite.
  assert.equal(consumeWritebackEcho('recOnce', { Notes: 'abc' }), false)
})

test('vrai changement Airtable après notre write → pas un echo, le sync l’applique', () => {
  recordWriteback('recChanged', { Statut: 'Commandé' })
  // Un humain a édité Airtable entre notre PATCH et le webhook : valeur différente.
  assert.equal(consumeWritebackEcho('recChanged', { Statut: 'Reçu' }), false)
})

test('typecast Airtable : nombre poussé revenant en chaîne reste un echo', () => {
  recordWriteback('recTypecast', { 'Qté commandée': 5 })
  assert.equal(consumeWritebackEcho('recTypecast', { 'Qté commandée': '5' }), true)
})

test('null poussé ⇄ champ absent/vide côté Airtable → echo (effacement répercuté)', () => {
  recordWriteback('recNull', { Notes: null })
  // Airtable omet les champs vides : le champ n'apparaît pas dans le webhook.
  assert.equal(consumeWritebackEcho('recNull', {}), true)
})

test('aucune garde enregistrée → jamais un echo', () => {
  assert.equal(consumeWritebackEcho('recUnknown', { Statut: 'Reçu' }), false)
})

test('garde périmée (TTL dépassé) → ignorée et nettoyée', () => {
  // written_at à 5 min ⇒ au-delà du GUARD_TTL_MS (2 min) : entrée périmée.
  db.prepare(`INSERT INTO airtable_writeback_guard (airtable_id, fields_json, written_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes'))`)
    .run('recStale', JSON.stringify({ Statut: 'Reçu' }))
  assert.equal(consumeWritebackEcho('recStale', { Statut: 'Reçu' }), false)
  // L'entrée périmée doit avoir été supprimée.
  const left = db.prepare('SELECT 1 FROM airtable_writeback_guard WHERE airtable_id=?').get('recStale')
  assert.equal(left, undefined)
})

test('echo partiel : un seul champ poussé qui matche, autres champs Airtable ignorés', () => {
  recordWriteback('recPartial', { Statut: 'Reçu' })
  // Le webhook contient d'autres champs (gelés/non poussés) — seul le champ poussé compte.
  assert.equal(consumeWritebackEcho('recPartial', { Statut: 'Reçu', 'Champ gelé': 'xyz' }), true)
})

// ── Sens de sync des champs dynamiques (clés `dyn:<colonne>`) ────────────────

test('champ dynamique : défaut pull (jamais poussé) sur un module write-back', () => {
  assert.equal(dynamicFieldDirection('achats', 'cf_commentaire'), 'pull')
})

test('champ dynamique : module sans write-back → toujours pull', () => {
  assert.equal(dynamicFieldDirection('pieces', 'cf_commentaire'), 'pull')
  assert.equal(dynamicFieldDirection(null, 'cf_commentaire'), 'pull')
})

test('setFieldDirection accepte une clé dyn: sur un module write-back et persiste', () => {
  setFieldDirection('achats', 'dyn:cf_commentaire', 'both')
  assert.equal(dynamicFieldDirection('achats', 'cf_commentaire'), 'both')
  setFieldDirection('achats', 'dyn:cf_commentaire', 'push')
  assert.equal(dynamicFieldDirection('achats', 'cf_commentaire'), 'push')
  // La clé cœur homonyme n'est pas affectée par l'override dyn:.
  assert.equal(fieldMapDirection('achats', 'cf_commentaire'), 'both')
})

test('setFieldDirection refuse une clé dyn: sur un module sans write-back', () => {
  assert.throws(() => setFieldDirection('pieces', 'dyn:cf_x', 'both'), /ne supporte pas/)
})

test('setFieldDirection refuse toujours une clé cœur non configurable (skipKeys)', () => {
  assert.throws(() => setFieldDirection('achats', 'product', 'both'), /ne supporte pas/)
})

test('writebackModuleForTable : table ERP → clé module write-back', () => {
  assert.equal(writebackModuleForTable('purchases'), 'achats')
  assert.equal(writebackModuleForTable('shipments'), 'envois')
  assert.equal(writebackModuleForTable('products'), null)
})
