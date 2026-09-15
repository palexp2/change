// Le lecteur du fichier de règles exporté de QuickBooks : colonnes tolérantes,
// non-résolus signalés plutôt qu'inventés.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { readQbRulesFile, mapRuleColumns, parseAmountRange, parseCondition, parseDirection } from './importQb.js'

const book = (grid) => {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), 'Règles')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

describe('mapRuleColumns', () => {
  it('reconnaît les entêtes françaises comme anglaises', () => {
    assert.deepEqual(mapRuleColumns(['Nom', 'Conditions', 'Catégorie', 'Fournisseur']),
      { name: 0, condition_text: 1, account_name: 2, vendor_name: 3 })
    assert.deepEqual(mapRuleColumns(['Rule name', 'Criteria', 'Account']),
      { name: 0, condition_text: 1, account_name: 2 })
  })
})

describe('parseCondition', () => {
  it('ne garde que la valeur, pas la formule', () => {
    assert.equal(parseCondition('La description contient NOVO EXPRESS'), 'NOVO EXPRESS')
    assert.equal(parseCondition('Description contains "Hydro-Québec"'), 'Hydro-Québec')
    assert.equal(parseCondition(''), null)
  })
})

describe('parseAmountRange', () => {
  it('lit une fourchette', () => {
    assert.deepEqual(parseAmountRange('entre 100 et 500'), { amount_min: 100, amount_max: 500 })
  })
  it('lit une borne', () => {
    assert.deepEqual(parseAmountRange('plus grand que 250,00'), { amount_min: 250, amount_max: null })
  })
  it('une égalité devient une fourchette d\'un cent', () => {
    assert.deepEqual(parseAmountRange('est égal à 149,00'), { amount_min: 148.99, amount_max: 149.01 })
  })
  it('rien ne conditionne rien', () => {
    assert.deepEqual(parseAmountRange(''), { amount_min: null, amount_max: null })
  })
})

describe('parseDirection', () => {
  it('reconnaît les entrées', () => {
    assert.equal(parseDirection('Revenu'), 'entree')
    assert.equal(parseDirection('Money in'), 'entree')
  })
  it('tout le reste est une sortie', () => {
    assert.equal(parseDirection('Dépense'), 'sortie')
    assert.equal(parseDirection(''), 'sortie')
  })
})

describe('readQbRulesFile', () => {
  const resolve = {
    account: (n) => (/transport/i.test(n) ? '5010' : null),
    taxCode: (n) => (/tps.*tvq/i.test(n) ? '4' : null),
    vendor: (n) => (/novo/i.test(n) ? { id: 'vp-1', name: 'Novo Express' } : null),
    bankAccount: () => null,
  }

  it('traduit une règle et signale ce qui ne se résout pas', () => {
    const buf = book([
      ['Règles bancaires — export QuickBooks'],
      [],
      ['Nom', 'Conditions', 'Montant', 'Argent', 'Catégorie', 'Fournisseur', 'Taxe'],
      ['Transport Novo', 'La description contient NOVO EXPRESS', 'entre 100 et 5000', 'Dépense', 'Transport', 'Novo Express', 'TPS/TVQ'],
      ['Loyer', 'La description contient INVERNESS', '', 'Dépense', 'Compte inexistant', 'Bailleur X', ''],
    ])
    const { rules, warnings } = readQbRulesFile(buf, resolve)
    assert.equal(warnings.length, 0)
    assert.equal(rules.length, 2)

    assert.deepEqual(rules[0].unresolved, [])
    assert.equal(rules[0].rule.label_pattern, 'NOVO EXPRESS')
    assert.equal(rules[0].rule.expense_account_id, '5010')
    assert.equal(rules[0].rule.tax_code_id, '4')
    assert.equal(rules[0].rule.vendor_profile_id, 'vp-1')
    assert.deepEqual(
      { min: rules[0].rule.amount_min, max: rules[0].rule.amount_max },
      { min: 100, max: 5000 },
    )

    // Rien n'est inventé : les deux valeurs absentes sont dites.
    assert.equal(rules[1].rule.expense_account_id, null)
    assert.equal(rules[1].rule.vendor_profile_id, null)
    assert.equal(rules[1].unresolved.length, 2)
  })

  it('le dit clairement quand ce n\'est pas le bon fichier', () => {
    const { rules, warnings } = readQbRulesFile(book([['Date', 'Montant'], ['2026-01-01', '10']]), resolve)
    assert.equal(rules.length, 0)
    assert.match(warnings[0], /entêtes/)
  })
})
