// Régression : resolveTaxCodeForInvoice confondait « code de taxe légitimement
// absent en QB » et « échec réseau/API transitoire » — les deux retombaient sur
// null via `catch { return null }`. L'appelant posait alors le Deposit/JE SANS
// TaxCodeRef : sur un simple blip réseau, la TPS/TVQ/TVH n'était plus ventilée
// sur du vrai revenu, sans aucune trace.
//
// Le correctif tague l'absence métier (TaxCodeNotFoundError → taxCodeNotFound:true)
// et expose isTaxCodeNotFoundError() : seul ce cas doit devenir un null métier, tout
// le reste (qbGet qui throw) doit être propagé pour faire échouer la pose et la rejouer.

import test from 'node:test'
import assert from 'node:assert/strict'

import { isTaxCodeNotFoundError } from './quickbooks.js'

test('isTaxCodeNotFoundError : vrai pour une absence métier taguée', () => {
  const e = new Error('TaxCode QB introuvable: "TPS"')
  e.taxCodeNotFound = true
  assert.equal(isTaxCodeNotFoundError(e), true)
})

test('isTaxCodeNotFoundError : faux pour une erreur réseau/API transitoire', () => {
  // Typique d'un qbGet qui throw (timeout, ECONNRESET, 401, 500…) — message qui
  // pourrait même contenir « TaxCode » sans pour autant être un null métier.
  const transient = new Error('QB API 503: TaxCode query failed')
  assert.equal(isTaxCodeNotFoundError(transient), false)
  assert.equal(isTaxCodeNotFoundError(new Error('socket hang up')), false)
})

test('isTaxCodeNotFoundError : faux pour les valeurs vides/non-erreur', () => {
  assert.equal(isTaxCodeNotFoundError(null), false)
  assert.equal(isTaxCodeNotFoundError(undefined), false)
  assert.equal(isTaxCodeNotFoundError('TaxCode introuvable'), false)
  assert.equal(isTaxCodeNotFoundError({ taxCodeNotFound: 'yes' }), false) // strictement true requis
})

test('décision catch : not-found → null métier, transitoire → propagé', async () => {
  // Réplique la logique des deux sites catch de resolveTaxCodeForInvoice.
  async function resolveOrRethrow(thrower) {
    try {
      return await thrower()
    } catch (e) {
      if (isTaxCodeNotFoundError(e)) return null
      throw e
    }
  }

  // Absence métier → null (pose sans TaxCodeRef, comportement voulu).
  const notFound = Object.assign(new Error('introuvable'), { taxCodeNotFound: true })
  assert.equal(await resolveOrRethrow(async () => { throw notFound }), null)

  // Blip transitoire → l'erreur remonte (la pose échoue et sera rejouée).
  await assert.rejects(
    resolveOrRethrow(async () => { throw new Error('ECONNRESET') }),
    /ECONNRESET/,
  )

  // Cas nominal → l'Id est retourné tel quel.
  assert.equal(await resolveOrRethrow(async () => '42'), '42')
})
