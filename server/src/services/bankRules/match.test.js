// Le comparateur des règles bancaires — pur, aucune base.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchBankRule, ruleSpecificity, labelMatches, dayOfMonthDistance } from './match.js'

const txn = (o = {}) => ({
  account_id: 'acct-bnc', txn_date: '2026-09-04', amount: -1450,
  description: 'PMTS ENTREPRISES', details: 'NOVO EXPRESS INC MONTREAL QC', ...o,
})

describe('labelMatches', () => {
  it('attrape le libellé par jetons, pas en LIKE', () => {
    assert.equal(labelMatches('PMTS ENTREPRISES NOVO EXPRESS INC', 'novo express'), true)
    assert.equal(labelMatches('NOVO-EXPRESS', 'Novo Express'), true)
  })

  it('un motif vide ne matche rien — jamais tout', () => {
    assert.equal(labelMatches('N\'IMPORTE QUOI', ''), false)
    assert.equal(labelMatches('', 'novo'), false)
  })
})

describe('dayOfMonthDistance', () => {
  it('le 1er est à un jour du 31', () => {
    assert.equal(dayOfMonthDistance('2026-09-01', 31), 1)
    assert.equal(dayOfMonthDistance('2026-09-04', 4), 0)
    assert.equal(dayOfMonthDistance('2026-09-07', 4), 3)
  })
})

describe('ruleSpecificity', () => {
  it('une règle sans condition ne s\'applique à rien', () => {
    assert.equal(ruleSpecificity({ direction: 'tous' }, txn()), 0)
  })

  it('compte les conditions satisfaites', () => {
    const r = { label_pattern: 'novo express', direction: 'sortie', amount_min: 1000, amount_max: 2000 }
    assert.equal(ruleSpecificity(r, txn()), 4)
  })

  it('le sens exclut', () => {
    assert.equal(ruleSpecificity({ label_pattern: 'novo', direction: 'entree' }, txn()), 0)
  })

  it('la fourchette de montant exclut', () => {
    assert.equal(ruleSpecificity({ label_pattern: 'novo', amount_min: 2000 }, txn()), 0)
    assert.equal(ruleSpecificity({ label_pattern: 'novo', amount_max: 1000 }, txn()), 0)
  })

  it('le compte exclut', () => {
    assert.equal(ruleSpecificity({ label_pattern: 'novo', account_id: 'autre' }, txn()), 0)
  })

  it('le jour du mois tolère l\'écart déclaré', () => {
    const r = { label_pattern: 'novo', day_of_month: 1, tolerance_days: 3 }
    assert.ok(ruleSpecificity(r, txn({ txn_date: '2026-09-04' })) > 0)
    assert.equal(ruleSpecificity(r, txn({ txn_date: '2026-09-09' })), 0)
  })

  it('une règle désactivée ne s\'applique jamais', () => {
    assert.equal(ruleSpecificity({ label_pattern: 'novo', active: 0 }, txn()), 0)
  })
})

describe('matchBankRule', () => {
  it('la priorité la plus basse gagne, comme dans QuickBooks', () => {
    const rules = [
      { id: 'a', label_pattern: 'novo', priority: 100 },
      { id: 'b', label_pattern: 'novo express', priority: 10 },
    ]
    assert.equal(matchBankRule(txn(), rules).id, 'b')
  })

  it('à priorité égale, la plus précise gagne', () => {
    const rules = [
      { id: 'a', label_pattern: 'novo', priority: 50 },
      { id: 'b', label_pattern: 'novo', priority: 50, amount_min: 1000, amount_max: 2000 },
    ]
    assert.equal(matchBankRule(txn(), rules).id, 'b')
  })

  it('aucune règle applicable ⇒ rien', () => {
    assert.equal(matchBankRule(txn(), [{ id: 'a', label_pattern: 'hydro' }]), null)
    assert.equal(matchBankRule(txn(), []), null)
  })

  it('compare sur « Autres détails » quand la description est générique', () => {
    const rules = [{ id: 'a', label_pattern: 'novo express' }]
    assert.equal(matchBankRule(txn({ description: 'PMTS ENTREPRISES' }), rules).id, 'a')
  })
})

describe('conditions détaillées (le format QuickBooks)', () => {
  const withCond = (mode, terms) => ({ conditions: JSON.stringify({ mode, terms }) })

  it('un OU suffit à une seule condition satisfaite', () => {
    const r = withCond('any', [
      { field: 'label', op: 'contains', value: 'FRAIS FORFAIT' },
      { field: 'label', op: 'contains', value: 'PACKAGE FEE' },
    ])
    assert.ok(ruleSpecificity(r, txn({ details: 'PACKAGE FEE MENSUEL' })) > 0)
    assert.equal(ruleSpecificity(r, txn({ details: 'AUTRE CHOSE' })), 0)
  })

  it('un ET les exige toutes', () => {
    const r = withCond('all', [
      { field: 'label', op: 'contains', value: 'MISCELLANEOUS ACC.' },
      { field: 'amount', op: 'lt', value: -1000 },
    ])
    assert.ok(ruleSpecificity(r, txn({ details: 'MISCELLANEOUS ACC.', amount: -4200 })) > 0)
    assert.equal(ruleSpecificity(r, txn({ details: 'MISCELLANEOUS ACC.', amount: -250 })), 0)
  })

  it('les seuils sont signés — un débit plus gros est un montant plus petit', () => {
    const salaires = withCond('all', [{ field: 'label', op: 'contains', value: 'MISCELLANEOUS ACC.' }, { field: 'amount', op: 'lt', value: -1000 }])
    const nethris = withCond('all', [{ field: 'label', op: 'contains', value: 'MISCELLANEOUS ACC.' }, { field: 'amount', op: 'gt', value: -300 }])
    const gros = txn({ details: 'MISCELLANEOUS ACC.', amount: -4200 })
    const petit = txn({ details: 'MISCELLANEOUS ACC.', amount: -180 })
    assert.ok(ruleSpecificity(salaires, gros) > 0 && ruleSpecificity(salaires, petit) === 0)
    assert.ok(ruleSpecificity(nethris, petit) > 0 && ruleSpecificity(nethris, gros) === 0)
  })

  it('la liste détaillée fait autorité sur le motif résumé', () => {
    const r = { label_pattern: 'ceci ne matche rien', ...withCond('any', [{ field: 'label', op: 'contains', value: 'novo express' }]) }
    assert.ok(ruleSpecificity(r, txn()) > 0)
  })
})
