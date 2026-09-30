import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadOverviewBalances } from './overviewBalances.js'

const qbAccounts = [
  { Id: '61', CurrentBalance: 500, CurrencyRef: { value: 'CAD' } },
  { Id: '238', CurrentBalance: -12000 },
  { Id: '176', CurrentBalance: -8000 },
  { Id: '256', CurrentBalance: 125.34, CurrencyRef: { value: 'USD' } },
]
const defaults = { accounts: [], items: [], fetchBalances: async () => { throw new Error('Banque indisponible') }, fetchQbAccounts: async () => qbAccounts }
const bnc = { name: 'BNC CAD', currency: 'CAD', qb_account_id: '61', plaid_item_id: 'bnc', plaid_account_id: 'checking' }

test('les quatre comptes, dans l’ordre demandé, gardent leur devise et leur solde QuickBooks', async () => {
  const rows = await loadOverviewBalances(defaults)
  assert.deepEqual(rows.map(a => a.name), ['BNC CAD', 'Marge de crédit Desjardins', 'Marge de crédit BNC', 'VENN USD'])
  assert.deepEqual(rows.map(a => a.balance), [500, -12000, -8000, 125.34])
  assert.equal(rows[3].currency, 'USD')
  assert.ok(rows.every(a => a.source === 'quickbooks'))
})

test('Plaid prime sur QuickBooks, conserve zéro et distingue dette et crédit disponible', async () => {
  let calls = 0
  const rows = await loadOverviewBalances({ ...defaults,
    accounts: [bnc, { name: 'Marge BNC', qb_account_id: '176', plaid_item_id: 'bnc', plaid_account_id: 'credit' }],
    fetchBalances: async () => {
      calls++
      return { balanceAt: '2026-09-29T12:00:00Z', balances: [
        { plaid_account_id: 'checking', current: 0, available: 40000, iso_currency_code: 'CAD' },
        { plaid_account_id: 'credit', current: 25000, available: 75000, iso_currency_code: 'CAD' },
      ] }
    },
  })
  assert.equal(calls, 1, 'une seule lecture par connexion')
  assert.equal(rows[0].balance, 0)
  assert.equal(rows[0].source, 'plaid_live')
  assert.equal(rows[2].balance, -25000)
  assert.equal(rows[2].as_of, '2026-09-29T12:00:00Z')
})

test('une panne Plaid garde le dernier solde connu, daté et identifié', async () => {
  const rows = await loadOverviewBalances({ ...defaults, accounts: [bnc],
    items: [{ itemId: 'bnc', accounts: [{ plaid_account_id: 'checking', balance: 42, balance_at: '2026-09-28T12:00:00Z' }] }],
  })
  assert.equal(rows[0].balance, 42)
  assert.equal(rows[0].source, 'plaid_cached')
  assert.equal(rows[0].as_of, '2026-09-28T12:00:00Z')
  assert.equal(rows[1].source, 'quickbooks')
})

test('une marge déjà négative chez Desjardins reste une dette', async () => {
  const rows = await loadOverviewBalances({ ...defaults,
    accounts: [{ name: 'Marge Desjardins', plaid_item_id: 'desj', plaid_account_id: 'credit' }],
    items: [{ itemId: 'desj', accounts: [{ plaid_account_id: 'credit', balance: -119000 }] }],
  })
  assert.equal(rows[1].balance, -119000)
})

test('un solde Plaid absent ou dans la mauvaise devise revient à QuickBooks', async () => {
  for (const balance of [{ current: null, available: 9000 }, { current: 7, iso_currency_code: 'USD' }]) {
    const rows = await loadOverviewBalances({ ...defaults, accounts: [bnc],
      fetchBalances: async () => ({ balances: [{ plaid_account_id: 'checking', ...balance }] }),
    })
    assert.equal(rows[0].balance, 500)
    assert.equal(rows[0].source, 'quickbooks')
  }
})

test('une panne QuickBooks ne masque pas Plaid et un compte sans solde ne devient pas zéro', async () => {
  const rows = await loadOverviewBalances({ ...defaults, accounts: [bnc],
    fetchBalances: async () => ({ balances: [{ plaid_account_id: 'checking', current: 20 }] }),
    fetchQbAccounts: async () => { throw new Error('QuickBooks indisponible') },
  })
  assert.equal(rows[0].balance, 20)
  assert.equal(rows[1].balance, null)
  assert.equal(rows[1].source, null)
  assert.equal(rows.length, 4)
})
