import { test } from 'node:test'
import assert from 'node:assert/strict'
import db from '../db/database.js'
import { findBankDebit, labelMatchesPattern, shiftDate } from './bankDebitLookup.js'

// Compte et transactions jetables : ids préfixés « test- », supprimés à la fin.
// Rien ne touche un vrai compte ni une vraie transaction.
const ACC = 'test-bank-debit-lookup-account'
const ACC_NAME = 'ZZ Test Lookup'

function seed(rows) {
  db.prepare(`INSERT OR REPLACE INTO bank_accounts (id, name, kind, currency) VALUES (?,?, 'bank', 'CAD')`).run(ACC, ACC_NAME)
  for (const r of rows) {
    db.prepare(`INSERT OR REPLACE INTO bank_transactions
      (id, account_id, txn_date, description, details, amount, dedup_key, pending, qb_txn_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      r.id, ACC, r.txn_date, r.description || null, r.details || null, r.amount,
      `test-dedup-${r.id}`, r.pending ? 1 : 0, r.qb_txn_id || null, r.created_at || '2026-01-01T00:00:00.000Z')
  }
}

function cleanup() {
  db.prepare('DELETE FROM bank_transactions WHERE account_id=?').run(ACC)
  db.prepare('DELETE FROM bank_accounts WHERE id=?').run(ACC)
}

test('labelMatchesPattern : tous les mots du motif, accents et ponctuation ignorés', () => {
  assert.ok(labelMatchesPattern('COMPTE DIVERS DT NETHRIS PAIE', 'NETHRIS PAIE'))
  assert.ok(labelMatchesPattern('Assurance Ent. Aga', 'aga'))
  assert.ok(labelMatchesPattern('VILLE DE QUEBEC', 'Ville de Québec'))
  // « NETHRIS SERV » (49,84 $/mois) n'est PAS la paie : le second mot manque.
  assert.ok(!labelMatchesPattern('COMPTE DIVERS DT NETHRIS SERV', 'NETHRIS PAIE'))
  // Un motif vide ne doit jamais tout matcher.
  assert.ok(!labelMatchesPattern('COMPTE DIVERS', ''))
})

test('findBankDebit : un seul candidat = le débit est retenu', () => {
  seed([
    { id: 'test-bdl-1', txn_date: '2026-09-01', amount: -20932.32, description: 'COMPTE DIVERS', details: 'DT NETHRIS PAIE' },
    { id: 'test-bdl-2', txn_date: '2026-09-01', amount: -49.84, description: 'COMPTE DIVERS', details: 'DT NETHRIS SERV' },
    { id: 'test-bdl-3', txn_date: '2026-09-01', amount: 5000, description: 'DEPOT NETHRIS PAIE' },
  ])
  try {
    const r = findBankDebit({ accountName: ACC_NAME, pattern: 'NETHRIS PAIE', from: '2026-08-28', to: '2026-09-08' })
    assert.equal(r.candidates.length, 1, 'le crédit et « NETHRIS SERV » sont écartés')
    assert.equal(r.match.id, 'test-bdl-1')
    assert.equal(r.match.amount, 20932.32, 'montant rendu en valeur absolue')
    assert.equal(r.stale_since, '2026-09-01')
  } finally { cleanup() }
})

test('findBankDebit : deux candidats, le montant attendu départage — sinon ambiguïté', () => {
  seed([
    { id: 'test-bdl-a', txn_date: '2026-09-01', amount: -20932.32, description: 'DT NETHRIS PAIE' },
    { id: 'test-bdl-b', txn_date: '2026-09-03', amount: -8100.00, description: 'DT NETHRIS PAIE' },
  ])
  try {
    const clear = findBankDebit({
      accountName: ACC_NAME, pattern: 'NETHRIS PAIE', from: '2026-08-28', to: '2026-09-08', amountHint: 21000,
    })
    assert.equal(clear.match.id, 'test-bdl-a')
    assert.equal(clear.candidates.length, 2, 'les deux restent proposés à l\'écran')

    // Deux montants aussi proches l'un que l'autre de l'indice : on ne tranche
    // pas, l'humain choisit.
    const ambiguous = findBankDebit({
      accountName: ACC_NAME, pattern: 'NETHRIS PAIE', from: '2026-08-28', to: '2026-09-08', amountHint: 14500, tolerancePct: 100,
    })
    assert.equal(ambiguous.match, null)
    assert.equal(ambiguous.candidates.length, 2)

    // Aucun indice de montant : deux candidats = pas de choix automatique.
    const noHint = findBankDebit({ accountName: ACC_NAME, pattern: 'NETHRIS PAIE', from: '2026-08-28', to: '2026-09-08' })
    assert.equal(noHint.match, null)
  } finally { cleanup() }
})

test('findBankDebit : transaction déjà rattachée ailleurs, ou déjà comptabilisée, écartée', () => {
  seed([
    { id: 'test-bdl-x', txn_date: '2026-09-01', amount: -20932.32, description: 'DT NETHRIS PAIE' },
    { id: 'test-bdl-y', txn_date: '2026-08-10', amount: -2737.95, description: 'Assurance Ent. Aga', qb_txn_id: '17667' },
  ])
  try {
    const excluded = findBankDebit({
      accountName: ACC_NAME, pattern: 'NETHRIS PAIE', from: '2026-08-28', to: '2026-09-08',
      excludeTxnIds: ['test-bdl-x'],
    })
    assert.equal(excluded.match, null)
    assert.equal(excluded.candidates.length, 0)

    // Le prélèvement AGA d'août porte déjà une écriture QB : plus rien à passer.
    const booked = findBankDebit({
      accountName: ACC_NAME, pattern: 'AGA', from: '2026-07-01', to: '2026-09-08', excludeBooked: true,
    })
    assert.equal(booked.candidates.length, 0)
    // Sans le filtre, il ressort (c'est bien la même transaction).
    const all = findBankDebit({ accountName: ACC_NAME, pattern: 'AGA', from: '2026-07-01', to: '2026-09-08' })
    assert.equal(all.candidates.length, 1)
  } finally { cleanup() }
})

test('findBankDebit : une transaction en attente est proposée, mais signalée', () => {
  seed([{ id: 'test-bdl-p', txn_date: '2026-09-01', amount: -20932.32, description: 'DT NETHRIS PAIE', pending: 1 }])
  try {
    const r = findBankDebit({ accountName: ACC_NAME, pattern: 'NETHRIS PAIE', from: '2026-08-28', to: '2026-09-08' })
    assert.equal(r.match.id, 'test-bdl-p')
    assert.equal(r.match.pending, true, 'l\'écran doit pouvoir bloquer la publication')
  } finally { cleanup() }
})

test('findBankDebit : compte inconnu ou hors fenêtre = rien, sans planter', () => {
  seed([{ id: 'test-bdl-old', txn_date: '2026-06-01', amount: -20932.32, description: 'DT NETHRIS PAIE' }])
  try {
    const outOfWindow = findBankDebit({ accountName: ACC_NAME, pattern: 'NETHRIS PAIE', from: '2026-08-28', to: '2026-09-08' })
    assert.equal(outOfWindow.match, null)
    assert.equal(outOfWindow.stale_since, '2026-06-01', 'on sait quand même de quand date le relevé')

    const noAccount = findBankDebit({ accountName: 'ZZ Compte qui n\'existe pas', pattern: 'X', from: '2026-01-01', to: '2026-12-31' })
    assert.deepEqual(noAccount, { match: null, candidates: [], stale_since: null, account_id: null })
  } finally { cleanup() }
})

test('shiftDate : décalage en jours, sans dérive de fuseau', () => {
  assert.equal(shiftDate('2026-08-29', 10), '2026-09-08')
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28')
})
