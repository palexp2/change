// Les deux tests non négociables du moteur de propositions : une proposition
// REFUSÉE ne revient jamais, une proposition ACCEPTÉE n'est pas re-proposée.
// Tout le reste du moteur peut évoluer ; ces deux-là sont la promesse faite à
// l'utilisateur (« ce que j'ai refusé reste refusé »).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  proposalFingerprint, reconcilePropositions, dedupeClaims, nextStatus, evidenceFor,
} from './model.js'

const base = { kind: 'qb_link', bank_txn_id: 'txn1', target_type: 'qb_entity', target_id: '4182' }

describe('proposalFingerprint', () => {
  test('ne bouge pas quand la confiance ou l’écart changent', () => {
    const a = proposalFingerprint({ ...base, confidence: 0.82, amount: -10 })
    const b = proposalFingerprint({ ...base, confidence: 0.94, amount: -12 })
    assert.equal(a, b)
  })

  test('change dès que la cible change', () => {
    assert.notEqual(
      proposalFingerprint(base),
      proposalFingerprint({ ...base, target_id: '4183' })
    )
  })

  test('distingue deux natures sur la même ligne', () => {
    assert.notEqual(
      proposalFingerprint(base),
      proposalFingerprint({ ...base, kind: 'doc_match' })
    )
  })
})

describe('reconcilePropositions', () => {
  const fp = proposalFingerprint(base)

  test('insère ce qui n’existe pas', () => {
    const r = reconcilePropositions([], [base])
    assert.equal(r.inserer.length, 1)
    assert.equal(r.inserer[0].fingerprint, fp)
  })

  test('une refusée n’est JAMAIS re-proposée', () => {
    const r = reconcilePropositions([{ id: 'p1', fingerprint: fp, status: 'refusee' }], [base])
    assert.deepEqual(r.inserer, [])
    assert.deepEqual(r.mettreAJour, [])
    assert.equal(r.ignorees.refusees, 1)
  })

  test('un refus tient même si la confiance a monté', () => {
    const r = reconcilePropositions(
      [{ id: 'p1', fingerprint: fp, status: 'refusee' }],
      [{ ...base, confidence: 0.99 }]
    )
    assert.equal(r.ignorees.refusees, 1)
    assert.equal(r.inserer.length, 0)
  })

  test('une acceptée est ignorée, pas retouchée', () => {
    const r = reconcilePropositions([{ id: 'p1', fingerprint: fp, status: 'acceptee' }], [base])
    assert.equal(r.ignorees.acceptees, 1)
    assert.equal(r.mettreAJour.length, 0)
  })

  test('met à jour quand la preuve se précise', () => {
    const old = { id: 'p1', fingerprint: fp, status: 'proposee', confidence: 0.5, evidence: null, payload: null, amount: null, currency: null, account_id: null }
    const r = reconcilePropositions([old], [{ ...base, confidence: 0.9 }])
    assert.equal(r.mettreAJour.length, 1)
    assert.equal(r.mettreAJour[0].id, 'p1')
  })

  test('ne touche à rien quand rien n’a changé', () => {
    const same = { ...base, confidence: 0.9, evidence: null, payload: null, amount: null, currency: null, account_id: null }
    const old = { id: 'p1', fingerprint: fp, status: 'proposee', ...same }
    const r = reconcilePropositions([old], [same])
    assert.equal(r.inchangees.length, 1)
    assert.equal(r.mettreAJour.length, 0)
  })

  test('une périmée que le moteur retrouve redevient vivante', () => {
    // Sans ça, l'unicité de l'empreinte l'empêcherait de revenir : l'insertion
    // serait ignorée en silence et la proposition resterait périmée à jamais.
    const r = reconcilePropositions([{ id: 'p1', fingerprint: fp, status: 'perimee' }], [base])
    assert.equal(r.mettreAJour.length, 1)
    assert.equal(r.mettreAJour[0].revive, true)
    assert.equal(r.inserer.length, 0)
  })

  test('une deuxième candidate sur la même ligne attend son tour', () => {
    // La base n'accepte qu'une proposition vivante par (ligne, nature) : une
    // rivale ne doit pas être insérée — et surtout pas faire échouer le passage.
    const vivante = { id: 'p1', fingerprint: fp, status: 'proposee', bank_txn_id: 'txn1', kind: 'qb_link' }
    const rivale = { ...base, target_id: '9999' }
    const r = reconcilePropositions([vivante], [rivale])
    assert.equal(r.inserer.length, 0)
    assert.equal(r.ignorees.enAttente, 1)
  })

  test('deux candidates neuves sur la même ligne : une seule passe', () => {
    const r = reconcilePropositions([], [base, { ...base, target_id: '9999' }])
    assert.equal(r.inserer.length, 1)
  })

  test('périme une proposition que plus personne ne reproduit', () => {
    const old = { id: 'p1', fingerprint: fp, status: 'proposee', runs_unseen: 5 }
    assert.deepEqual(reconcilePropositions([old], [], { staleRuns: 6 }).perimer, ['p1'])
    // Pas encore : il lui reste des passages à vivre.
    const jeune = { id: 'p2', fingerprint: 'autre', status: 'proposee', runs_unseen: 0 }
    assert.deepEqual(reconcilePropositions([jeune], [], { staleRuns: 6 }).perimer, [])
  })
})

describe('dedupeClaims', () => {
  test('la preuve la plus forte réclame la ligne', () => {
    const kept = dedupeClaims([
      { kind: 'vendor_expense', bank_txn_id: 'txn1', confidence: 0.99 },
      { kind: 'qb_link', bank_txn_id: 'txn1', confidence: 0.5 },
    ])
    assert.equal(kept.length, 1)
    assert.equal(kept[0].kind, 'qb_link')
  })

  test('à nature égale, la plus confiante gagne', () => {
    const kept = dedupeClaims([
      { kind: 'doc_match', bank_txn_id: 'txn1', confidence: 0.81, target_id: 'a' },
      { kind: 'doc_match', bank_txn_id: 'txn1', confidence: 0.95, target_id: 'b' },
    ])
    assert.equal(kept[0].target_id, 'b')
  })

  test('deux lignes différentes gardent chacune la leur', () => {
    assert.equal(dedupeClaims([
      { kind: 'qb_link', bank_txn_id: 'a' }, { kind: 'qb_link', bank_txn_id: 'b' },
    ]).length, 2)
  })
})

describe('nextStatus', () => {
  test('on ne décide qu’une fois', () => {
    assert.equal(nextStatus('proposee', 'accepter'), 'acceptee')
    assert.equal(nextStatus('proposee', 'refuser'), 'refusee')
    assert.equal(nextStatus('acceptee', 'refuser'), null)
    assert.equal(nextStatus('refusee', 'accepter'), null)
  })
})

describe('evidenceFor', () => {
  test('parle français, pas en codes', () => {
    const e = evidenceFor('qb_link', { method: 'exact', delta: 0, gap: 0 })
    assert.deepEqual(e.map((x) => x.label), ['Montant et date exacts', 'Même montant qu’au relevé', 'Même date'])
  })

  test('chiffre l’écart quand il y en a un', () => {
    const e = evidenceFor('qb_link', { method: 'tolerance', delta: -0.5, gap: 2 })
    assert.equal(e[1].detail, '-0.50 $')
    assert.equal(e[2].detail, '2 jours')
  })
})
