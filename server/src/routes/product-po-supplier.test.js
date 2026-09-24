import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTestApp, listen, createTestUser, db, apiFetch, closeServer,
} from '../test-helpers/testApp.js'
import productsRouter from './products.js'

describe('PO — pièces avec fournisseur texte', () => {
  let server, base, token

  before(async () => {
    const app = buildTestApp({ '/api/products': productsRouter })
    ;({ server, base } = await listen(app))
    token = createTestUser().token
    // Colonnes du catalogue miroir et de suppression présentes en production,
    // mais ajoutées hors initSchema dans la base vierge du harnais.
    db.exec(`
      ALTER TABLE products ADD COLUMN manufacturier TEXT;
      ALTER TABLE products ADD COLUMN deleted_at TEXT;
      ALTER TABLE contacts ADD COLUMN deleted_at TEXT;
    `)
    db.prepare('INSERT INTO companies (id, name, currency, language) VALUES (?, ?, ?, ?)')
      .run('takachi-usd', 'Takachi USD', 'USD', 'English')
    db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run('other-vendor', 'Autre fournisseur')
    const insert = db.prepare(`INSERT INTO products
      (id, name_fr, supplier, supplier_company_id, buy_via_po, order_qty, unit_cost, deleted_at)
      VALUES (?, ?, ?, ?, 1, ?, 2.5, ?)`)
    insert.run('linked-box', 'BCPC131508-S', 'Takachi', 'takachi-usd', 0, null)
    insert.run('legacy-box', 'WP13-18-5G - network plastic box', ' Takachi ', null, 0, null)
    insert.run('legacy-needed', 'Pièce à commander', 'TAKACHI', null, 3, null)
    insert.run('linked-peer', 'Même entreprise', 'Ancien nom', 'takachi-usd', 0, null)
    insert.run('different-link', 'Autre entreprise', 'Takachi', 'other-vendor', 4, null)
    insert.run('different-text', 'Autre fournisseur texte', 'Takachi Europe', null, 4, null)
    insert.run('deleted', 'Pièce supprimée', 'Takachi', null, 4, '2026-09-01')
    insert.run('no-supplier', 'Sans fournisseur', null, null, 0, null)
    insert.run('blank-supplier', 'Fournisseur vide', ' ', null, 4, null)
    db.prepare('INSERT INTO companies (id, name, language) VALUES (?, ?, ?)').run('bilingue', 'Bilingue', 'French')
    const contact = db.prepare('INSERT INTO contacts (id, first_name, last_name, email, company_id, language) VALUES (?, ?, ?, ?, ?, ?)')
    contact.run('ct-en', 'Ann', 'Smith', 'ann@x.com', 'bilingue', 'English')
    contact.run('ct-fr', 'Luc', 'Roy', 'luc@x.com', 'other-vendor', 'French')
    db.prepare('INSERT INTO contact_companies (id, contact_id, company_id, is_primary) VALUES (?, ?, ?, 0)')
      .run('cc-fr', 'ct-fr', 'bilingue')
    insert.run('bilingue-part', 'Pièce bilingue', null, 'bilingue', 0, null)
  })

  after(async () => { await closeServer(server) })

  async function prefill(id) {
    const result = await apiFetch(base, token, 'GET', `/api/products/${id}/purchase-order/prefill`)
    assert.equal(result.status, 200)
    return result.body
  }

  test('le PO lié propose WP13-18-5G même sans quantité à commander', async () => {
    const po = await prefill('linked-box')
    assert.equal(po.supplier, 'Takachi USD')
    assert.equal(po.currency, 'USD')
    assert.equal(po.lang, 'en')
    assert.deepEqual(po.supplier_products.map(p => p.id).sort(),
      ['legacy-box', 'legacy-needed', 'linked-box', 'linked-peer'])
    assert.equal(po.supplier_products.find(p => p.id === 'legacy-box').label, 'WP13-18-5G - network plastic box')
    assert.deepEqual(po.items.map(p => p.product_id), ['linked-box', 'legacy-needed'])
    assert.equal(po.items[1].qty, 3)
    assert.equal(po.items[1].rate, 0)
  })

  test('une pièce sans entreprise liée peut générer son PO avec son fournisseur texte', async () => {
    const po = await prefill('legacy-box')
    assert.equal(po.supplier.trim(), 'Takachi')
    assert.equal(po.items[0].product_id, 'legacy-box')
    assert.deepEqual(po.supplier_products.map(p => p.id).sort(), ['legacy-box', 'legacy-needed'])
    assert.equal(po.supplier_contacts.length, 0)
  })

  test('ne regroupe pas les pièces sans fournisseur ou avec un nom vide', async () => {
    for (const id of ['no-supplier', 'blank-supplier']) {
      const po = await prefill(id)
      assert.deepEqual(po.supplier_products, [])
      assert.deepEqual(po.items.map(p => p.product_id), [id])
    }
  })

  test('propose les contacts liés et suit la langue du destinataire', async () => {
    const po = await prefill('bilingue-part')
    assert.deepEqual(po.supplier_contacts.map(c => [c.email, c.lang]),
      [['ann@x.com', 'en'], ['luc@x.com', 'fr']])
    assert.equal(po.supplier_email, 'ann@x.com')
    assert.equal(po.lang, 'en')
  })
})
