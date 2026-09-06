// Contrat des quatre files d'implémentation.
//
// `exec_lane` n'est pas qu'un compteur d'affichage : c'est lui qui désigne le
// fichier PID d'une exécution (`.agent-pid`, `.agent-pid-1`…), donc le suivi repris
// après un redémarrage du serveur. Une valeur hors intervalle (colonne héritée à
// NULL, tâche d'avant les files, JSON bricolé à la main) doit retomber sur la file 0
// — celle du fichier historique — et JAMAIS produire un `.agent-pid-undefined` :
// l'exécution deviendrait introuvable au démarrage suivant et serait déclarée
// « bloquée » alors qu'elle tourne.
//
// Import volontairement limité aux helpers purs : ce module démarre l'ordonnanceur
// au chargement, on ne lui demande donc rien qui puisse lancer une exécution réelle.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXEC_LANES, execLaneOf, getExecLaneCount, getRunningTaskIds } from './taskRunner.js'

test('quatre files, et le runner en expose le compte', () => {
  assert.equal(EXEC_LANES, 4)
  assert.equal(getExecLaneCount(), EXEC_LANES)
})

test('une file valide est rendue telle quelle', () => {
  for (let lane = 0; lane < EXEC_LANES; lane++) {
    assert.equal(execLaneOf({ exec_lane: lane }), lane)
  }
})

test('file absente, nulle ou hors intervalle → file 0 (le fichier PID historique)', () => {
  for (const bad of [undefined, null, -1, EXEC_LANES, 99, 1.5, NaN, 'deux', '', {}, []]) {
    assert.equal(execLaneOf({ exec_lane: bad }), 0, `exec_lane=${JSON.stringify(bad)} doit retomber sur 0`)
  }
  assert.equal(execLaneOf({}), 0)
  assert.equal(execLaneOf(null), 0)
  assert.equal(execLaneOf(undefined), 0)
})

test('une file numérique en texte reste comprise (JSON relu du store)', () => {
  assert.equal(execLaneOf({ exec_lane: '3' }), 3)
})

test('jamais plus d\'une implémentation par file en cours', () => {
  const ids = getRunningTaskIds()
  assert.ok(ids.length <= EXEC_LANES, `${ids.length} implémentations pour ${EXEC_LANES} files`)
  assert.equal(new Set(ids).size, ids.length, 'une même tâche ne peut pas occuper deux files')
})
