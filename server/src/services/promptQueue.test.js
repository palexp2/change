import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFollowUpPrompt, buildRecapMessage, resolveReply } from './promptQueue.js'
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

// ── Recap Slack ───────────────────────────────────────────────────────────────

test('recap terminé : une ligne, coche verte et titre', () => {
  const msg = buildRecapMessage({ status: 'done', title: 'Import X' }, { user_summary: 'C\'est fait.' })
  assert.match(msg, /white_check_mark/)
  assert.match(msg, /Import X/)
  assert.equal(msg.includes('\n'), false, 'le recap doit tenir sur une seule ligne')
})

test('recap : jamais de compte-rendu du travail (il vit dans le fil de l\'ERP)', () => {
  const msg = buildRecapMessage({ status: 'done', title: 'Import X' }, { user_summary: 'J\'ai corrigé le tri des achats.' })
  assert.doesNotMatch(msg, /corrigé le tri/)
  assert.ok(msg.length < 300, `recap trop long (${msg.length})`)
})

test('recap bloqué : triangle d\'avertissement et lien pour répondre', () => {
  const msg = buildRecapMessage({ status: 'blocked', title: 'Import X' }, { user_summary: 'Quel onglet ?' })
  assert.match(msg, /warning/)
  assert.match(msg, /travaux\?onglet=file/)
})

test('recap : « arrêter après celle-ci » annonce la pause sur la même ligne', () => {
  const msg = buildRecapMessage({ status: 'done', title: 'Import X' }, { user_summary: 'Fait.' }, { stopped: true })
  assert.match(msg, /file en pause/)
  assert.equal(msg.includes('\n'), false)
})

// ── Compte-rendu du fil ───────────────────────────────────────────────────────
// Le fil ne doit JAMAIS se retrouver avec un placeholder : c'était le bug — le
// compte-rendu de secours arrivait après l'écriture du message et personne ne
// voyait plus ce qui avait été fait.
// NB : ces tâches n'existent pas dans le store de l'agent, la génération de secours
// se termine donc immédiatement sans lancer de subprocess.

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

test('recap Slack : une question en attente change le titre et l\'appel à l\'action', () => {
  const prompt = { status: 'done', title: 'Tri des achats' }
  const task = { user_summary: 'Fait.', pending_question: { question: 'Date ou montant ?', options: [] } }
  const msg = buildRecapMessage(prompt, task)
  assert.match(msg, /Question à répondre/)
  assert.match(msg, /Répondre/)
  // La question elle-même reste dans le fil : le DM dit seulement qu'il y en a une.
  assert.doesNotMatch(msg, /Date ou montant/)
  // Sans question, le recap annonce simplement la fin de la tâche.
  assert.match(buildRecapMessage(prompt, { user_summary: 'Fait.' }), /Tâche terminée/)
})
