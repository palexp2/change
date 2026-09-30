import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFollowUpPrompt, resolveReply, futureStart, briefFor, REQUESTER_MARKER, pickNextImplementations } from './promptQueue.js'
import { detectSessionLimit, detectRateLimitEvent, extractPendingQuestion, QUESTION_MARKER } from './taskRunner.js'

// ── Continuité d'un fil ───────────────────────────────────────────────────────
// Le prompt de relance doit être AUTOPORTANT : c'est la garantie que la
// conversation survit à une session Claude purgée (--resume qui échoue, machine
// redémarrée, contexte effacé). Tout ce dont l'agent a besoin y est en clair.

const row = { prompt: 'Importe les tâches du fichier X du Drive.', title: 'Import X' }
const messages = [
  { role: 'agent', text: 'Quel onglet du fichier faut-il lire ?' },
  { role: 'user', text: "L'onglet « AL »." },
]

test('la relance contient la demande initiale et tout le fil', () => {
  const p = buildFollowUpPrompt(row, messages)
  assert.match(p, /DEMANDE INITIALE/)
  assert.match(p, /Importe les tâches du fichier X du Drive\./)
  assert.match(p, /Quel onglet du fichier faut-il lire \?/)
  assert.match(p, /L'onglet « AL »\./)
})

test('les rôles sont explicites et ordonnés', () => {
  const p = buildFollowUpPrompt(row, messages)
  assert.ok(p.indexOf('Toi : Quel onglet') < p.indexOf('Humain : L\'onglet'),
    'le fil doit rester dans l\'ordre chronologique')
})

test('la relance demande de répondre au dernier message, pas de tout refaire', () => {
  const p = buildFollowUpPrompt(row, messages)
  assert.match(p, /DERNIER message de l'humain/)
  // Et de réclamer une précision plutôt que d'inventer.
  assert.match(p, /plutôt que de deviner/)
})

test('fil vide : la relance reste valide', () => {
  const p = buildFollowUpPrompt(row, [])
  assert.match(p, /DEMANDE INITIALE/)
})

// ── Demandeur remonté jusqu'au journal des nouveautés ─────────────────────────
// Le nom de qui a demandé le changement doit voyager de la file jusqu'au brief :
// c'est la seule façon dont il peut atterrir dans la colonne « Demandé par »
// de /changelog. Pas de demandeur (travail lancé par l'agent) = pas de ligne.

test('le brief nomme le demandeur et dit où le reporter', () => {
  const b = briefFor({ ...row, created_by_name: 'Guillaume Pelletier' })
  assert.match(b, /Importe les tâches du fichier X du Drive\./)
  assert.ok(b.includes(REQUESTER_MARKER))
  assert.match(b, /Guillaume Pelletier/)
  assert.match(b, /requester/)
  assert.match(b, /changelog\.json/)
})

test('sans demandeur, le brief est le prompt nu', () => {
  assert.equal(briefFor(row), row.prompt)
  assert.equal(briefFor({ ...row, created_by_name: '   ' }), row.prompt)
})

test('relance : le demandeur suit le fil', () => {
  const b = briefFor({ ...row, created_by_name: 'Émilie' }, { followUp: true, messages })
  assert.match(b, /DEMANDE INITIALE/)
  assert.match(b, /L'onglet « AL »\./)
  assert.ok(b.includes(REQUESTER_MARKER))
  assert.match(b, /Émilie/)
})

test('pas de compte-rendu mais un rapport : le rapport technique est rendu', async () => {
  const text = await resolveReply({ id: 'inconnue-1', status: 'done', agent_result: 'J\'ai corrigé le tri des colonnes.' })
  assert.match(text, /rapport technique brut/)
  assert.match(text, /corrigé le tri des colonnes/)
})

test('rapport très long : seule la fin (la conclusion) est reprise', async () => {
  const long = `${'x'.repeat(4000)}CONCLUSION FINALE`
  const text = await resolveReply({ id: 'inconnue-2', status: 'done', agent_result: long })
  assert.match(text, /CONCLUSION FINALE/)
  assert.ok(text.length < 2700)
})

test('ni compte-rendu ni rapport : message explicite, pas un placeholder', async () => {
  const done = await resolveReply({ id: 'inconnue-3', status: 'done', agent_result: '(terminé sans rapport)' })
  assert.match(done, /aucun rapport/)
  assert.doesNotMatch(done, /terminé sans compte-rendu/)
  const blocked = await resolveReply({ id: 'inconnue-4', status: 'blocked', agent_result: '' })
  assert.match(blocked, /interrompue/)
})

test('compte-rendu présent : rendu tel quel', async () => {
  const text = await resolveReply({ id: 'inconnue-5', status: 'done', user_summary: 'C\'est réglé.', agent_result: 'blabla technique' })
  assert.equal(text, 'C\'est réglé.')
})

// ── Limite de session Claude ──────────────────────────────────────────────────
// Le quota épuisé n'est pas un échec de la tâche : il ne doit produire ni compte-rendu
// trompeur ni « bloqué ». On vérifie ici la lecture de l'heure de reprise.

test('limite de session : heure de reprise lue en UTC', () => {
  const now = Date.UTC(2026, 7, 4, 1, 30)
  const l = detectSessionLimit("You've hit your session limit · resets 3:40am (UTC)", now)
  assert.equal(l.label, '03:40 UTC')
  assert.equal(l.resetAt, Date.UTC(2026, 7, 4, 3, 40))
})

test('limite de session : heure déjà passée = demain', () => {
  const now = Date.UTC(2026, 7, 4, 5, 0)
  const l = detectSessionLimit("You've hit your session limit · resets 3:40am (UTC)", now)
  assert.equal(l.resetAt, Date.UTC(2026, 7, 5, 3, 40))
})

test('limite de session : pm interprété, heure illisible = repli +1h', () => {
  const now = Date.UTC(2026, 7, 4, 1, 0)
  assert.equal(detectSessionLimit("hit your usage limit · resets 9:05pm (UTC)", now).resetAt,
    Date.UTC(2026, 7, 4, 21, 5))
  const vague = detectSessionLimit("You've hit your session limit", now)
  assert.equal(vague.resetAt, now + 3600_000)
})

test('une vraie erreur d\'exécution n\'est PAS prise pour un quota', () => {
  assert.equal(detectSessionLimit('Error: build failed (exit code: 1)'), null)
  assert.equal(detectSessionLimit(''), null)
})

test('rate_limit_event : « allowed » ignoré, statut de refus = pause jusqu\'à resetsAt', () => {
  const ok = '{"type":"system","subtype":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1785832800}}'
  assert.equal(detectRateLimitEvent(ok), null)
  const ko = ok.replace('"allowed"', '"rejected"')
  const hit = detectRateLimitEvent(ko)
  assert.equal(hit.resetAt, 1785832800 * 1000)
  assert.match(hit.label, /^\d{2}:\d{2} UTC$/)
  // Le dernier événement gagne : un refus suivi d'un « allowed » ne doit pas mettre en pause.
  assert.equal(detectRateLimitEvent(`${ko}\n${ok}`), null)
})

// ── Question de l'agent à l'humain ────────────────────────────────────────────
// Une exécution détachée n'a pas de terminal : elle pose sa question dans une
// section finale, l'ERP l'affiche avec ses choix. L'extraction doit détacher la
// section du rapport (sinon elle finit collée dans le compte-rendu) et survivre
// à un JSON approximatif — une question sans boutons vaut mieux que rien.

test('question extraite et détachée du rapport', () => {
  const raw = `J'ai changé le tri.\n\n${QUESTION_MARKER}\n{"question":"Trier par date ou par montant ?","options":["Par date","Par montant"]}`
  const { text, question } = extractPendingQuestion(raw)
  assert.equal(text, "J'ai changé le tri.")
  assert.equal(question.question, 'Trier par date ou par montant ?')
  assert.deepEqual(question.options, ['Par date', 'Par montant'])
})

test('JSON enrobé dans un bloc de code', () => {
  const raw = `Rapport.\n\n${QUESTION_MARKER}\n\`\`\`json\n{"question":"A ou B ?","options":["A","B"]}\n\`\`\``
  const { question } = extractPendingQuestion(raw)
  assert.equal(question.question, 'A ou B ?')
  assert.deepEqual(question.options, ['A', 'B'])
})

test('JSON illisible : la question brute est conservée, sans choix', () => {
  const raw = `Rapport.\n\n${QUESTION_MARKER}\nFaut-il garder l'ancien comportement ?`
  const { text, question } = extractPendingQuestion(raw)
  assert.equal(text, 'Rapport.')
  assert.equal(question.question, "Faut-il garder l'ancien comportement ?")
  assert.deepEqual(question.options, [])
})

test('pas de section : rapport intact et aucune question', () => {
  const { text, question } = extractPendingQuestion('Tout est fait, rien à demander.')
  assert.equal(text, 'Tout est fait, rien à demander.')
  assert.equal(question, null)
})

test('section vide ou sans question = pas de question', () => {
  assert.equal(extractPendingQuestion(`Rapport.\n\n${QUESTION_MARKER}\n`).question, null)
  assert.equal(extractPendingQuestion(`Rapport.\n\n${QUESTION_MARKER}\n{"options":["A"]}`).question, null)
})

test('au plus 4 options, vides écartées', () => {
  const raw = `R.\n\n${QUESTION_MARKER}\n{"question":"Q ?","options":["1","","2","3","4","5"]}`
  assert.deepEqual(extractPendingQuestion(raw).question.options, ['1', '2', '3', '4'])
})

test('heure à venir : retenue, normalisée en ISO UTC', () => {
  const at = new Date(Date.now() + 3600_000)
  assert.equal(futureStart(at.toISOString()), at.toISOString())
  assert.equal(futureStart(at.toString()), new Date(at.toString()).toISOString())
})

test('heure passée, vide ou illisible : aucun report', () => {
  assert.equal(futureStart(new Date(Date.now() - 1000).toISOString()), null)
  assert.equal(futureStart(null), null)
  assert.equal(futureStart(''), null)
  assert.equal(futureStart('ce soir'), null)
})

// ── Une seule file, plusieurs postes ──────────────────────────────────────────
// Un poste libre prend le premier item de la file, quel qu'il soit.

const q = (id, extra = {}) => ({ id, status: 'queued', start_at: null, same_context: 0, ...extra })
const ids = rows => rows.map(r => r.id)

test('file unique : les postes libres prennent les premiers items, dans l\'ordre', () => {
  const pending = [q('a'), q('b'), q('c')]
  assert.deepEqual(ids(pickNextImplementations(pending, { free: 2 })), ['a', 'b'])
  assert.deepEqual(ids(pickNextImplementations([{ ...q('x'), status: 'running' }, ...pending], { free: 1 })), ['a'])
  assert.deepEqual(ids(pickNextImplementations(pending, { free: 0 })), [])
})

test('départ programmé : jamais avant l\'heure, un seul à la fois', () => {
  const now = Date.parse('2030-01-01T23:00:00.000Z')
  const past = '2030-01-01T22:00:00.000Z'
  const future = '2030-01-02T01:00:00.000Z'
  assert.deepEqual(ids(pickNextImplementations([q('a', { start_at: future }), q('b')], { free: 2, now })), ['b'])
  assert.deepEqual(ids(pickNextImplementations([q('a', { start_at: past }), q('b', { start_at: past }), q('c')], { free: 2, now })), ['a', 'c'])
  const running = { ...q('r', { start_at: past }), status: 'running' }
  assert.deepEqual(ids(pickNextImplementations([running, q('a', { start_at: past }), q('b')], { free: 1, now })), ['b'])
})

test('« même contexte » attend son prédécesseur sans bloquer les suivants', () => {
  const running = { ...q('p'), status: 'running' }
  assert.deepEqual(ids(pickNextImplementations([running, q('s', { same_context: 1 }), q('b')], { free: 1 })), ['b'])
  assert.deepEqual(ids(pickNextImplementations([q('s', { same_context: 1 }), q('b')], { free: 2 })), ['s', 'b'])
})
