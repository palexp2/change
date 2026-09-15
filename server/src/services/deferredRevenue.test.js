// Revenus perçus d'avance : étalement de la période de service et état d'un mois.
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initTestDb, db } from '../test-helpers/testApp.js'
import { up as createDeferredRevenueTables } from '../db/migrations/067-deferred-revenue-recognition.js'
import { spreadOverMonths, serviceWindow, buildMonth } from './deferredRevenue.js'

describe('spreadOverMonths', () => {
  it('répartit au prorata des jours, résidu au dernier mois', () => {
    // 31 jours à cheval : 10 jours en août (22 août → 1er sept), 21 en septembre.
    const out = spreadOverMonths('2026-08-22T00:00:00Z', '2026-09-22T00:00:00Z', 310)
    assert.deepEqual(out.map(o => o.month), ['2026-08', '2026-09'])
    assert.equal(out[0].amount, 100)
    assert.equal(out[1].amount, 210)
    assert.equal(out[0].amount + out[1].amount, 310)
  })

  it('un mois entier reste sur un seul mois', () => {
    const out = spreadOverMonths('2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 100)
    assert.deepEqual(out, [{ month: '2026-08', amount: 100 }])
  })

  it('période vide ou montant nul ne produit rien', () => {
    assert.deepEqual(spreadOverMonths('2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', 100), [])
    assert.deepEqual(spreadOverMonths('2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 0), [])
  })
})

describe('serviceWindow', () => {
  it('prend l’enveloppe des lignes Stripe qui durent vraiment', () => {
    const w = serviceWindow({}, [
      { amount: 4000, period_start: '2026-08-22T18:00:00.000Z', period_end: '2026-09-22T18:00:00.000Z' },
      // Artefact Stripe : une ligne dont la « période » dure une minute.
      { amount: 500, period_start: '2026-08-22T18:00:00.000Z', period_end: '2026-08-22T18:01:00.000Z' },
    ])
    assert.equal(w.source, 'stripe')
    assert.equal(w.start, '2026-08-22T18:00:00.000Z')
    assert.equal(w.end, '2026-09-22T18:00:00.000Z')
  })

  it('sans ligne Stripe, lit la période imprimée dans les notes', () => {
    const w = serviceWindow({ notes: 'Abonnement du 1 septembre 2026 au 30 novembre 2026', document_date: '2026-09-01' }, [])
    assert.equal(w.source, 'notes')
    assert.equal(w.start.slice(0, 10), '2026-09-01')
    assert.equal(w.end.slice(0, 10), '2026-12-01') // borne exclusive
  })

  it('rien de lisible → aucune fenêtre', () => {
    assert.equal(serviceWindow({ notes: 'Merci de votre confiance' }, []), null)
  })
})

describe('buildMonth', () => {
  before(() => {
    initTestDb()
    createDeferredRevenueTables(db)
  })

  beforeEach(() => {
    db.exec('DELETE FROM stripe_invoice_items')
    db.exec("DELETE FROM factures WHERE id LIKE 'dr-%'")
    db.exec('DELETE FROM deferred_revenue_recognitions')
    db.exec('DELETE FROM deferred_revenue_drafts')
  })

  // Abonnement CAD de 310 $ HT encaissé le 22 août 19 h pour le 22 août → 22 sept :
  // 217,92 $ (21,79 jours sur 31) appartiennent à septembre, donc reportés.
  function seedSubscription({ id = 'dr-1', paid = '2026-08-22T19:37:32.000Z' } = {}) {
    db.prepare(`
      INSERT INTO factures (id, document_number, kind, currency, amount_before_tax_cad, total_amount,
                            paid_at, paid_amount, invoice_id, customer_email, status)
      VALUES (?,?, 'subscription', 'CAD', 310, 310, ?, 310, 'in_test', 'client@example.com', 'Payé')
    `).run(id, `TEST-${id}`, paid)
    db.prepare(`
      INSERT INTO stripe_invoice_items (id, facture_id, stripe_invoice_id, stripe_line_id, amount, currency, period_start, period_end)
      VALUES (?,?,'in_test','il_test',31000,'CAD','2026-08-22T19:00:00.000Z','2026-09-22T19:00:00.000Z')
    `).run(`item-${id}`, id)
  }

  it('reporte la portion du mois suivant et la constate au bon mois', async () => {
    seedSubscription()
    const aout = await buildMonth('2026-08')
    const ligneAout = aout.rows.find(r => r.facture_id === 'dr-1')
    assert.equal(ligneAout.deferred_cad, 217.92)
    assert.equal(ligneAout.to_recognize_cad, 0)      // rien à constater le mois de l'encaissement
    assert.equal(ligneAout.remaining_cad, 217.92)

    const sept = await buildMonth('2026-09')
    const ligneSept = sept.rows.find(r => r.facture_id === 'dr-1')
    assert.equal(ligneSept.to_recognize_cad, 217.92)
    assert.equal(ligneSept.remaining_cad, 0)
    assert.equal(ligneSept.deferral_acctnum, '23900')
    assert.equal(ligneSept.revenue_acctnum, '41000')
    assert.equal(sept.totals.to_recognize, 217.92)
  })

  it('une ligne déjà constatée n’est plus proposée', async () => {
    seedSubscription()
    db.prepare(`
      INSERT INTO deferred_revenue_recognitions (id, facture_id, month, amount_cad, currency, qb_je_id)
      VALUES ('rec-1','dr-1','2026-09',217.92,'CAD','9001')
    `).run()
    const sept = await buildMonth('2026-09')
    const ligne = sept.rows.find(r => r.facture_id === 'dr-1')
    assert.equal(ligne.recognized, true)
    assert.equal(ligne.qb_je_id, '9001')
    assert.equal(sept.totals.to_recognize, 0)
    assert.equal(sept.totals.already_recognized, 217.92)
    assert.equal(sept.totals.pending_count, 0)
  })

  it('une facture consommée dans son mois d’encaissement ne s’affiche pas', async () => {
    db.prepare(`
      INSERT INTO factures (id, document_number, kind, currency, amount_before_tax_cad, total_amount,
                            paid_at, paid_amount, invoice_id, status)
      VALUES ('dr-2','TEST-2','order','CAD',45,45,'2026-08-03T12:00:00.000Z',45,'in_test2','Payé')
    `).run()
    db.prepare(`
      INSERT INTO stripe_invoice_items (id, facture_id, stripe_invoice_id, stripe_line_id, amount, currency, period_start, period_end)
      VALUES ('item-dr-2','dr-2','in_test2','il_test2',4500,'CAD','2026-08-03T12:00:00.000Z','2026-08-20T12:00:00.000Z')
    `).run()
    const aout = await buildMonth('2026-08')
    assert.equal(aout.rows.find(r => r.facture_id === 'dr-2'), undefined)
  })
})
