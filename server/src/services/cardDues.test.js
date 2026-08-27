import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { dueDateFor, shiftIso, CARDS, DUE_DAY, LEAD_DAYS } from './cardDues.js'

// Le harnais de tests serveur exige un describe() englobant et interdit tout
// db.prepare au niveau module (cf. CLAUDE.md / harnais). Les fonctions testées
// ici sont pures : la génération elle-même est vérifiée bout en bout sur la page.
describe('cartes de crédit à payer', () => {
  test('dueDateFor donne le 25 du mois de la date fournie', () => {
    assert.equal(dueDateFor('2026-08-22'), '2026-08-25')
    assert.equal(dueDateFor('2026-08-31'), '2026-08-25')
    assert.equal(dueDateFor('2026-01-02'), '2026-01-25')
  })

  test('dueDateFor borne à la fin du mois court', () => {
    // Février n'a pas de 30 : un due_day de 30 doit retomber sur le 28/29.
    assert.equal(dueDateFor('2026-02-10', 30), '2026-02-28')
    assert.equal(dueDateFor('2024-02-10', 30), '2024-02-29')
  })

  test('la date d’apparition est bien une semaine avant l’échéance', () => {
    assert.equal(shiftIso(dueDateFor('2026-08-22'), -LEAD_DAYS), '2026-08-18')
    // Le décalage traverse proprement un changement de mois et d'heure d'été.
    assert.equal(shiftIso('2026-11-02', -7), '2026-10-26')
    assert.equal(shiftIso('2026-03-05', -7), '2026-02-26')
  })

  test('les deux cartes sont déclarées avec leur compte payeur et leur devise', () => {
    assert.equal(CARDS.length, 2)
    const cad = CARDS.find(c => c.currency === 'CAD')
    const usd = CARDS.find(c => c.currency === 'USD')
    // Libellés repris de l'historique : l'appariement au relevé les reconnaît.
    assert.equal(cad.label, 'Visa CAD')
    assert.equal(cad.pay_account, 'BNC CAD')
    assert.equal(cad.card_account, 'VISA Desjardins CAD')
    assert.equal(usd.label, 'Visa USD')
    assert.equal(usd.pay_account, 'BNC USD')
    assert.equal(usd.card_account, 'VISA Desjardins USD')
  })

  test('l’échéance par défaut est le 25', () => {
    assert.equal(DUE_DAY, 25)
    assert.equal(LEAD_DAYS, 7)
  })
})
