// Facture de douane d'un retour, générée depuis la fiche : 400 au Canada,
// PDF dans uploads/customs hors Canada. Uploads et DB jetables.
import '../test-helpers/testEnv.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-uploads-'))
process.env.UPLOADS_PATH = UPLOADS
const { apiFetch, buildTestApp, closeServer, createTestUser, db, initTestDb, listen } = await import('../test-helpers/testApp.js')
// retours.js prépare ses requêtes au chargement : schéma d'abord.
initTestDb()
const { default: retoursRouter } = await import('./retours.js')

test('facture de douane : 404 / 400 au Canada / PDF hors Canada', async t => {
  initTestDb()
  // Colonnes nées de champs personnalisés en prod, absentes d'un schéma vierge.
  for (const ddl of ['ALTER TABLE returns ADD COLUMN deleted_at TEXT', 'ALTER TABLE tickets ADD COLUMN numero_de_l_issue_github TEXT',
    'ALTER TABLE tickets ADD COLUMN lien_issue_github TEXT', 'ALTER TABLE return_items ADD COLUMN billets TEXT']) { try { db.exec(ddl) } catch { /* déjà là */ } }
  db.prepare("INSERT INTO companies (id, name) VALUES ('co-ca', 'Ferme QC'), ('co-us', 'Bruce Glen Farm')").run()
  db.prepare(`INSERT INTO adresses (id, company_id, line1, city, province, postal_code, country) VALUES
    ('ad-ca', 'co-ca', '1 rang', 'Québec', 'QC', 'G1A1A1', 'Canada'),
    ('ad-us', 'co-us', '12 Farm Rd', 'Albany', 'NY', '12207', 'United States')`).run()
  db.prepare("INSERT INTO returns (id, return_address_id) VALUES ('r-ca', 'ad-ca'), ('r-us', 'ad-us')").run()
  db.prepare("INSERT INTO return_items (id, return_id, company_id) VALUES ('ri-ca', 'r-ca', 'co-ca'), ('ri-us', 'r-us', 'co-us')").run()

  const { token } = createTestUser()
  const { server, base } = await listen(buildTestApp({ '/api/retours': retoursRouter }))
  t.after(() => { closeServer(server); fs.rmSync(UPLOADS, { recursive: true, force: true }) })

  assert.equal((await apiFetch(base, token, 'POST', '/api/retours/zzz/customs-invoice')).status, 404)

  const ca = await apiFetch(base, token, 'POST', '/api/retours/r-ca/customs-invoice')
  assert.equal(ca.status, 400)
  const ctxCa = await apiFetch(base, token, 'GET', '/api/retours/r-ca/return-context')
  assert.equal(ctxCa.body.customs_invoice, false)

  const before = await apiFetch(base, token, 'GET', '/api/retours/r-us/return-context')
  assert.equal(before.body.customs_invoice, true)
  assert.equal(before.body.customs_invoice_url, null)

  const us = await apiFetch(base, token, 'POST', '/api/retours/r-us/customs-invoice')
  assert.equal(us.status, 200)
  assert.equal(us.body.url, '/erp/api/retours/customs/customs-invoice-r-us.pdf')
  const pdf = fs.readFileSync(path.join(UPLOADS, 'customs', 'customs-invoice-r-us.pdf'))
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF')

  const after = await apiFetch(base, token, 'GET', '/api/retours/r-us/return-context')
  assert.equal(after.body.customs_invoice_url, us.body.url)
})
