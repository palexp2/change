import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeUsername, dedupKeyFor, eventKeyFor, detectKeyword, buildWeeklyMessage, localHour,
  weekRangeLabel, coveredWeek,
} from './instagramProspects.js'

// Seules les fonctions PURES sont testées ici. La logique de dédup en base
// (resolveProspect / ingestManychatEvent) tape le singleton db, or la base de
// prod EST la base de test dans ce projet : elle se vérifie par des appels HTTP
// réels sur des fiches jetables (cf. section Vérification du plan), jamais ici.

test("normalizeUsername : retire l'arrobas et les espaces, garde la casse", () => {
  assert.equal(normalizeUsername('@Jean_Coach '), 'Jean_Coach')
  assert.equal(normalizeUsername('  @@serres.qc'), 'serres.qc')
  assert.equal(normalizeUsername('  '), null)
  assert.equal(normalizeUsername(null), null)
})

test('dedupKeyFor : IGSID prioritaire, repli sur le nom d’usager en minuscules', () => {
  assert.equal(dedupKeyFor({ ig_user_id: '17841', ig_username: 'Jean' }), 'igsid:17841')
  assert.equal(dedupKeyFor({ ig_username: '@Jean' }), 'user:jean')
  // Le même humain écrit de deux façons doit donner la MÊME clé, sinon il
  // recevrait un second DM.
  assert.equal(dedupKeyFor({ ig_username: '@Jean' }), dedupKeyFor({ ig_username: 'jean' }))
  assert.equal(dedupKeyFor({}), null)
})

test('eventKeyFor : utilise event_id quand fourni, sinon une empreinte stable', () => {
  const a = eventKeyFor({ event_id: 'c_1', kind: 'comment' })
  assert.equal(a, 'comment:c_1')
  // Le même event_id sur un flux différent ne doit pas se télescoper.
  assert.notEqual(a, eventKeyFor({ event_id: 'c_1', kind: 'reply' }))

  const base = { kind: 'comment', dedupKey: 'user:jean', text: 'coach', occurredAt: '2026-08-11T14:03:00.000Z' }
  assert.equal(eventKeyFor(base), eventKeyFor({ ...base }))
  assert.notEqual(eventKeyFor(base), eventKeyFor({ ...base, text: 'autre chose' }))
})

test('detectKeyword : insensible à la casse et aux accents', () => {
  assert.equal(detectKeyword('Je cherche un COACH !'), 'coach')
  assert.equal(detectKeyword('un coàch svp'), 'coach')
  assert.equal(detectKeyword('super produit'), null)
  assert.equal(detectKeyword(null), null)
  assert.equal(detectKeyword('je veux un mentor', 'coach, mentor'), 'mentor')
})

test('coveredWeek : le message du lundi annonce la semaine qui vient de finir', () => {
  // Envoi le lundi 24 août 2026 → la semaine couverte est W34 (17 au 23), pas
  // W35 qui commence le jour même.
  assert.equal(coveredWeek('2026-08-24'), '2026-W34')
  // Un envoi manuel un dimanche reste sur la même semaine.
  assert.equal(coveredWeek('2026-08-23'), '2026-W34')
})

test('weekRangeLabel : dates en clair, y compris à cheval sur deux mois', () => {
  assert.equal(weekRangeLabel('2026-W34'), 'du 17 au 23 août')
  assert.equal(weekRangeLabel('2026-W40'), 'du 28 septembre au 4 octobre')
  assert.equal(weekRangeLabel('pas-une-semaine'), 'pas-une-semaine')
})

test('buildWeeklyMessage : liste vide → message explicite (un silence = panne)', () => {
  const msg = buildWeeklyMessage([], { dayIso: '2026-08-24' })
  assert.match(msg, /Aucun nouveau prospect/)
  // Le numéro ISO ne parle à personne : l'en-tête doit porter les dates.
  assert.match(msg, /du 17 au 23 août/)
  assert.equal(msg.includes('2026-W'), false)
})

test('buildWeeklyMessage : résumé chiffré seulement, jamais la liste des prospects', () => {
  const prospects = [
    { ig_username: 'jardin.serre', has_keyword: 1, dm_sent: 1, replied: 1, comment_count: 1,
      first_comment_at: '2026-08-19T15:00:00.000Z', first_comment_text: 'je veux un coach' },
    { ig_username: 'luc_potager', has_keyword: 0, dm_sent: 0, replied: 0, comment_count: 3,
      first_comment_at: '2026-08-20T15:00:00.000Z', first_comment_text: 'beau produit' },
    { ig_username: 'serres.qc', has_keyword: 1, dm_sent: 0, replied: 0, comment_count: 1,
      first_comment_at: '2026-08-21T15:00:00.000Z', full_name: 'Marie Tremblay' },
  ]
  const msg = buildWeeklyMessage(prospects, {
    dayIso: '2026-08-24',
    url: 'https://airtable.com/appX/tblY',
    erpUrl: 'https://customer.orisha.io/erp/prospects-instagram',
  })

  assert.match(msg, /3 prospect\(s\) · dont 2 avec le mot-clé · 1 DM envoyé\(s\) · 1 a répondu/)
  // Le détail vit dans l'ERP et Airtable : aucun nom d'usager ni commentaire
  // ne doit se retrouver dans Slack.
  assert.equal(msg.includes('@jardin.serre'), false)
  assert.equal(msg.includes('beau produit'), false)
  assert.equal(msg.includes('Mot-clé'), false)
  assert.match(msg, /<https:\/\/customer\.orisha\.io\/erp\/prospects-instagram\|Ouvrir la liste dans l'ERP>/)
  assert.match(msg, /<https:\/\/airtable\.com\/appX\/tblY\|Ouvrir dans Airtable>/)
})

test('buildWeeklyMessage : « dont N avec le mot-clé » disparaît quand tous en ont un', () => {
  const all = [{ ig_username: 'a', has_keyword: 1 }, { ig_username: 'b', has_keyword: 1 }]
  assert.equal(buildWeeklyMessage(all, { dayIso: '2026-08-24' }).includes('dont'), false)
})

test('buildWeeklyMessage : pas de lien si ni ERP ni Airtable ne sont configurés', () => {
  const msg = buildWeeklyMessage([], { dayIso: '2026-08-24', url: null })
  assert.equal(msg.includes('airtable.com'), false)
  assert.equal(msg.includes('Ouvrir'), false)
})

test('localHour : minuit et midi à Montréal, quelle que soit la saison', () => {
  // 4h UTC en août (EDT, UTC-4) = minuit à Montréal ; 5h UTC = 1h.
  assert.equal(localHour(new Date('2026-08-16T04:00:00Z')), 0)
  assert.equal(localHour(new Date('2026-08-16T05:00:00Z')), 1)
  // 5h UTC en janvier (EST, UTC-5) = minuit à Montréal ; 4h = 23h la veille.
  assert.equal(localHour(new Date('2026-01-18T05:00:00Z')), 0)
  assert.equal(localHour(new Date('2026-01-18T04:00:00Z')), 23)
})
