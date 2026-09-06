// « Demandé par » du journal des nouveautés : le rapprochement entrée ↔ demande
// doit être franc ou muet. Un mauvais nom (attribuer la demande de quelqu'un à
// un collègue) est pire que pas de nom du tout — c'est ce que ces tests
// verrouillent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Le module importe la DB (lecture des déposants de la file de travaux) : on la
// détourne vers un fichier jetable avant l'import.
process.env.DATABASE_PATH = join(tmpdir(), `changelog-requesters-${process.pid}.db`)
const { resolveRequesters, tokenize, overlap, entryKey } =
  await import('./changelogRequesters.js')

const entry = (over = {}) => ({
  date: '2026-09-04',
  title: 'Les commissions apparaissent sur la fiche du projet',
  changes: [{ type: 'new', text: 'La fiche d\'un projet a une section « Commissions » : bénéficiaire, taux, montant.' }],
  ...over,
})

test('le vocabulaire significatif ignore mots vides et mots courts', () => {
  const t = tokenize('Afficher les commissions dans la fiche du projet')
  assert.ok(t.has('commissions'))
  assert.ok(t.has('projet'))
  assert.ok(!t.has('les'))
  assert.ok(!t.has('dans'))
  assert.ok(!t.has('afficher')) // mot d'app trop fréquent
})

test('le recouvrement compte la part du vocabulaire de l\'entrée retrouvée', () => {
  const { score, common } = overlap(tokenize('commissions projet fiche'), tokenize('commissions du projet'))
  assert.equal(common, 2)
  assert.ok(score > 0.5)
})

test('une entrée qui porte son demandeur fait foi, sans rapprochement', () => {
  const e = entry({ requester: 'Philippe' })
  const out = resolveRequesters([e], [
    { name: 'Charles', title: 'commissions projet fiche bénéficiaire', text: '', date: '2026-09-04' },
  ])
  assert.deepEqual(out[entryKey(e)], { name: 'Philippe', source: 'entry' })
})

test('une demande du même jour au vocabulaire net est rattachée', () => {
  const e = entry()
  const out = resolveRequesters([e], [
    {
      name: 'Guillaume',
      title: 'Commissions sur la fiche projet',
      text: 'Montrer les commissions (bénéficiaire, taux, montant) dans la fiche du projet',
      date: '2026-09-04T18:12:00.000Z',
    },
    { name: 'Charles', title: 'Étiquettes Novoxpress', text: 'Le ramassage ne part pas', date: '2026-09-04T09:00:00.000Z' },
  ])
  assert.equal(out[entryKey(e)].name, 'Guillaume')
  assert.equal(out[entryKey(e)].source, 'match')
})

test('deux demandeurs au coude à coude : aucun nom', () => {
  const e = entry()
  const req = {
    title: 'Commissions sur la fiche projet',
    text: 'Montrer les commissions (bénéficiaire, taux, montant) dans la fiche du projet',
    date: '2026-09-04T18:12:00.000Z',
  }
  const out = resolveRequesters([e], [
    { name: 'Guillaume', ...req },
    { name: 'Charles', ...req },
  ])
  assert.equal(out[entryKey(e)], undefined)
})

test('une demande hors de la fenêtre de dates n\'est pas rattachée', () => {
  const e = entry()
  const out = resolveRequesters([e], [
    {
      name: 'Guillaume',
      title: 'Commissions sur la fiche projet',
      text: 'Montrer les commissions (bénéficiaire, taux, montant) dans la fiche du projet',
      date: '2026-08-01T18:12:00.000Z',
    },
  ])
  assert.equal(out[entryKey(e)], undefined)
})

test('un vocabulaire qui ne se recoupe pas ne produit aucun nom', () => {
  const e = entry()
  const out = resolveRequesters([e], [
    { name: 'Charles', title: 'Étiquettes Novoxpress', text: 'Le ramassage ne part pas', date: '2026-09-04T09:00:00.000Z' },
  ])
  assert.equal(out[entryKey(e)], undefined)
})
