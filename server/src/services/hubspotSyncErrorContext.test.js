// Tests pour le contexte d'erreur de la sync hubspot_tasks (HubSpot → ERP).
//
// Contexte : un 500 persistant de /crm/v3/objects/tasks/search faisait remonter
// une erreur générique qui abandonnait toute la sync, sans que sync_log ne
// capture le curseur `after`, la fenêtre temporelle demandée, ni le nombre de
// tâches traitées avant l'échec — impossible à diagnostiquer ou reprendre.
//
// On vérifie ici :
//   1. describeSyncFailure() — le formatage pur du suffixe de message d'erreur.
//   2. L'enrichissement `error.hubspotSearch` (curseur + fenêtre + volume) posé
//      par le connecteur quand une page de search échoue, en stubant global.fetch
//      (aucun appel réseau réel, aucune écriture DB).

import test from 'node:test'
import assert from 'node:assert/strict'

import { describeSyncFailure } from './hubspotSync.js'
import { searchTasksModifiedSince, isHubSpotConfigured } from '../connectors/hubspot.js'

// ── describeSyncFailure (pur) ─────────────────────────────────────────────────

test('describeSyncFailure : fenêtre delta + curseur + volume', () => {
  const msg = describeSyncFailure({
    processed: 42,
    modified: 17,
    ctx: {
      windowFrom: '2026-06-01T00:00:00.000Z',
      windowTo: '2026-06-08T00:00:00.000Z',
      after: 'CURSOR123',
      fetchedInWindow: 200,
    },
  })
  assert.match(msg, /tâches traitées avant l'échec: 42/)
  assert.match(msg, /dont écrites en ERP: 17/)
  assert.match(msg, /fenêtre demandée: 2026-06-01T00:00:00\.000Z → 2026-06-08T00:00:00\.000Z/)
  assert.match(msg, /curseur after: CURSOR123/)
  assert.match(msg, /récupérés dans la fenêtre fautive avant l'échec: 200/)
})

test('describeSyncFailure : échec sur la 1re page (after absent)', () => {
  const msg = describeSyncFailure({
    processed: 0,
    modified: 0,
    ctx: { windowFrom: '2026-06-01T00:00:00.000Z', windowTo: '2026-06-08T00:00:00.000Z', after: null, fetchedInWindow: 0 },
  })
  assert.match(msg, /curseur after: \(1re page de la fenêtre\)/)
  assert.match(msg, /tâches traitées avant l'échec: 0/)
})

test('describeSyncFailure : mode backfill (sans curseur)', () => {
  const msg = describeSyncFailure({ processed: 5, modified: 5, ctx: {} })
  assert.match(msg, /mode backfill \(sans curseur\)/)
  // Pas de fetchedInWindow → la mention de volume est omise.
  assert.doesNotMatch(msg, /récupérés dans la fenêtre/)
})

test('describeSyncFailure : valeurs par défaut robustes (appel vide)', () => {
  const msg = describeSyncFailure()
  assert.match(msg, /tâches traitées avant l'échec: 0/)
  assert.match(msg, /dont écrites en ERP: 0/)
})

// ── Enrichissement error.hubspotSearch par le connecteur ──────────────────────
//
// Ces cas stubent global.fetch ; ils nécessitent un token HubSpot configuré
// (getAccessToken lit connector_config). Si HubSpot n'est pas configuré sur
// cette DB, on saute proprement plutôt que d'échouer.

const hsConfigured = isHubSpotConfigured()

function jsonResponse(body) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}
function errorResponse(status, text = 'boom') {
  return {
    status,
    ok: false,
    headers: { get: () => null },
    text: async () => text,
    json: async () => ({}),
  }
}

test('search échoue dès la 1re page : after=null, fetchedInWindow=0, fenêtre posée', { skip: !hsConfigured }, async () => {
  const realFetch = global.fetch
  global.fetch = async () => errorResponse(400, 'bad request')
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    await assert.rejects(
      () => searchTasksModifiedSince(since),
      (e) => {
        assert.ok(e.hubspotSearch, 'erreur enrichie avec hubspotSearch')
        assert.equal(e.hubspotSearch.after, null)
        assert.equal(e.hubspotSearch.fetchedInWindow, 0)
        assert.ok(e.hubspotSearch.windowFrom, 'windowFrom présent')
        assert.ok(e.hubspotSearch.windowTo, 'windowTo présent')
        return true
      },
    )
  } finally {
    global.fetch = realFetch
  }
})

test('search échoue à la 2e page : after = curseur, fetchedInWindow = volume 1re page', { skip: !hsConfigured }, async () => {
  const realFetch = global.fetch
  let call = 0
  global.fetch = async () => {
    call++
    if (call === 1) {
      // 1re page : 3 résultats + curseur de pagination vers la page suivante.
      return jsonResponse({
        results: [{ id: '1' }, { id: '2' }, { id: '3' }],
        paging: { next: { after: 'PAGE2CURSOR' } },
      })
    }
    return errorResponse(500, 'internal error') // 2e page : 500
  }
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    await assert.rejects(
      () => searchTasksModifiedSince(since),
      (e) => {
        assert.equal(e.hubspotSearch.after, 'PAGE2CURSOR')
        assert.equal(e.hubspotSearch.fetchedInWindow, 3)
        assert.ok(e.hubspotSearch.windowFrom)
        assert.ok(e.hubspotSearch.windowTo)
        return true
      },
    )
  } finally {
    global.fetch = realFetch
  }
})

test('onWindow appliqué fenêtre par fenêtre avant un échec ultérieur', { skip: !hsConfigured }, async () => {
  // since très ancien → plusieurs fenêtres de 7 jours. La 1re réussit (vide),
  // la 2e échoue. onWindow doit avoir été appelé pour la 1re avant le throw.
  const realFetch = global.fetch
  let call = 0
  global.fetch = async () => {
    call++
    if (call === 1) return jsonResponse({ results: [], paging: {} }) // fenêtre 1 OK, vide
    return errorResponse(500, 'internal error')                      // fenêtre 2 échoue
  }
  const windowsSeen = []
  try {
    const since = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString() // ~3 fenêtres
    await assert.rejects(
      () => searchTasksModifiedSince(since, (results, win) => { windowsSeen.push(win) }),
      (e) => {
        assert.ok(e.hubspotSearch.windowFrom)
        return true
      },
    )
    assert.equal(windowsSeen.length, 1, 'une fenêtre appliquée avant l\'échec de la suivante')
  } finally {
    global.fetch = realFetch
  }
})
