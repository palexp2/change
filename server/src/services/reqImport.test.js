import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'stream'
import {
  normalizeName, parseAddressLines, streamCsv, isStruckOff, HORTICULTURE_RE,
} from './reqImport.js'

// Ces tests ne touchent que des fonctions pures : aucune écriture en base.

test('normalizeName rapproche les mêmes noms écrits différemment', () => {
  assert.equal(normalizeName('Les Serres Dupont inc.'), normalizeName('SERRES DUPONT'))
  assert.equal(normalizeName('Ferme Bélanger ltée'), normalizeName('ferme belanger'))
  assert.notEqual(normalizeName('Serres Dupont'), normalizeName('Serres Tremblay'))
  assert.equal(normalizeName(''), '')
})

test('parseAddressLines repère code postal, province et ville quel que soit l\'ordre', () => {
  const a = parseAddressLines(['120 rang des Érables', 'Saint-Rémi (Québec)', 'J0L 2L0', ''])
  assert.equal(a.adresse, '120 rang des Érables')
  assert.equal(a.ville, 'Saint-Rémi')
  assert.equal(a.province, 'QC')
  assert.equal(a.code_postal, 'J0L 2L0')

  // Ordre inversé et province sur sa propre ligne : même résultat.
  const b = parseAddressLines(['G1V 4M6', 'Québec', 'Sainte-Foy', '5 rue Principale'])
  assert.equal(b.province, 'QC')
  assert.equal(b.code_postal, 'G1V 4M6')
  assert.ok(b.adresse.includes('5 rue Principale'))
})

test('parseAddressLines survit à un bloc vide', () => {
  const a = parseAddressLines([null, '', undefined, ''])
  assert.deepEqual(a, { adresse: null, ville: null, province: null, code_postal: null })
})

test('streamCsv lit les guillemets, les virgules échappées et les accents coupés en deux blocs', async () => {
  const csv = 'NEQ,NOM_ASSUJ,VILLE\n'
    + '1234567890,"Serres Bélanger, division serre","Saint-Rémi"\n'
    + '1234567891,"Guillemet ""double""",Laval\n'
  // Deux morceaux dont la coupure tombe au milieu d'un caractère multi-octets :
  // c'est exactement ce que produit un createReadStream sur un gros fichier.
  const buf = Buffer.from(csv, 'utf8')
  const cut = buf.indexOf(Buffer.from('é', 'utf8')) + 1
  const stream = Readable.from([buf.subarray(0, cut), buf.subarray(cut)])

  const rows = []
  const count = await streamCsv(stream, r => rows.push(r))
  assert.equal(count, 2)
  assert.equal(rows[0].nom_assuj, 'Serres Bélanger, division serre')
  assert.equal(rows[0].ville, 'Saint-Rémi')
  assert.equal(rows[1].nom_assuj, 'Guillemet "double"')
})

test('streamCsv détecte le point-virgule d\'un fichier collé à la main', async () => {
  const rows = []
  await streamCsv(Readable.from([Buffer.from('NEQ;NOM_ASSUJ\n1;Serres Test\n', 'utf8')]), r => rows.push(r))
  assert.deepEqual(rows, [{ neq: '1', nom_assuj: 'Serres Test' }])
})

test('isStruckOff distingue une entreprise radiée d\'une entreprise immatriculée', () => {
  assert.equal(isStruckOff('Radiée d\'office'), true)
  assert.equal(isStruckOff('Dissoute'), true)
  assert.equal(isStruckOff('Immatriculée'), false)
  assert.equal(isStruckOff(null), false)
})

test('le filtre horticole retient les serres et laisse passer le reste', () => {
  for (const s of ['culture en serre', 'horticulture ornementale', 'pepiniere', 'maraicher']) {
    assert.ok(HORTICULTURE_RE.test(s), s)
  }
  assert.equal(HORTICULTURE_RE.test('reparation de vehicules'), false)
})
