// Le moteur : l'ordre des étapes, le plafond, et le seuil qui autorise une
// proposition dont l'acceptation publie dans QuickBooks.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeRun, ENGINE_KINDS } from './engine.js'
import { isSolidEnoughToPublish } from './producers.js'

describe('ordre des producteurs', () => {
  it('la pièce d\'abord, la dépense devinée en dernier', () => {
    assert.equal(ENGINE_KINDS[0], 'doc_match')
    assert.equal(ENGINE_KINDS[ENGINE_KINDS.length - 1], 'vendor_expense')
    // Le lien QuickBooks ne fait pas partie du moteur : il appartient à la sync,
    // seule à disposer du grand livre.
    assert.ok(!ENGINE_KINDS.includes('qb_link'))
  })
})

describe('isSolidEnoughToPublish', () => {
  const hist = (n, count) => ({ count, expense_accounts: [{ value: '70', n }] })

  it('une valeur déclarée suffit', () => {
    assert.equal(isSolidEnoughToPublish({ value: '70', source: 'profil du fournisseur' }, null), true)
    assert.equal(isSolidEnoughToPublish({ value: '70', source: 'règle « Transport »' }, null), true)
    assert.equal(isSolidEnoughToPublish({ value: '70', source: 'facture 8821' }, null), true)
  })

  it('une habitude franche suffit', () => {
    assert.equal(isSolidEnoughToPublish({ value: '70', source: 'habitude : 7 fois sur 8' }, hist(7, 8)), true)
  })

  it('une habitude minoritaire ne suffit pas', () => {
    assert.equal(isSolidEnoughToPublish({ value: '70', source: 'habitude : 2 fois sur 4' }, hist(2, 4)), false)
  })

  it('une habitude trop courte ne suffit pas, même unanime', () => {
    assert.equal(isSolidEnoughToPublish({ value: '70', source: 'habitude (2 fois sur 2)' }, hist(2, 2)), false)
  })

  it('un champ vide ne suffit jamais', () => {
    assert.equal(isSolidEnoughToPublish({ value: null, source: null }, hist(9, 9)), false)
  })
})

describe('summarizeRun', () => {
  it('dit ce qu\'il y a à confirmer, par nature', () => {
    const s = summarizeRun({ produced: 5, inserted: 5, dryRun: false, byKind: { doc_match: { produced: 3 }, vendor_expense: { produced: 2 } } })
    assert.match(s, /5 à confirmer/)
    assert.match(s, /3 pièces retrouvées/)
    assert.match(s, /2 dépenses prêtes/)
  })

  it('se tait quand il n\'y a rien', () => {
    assert.equal(summarizeRun({ produced: 0, inserted: 0, byKind: {} }), 'Rien de nouveau à confirmer')
  })
})
