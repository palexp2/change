// Moteur de recommandations (page /travaux, onglet « Suggestions de Claude »).
//
// Liste SÉPARÉE de la file humaine : l'agent y dépose des prompts qu'il juge
// pertinents, l'utilisateur les promeut (ou les rejette) — rien ne s'exécute sans
// promotion. Le signal le plus fort vient des travaux récurrents encore faits à la
// main : chaque ligne cochée chaque semaine est un candidat à l'automatisation.
//
// Le modèle n'explore PAS le repo : le contexte lui est fourni ici (git log,
// travaux récurrents, file récente, erreurs de sync). Il tourne donc sans outils,
// en parallèle d'une exécution, sans jamais lire un fichier à moitié écrit.
import { randomUUID, createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { readdirSync } from 'fs'
import db from '../db/database.js'
import { broadcastAll } from './realtime.js'
import { runToollessClaude } from './taskRunner.js'
import { preferredAgentModel } from './agentModel.js'
import { createPrompt } from './promptQueue.js'
import { listRecurringTasks } from './recurringWork.js'

const REPO = '/home/ec2-user/erp'
const MAX_NEW_PER_RUN = 5
const MAX_NEW_INTEGRATIONS_PER_RUN = 3

// Deux natures de suggestions dans la même liste :
//   'chantier'    — un travail à faire dans l'ERP tel qu'il est aujourd'hui ;
//   'integration' — un logiciel / une API externe à brancher, et ce que ça
//                   débloquerait une fois branché.
export const SUGGESTION_KINDS = ['chantier', 'integration']

export function normalizeKind(kind) {
  return SUGGESTION_KINDS.includes(kind) ? kind : 'chantier'
}

// Domaines métier fermés — sert à ranger les suggestions en sous-sections dans
// l'onglet (page /travaux). Le modèle répond en texte libre malgré la consigne
// du prompt (variantes d'accents/casse/synonymes) : on normalise systématiquement
// à l'insertion pour que le regroupement front reste stable. Garder en phase avec
// AREA_LABELS de client/src/pages/Travaux.jsx (même liste, dupliquée côté front).
export const SUGGESTION_AREAS = ['ventes', 'logistique', 'comptabilite', 'rh', 'marketing', 'technique', 'support']

const AREA_KEYWORDS = [
  [/vente|client|pipeline|contact|entreprise|soumission|projet/, 'ventes'],
  [/logistiq|envoi|livraison|transport|retour|expedition|inventaire|entrepot/, 'logistique'],
  [/comptab|finance|facture|paie(?!ment)|tresorerie|banque|taxe|qb|quickbooks/, 'comptabilite'],
  [/\brh\b|ressources humaines|employe|conge|banque d.heures|feuille de temps/, 'rh'],
  [/marketing|campagne|publicite|reseaux sociaux|budget marketing/, 'marketing'],
  [/support|billet|ticket|service client|assistance/, 'support'],
]

/** Fait retomber le texte libre du modèle sur un des SUGGESTION_AREAS ; défaut 'technique'. */
export function normalizeArea(raw) {
  const norm = String(raw || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
  if (SUGGESTION_AREAS.includes(norm)) return norm
  for (const [re, area] of AREA_KEYWORDS) {
    if (re.test(norm)) return area
  }
  return 'technique'
}

function broadcast() { broadcastAll({ type: 'travaux:suggestions:updated' }) }

// Empreinte de déduplication : titre normalisé (accents, ponctuation et casse
// écartés). Une reformulation cosmétique de la même idée ne revient donc pas.
export function fingerprintOf(title) {
  const norm = String(title || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return createHash('sha1').update(norm).digest('hex')
}

export function listSuggestions({ status = null, kind = null } = {}) {
  const where = ['s.deleted_at IS NULL']
  const params = []
  if (status) { where.push('s.status=?'); params.push(status) }
  if (kind) { where.push('s.kind=?'); params.push(kind) }
  // Une suggestion promue vit désormais dans la file (elle y porte sa pastille
  // « Claude ») : on joint quand même l'état de l'item promu, c'est ce qui permet
  // à un appel `status=accepted` de savoir ce qu'elle est devenue.
  // `message_count` : le fil de discussion n'est pas chargé ici (il ne l'est qu'à
  // l'ouverture de la carte), mais la pastille doit pouvoir l'annoncer.
  return db.prepare(`
    SELECT s.*, p.status AS prompt_status, p.space AS prompt_space,
      (SELECT COUNT(*) FROM work_suggestion_messages m
        WHERE m.suggestion_id = s.id AND m.deleted_at IS NULL) AS message_count
    FROM work_suggestions s
    LEFT JOIN work_prompts p ON p.id = s.work_prompt_id AND p.deleted_at IS NULL
    WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC
  `).all(...params).map(s => ({ ...s, chat_pending: _answering.has(s.id) }))
}

export function getSuggestion(id) {
  return db.prepare('SELECT * FROM work_suggestions WHERE id=? AND deleted_at IS NULL').get(id)
}

/** Insère une suggestion ; retourne null si l'empreinte existe déjà (doublon). */
export function addSuggestion({ title, rationale = null, prompt, area = null, kind = 'chantier' }) {
  const t = String(title || '').trim()
  const p = String(prompt || '').trim()
  if (!t || !p) return null
  const fp = fingerprintOf(t)
  const exists = db.prepare('SELECT id FROM work_suggestions WHERE fingerprint=?').get(fp)
  if (exists) return null
  const id = randomUUID()
  db.prepare(`
    INSERT INTO work_suggestions (id, title, rationale, prompt, area, kind, fingerprint)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, t, rationale, p, normalizeArea(area), normalizeKind(kind), fp)
  broadcast()
  return db.prepare('SELECT * FROM work_suggestions WHERE id=?').get(id)
}

/** Promeut une suggestion dans la file de prompts de l'utilisateur. */
export function acceptSuggestion(id, { userId = null, overridePrompt = null, space = 'finance', priority = false } = {}) {
  const s = db.prepare('SELECT * FROM work_suggestions WHERE id=? AND deleted_at IS NULL').get(id)
  if (!s) return null
  if (s.status === 'accepted' && s.work_prompt_id) return { suggestion: s, prompt_id: s.work_prompt_id }
  const created = createPrompt({
    title: s.title,
    prompt: String(overridePrompt || s.prompt),
    created_by: userId,
    suggestion_id: s.id,
    // La suggestion rejoint la file de la section d'où on l'accepte (finance/agent).
    space,
    // Même choix qu'un prompt saisi à la main : en tête ou à la suite.
    priority,
  })
  db.prepare(`UPDATE work_suggestions SET status='accepted', work_prompt_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(created.id, id)
  broadcast()
  return { suggestion: db.prepare('SELECT * FROM work_suggestions WHERE id=?').get(id), prompt_id: created.id }
}

export function dismissSuggestion(id, reason = null) {
  const s = db.prepare('SELECT id FROM work_suggestions WHERE id=? AND deleted_at IS NULL').get(id)
  if (!s) return null
  // Le rejet conserve la ligne (et donc l'empreinte) : la même idée ne sera pas
  // resuggérée au prochain passage du moteur.
  db.prepare(`UPDATE work_suggestions SET status='dismissed', dismissed_reason=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(reason, id)
  broadcast()
  return db.prepare('SELECT * FROM work_suggestions WHERE id=?').get(id)
}

export function deleteSuggestion(id) {
  db.prepare(`UPDATE work_suggestions SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id)
  broadcast()
  return true
}

// ─── Discussion d'une suggestion ──────────────────────────────────────────────
//
// Avant de mettre une suggestion dans sa file (ou de la rejeter), on veut souvent
// en savoir plus : pourquoi maintenant, ce que ça change concrètement, ce que
// coûte l'outil externe d'une intégration, par quoi commencer. Le fil vit sur la
// carte, à côté de la suggestion — il n'exécute RIEN et ne touche pas à la file.
//
// L'échange passe par un appel Claude SANS OUTILS : il tourne donc en parallèle
// d'une implémentation en cours (hors slot global), au prix de ne pas explorer le
// repo — comme le moteur qui a produit la suggestion, il raisonne sur le contexte
// qu'on lui sert ici.

// Suggestions dont une réponse est en vol. Volontairement en mémoire : un
// redémarrage du serveur perd la réponse en cours, et l'utilisateur peut
// simplement reposer sa question au lieu d'attendre un fil bloqué à vie.
const _answering = new Set()

function broadcastChat(suggestionId) {
  broadcastAll({ type: 'travaux:suggestion:messages', suggestion_id: suggestionId })
}

export function listSuggestionMessages(id) {
  return db.prepare(`
    SELECT id, suggestion_id, role, text, author, created_at
    FROM work_suggestion_messages
    WHERE suggestion_id=? AND deleted_at IS NULL
    ORDER BY created_at, rowid
  `).all(id)
}

export function isAnswering(id) { return _answering.has(id) }

export function addSuggestionMessage(suggestionId, { role, text, author = null }) {
  const t = String(text || '').trim()
  if (!t) return null
  const id = randomUUID()
  db.prepare(`
    INSERT INTO work_suggestion_messages (id, suggestion_id, role, text, author)
    VALUES (?,?,?,?,?)
  `).run(id, suggestionId, role === 'agent' ? 'agent' : 'user', t, author)
  return db.prepare('SELECT * FROM work_suggestion_messages WHERE id=?').get(id)
}

/** Prompt de discussion — pur, pour rester testable sans appeler le modèle. */
export function buildSuggestionChatPrompt({ suggestion, thread, digest = '' }) {
  const isIntegration = suggestion.kind === 'integration'
  return [
    'Tu es l\'agent de l\'ERP Orisha (PME québécoise qui conçoit, fabrique et vend en direct des produits IoT ',
    'de contrôle climatique pour serres). Son ERP interne single-tenant couvre marketing, ventes, logistique, ',
    'assemblage, comptabilité, RH et dashboards.\n\n',
    isIntegration
      ? 'Tu as proposé de brancher un outil externe à cet ERP. L\'utilisateur veut en savoir plus AVANT de décider.\n\n'
      : 'Tu as proposé un chantier à faire dans cet ERP. L\'utilisateur veut en savoir plus AVANT de décider.\n\n',
    `Nature : ${isIntegration ? 'intégration (outil / API externe à brancher)' : 'chantier (travail dans l\'ERP tel qu\'il est)'}\n`,
    `Titre : ${suggestion.title}\n`,
    suggestion.area ? `Domaine : ${suggestion.area}\n` : '',
    suggestion.rationale ? `Pourquoi tu l'as proposée : ${suggestion.rationale}\n` : '',
    `\nPrompt d'implémentation prévu (ce qui serait donné à l'agent si l'utilisateur l'accepte) :\n${suggestion.prompt}\n\n`,
    digest ? `Contexte de l'ERP :\n${digest}\n\n` : '',
    'Discussion en cours (« Humain » = l\'utilisateur, « Toi » = tes réponses précédentes) :\n',
    thread || '(aucun échange)', '\n\n',
    'Réponds à la DERNIÈRE question de l\'humain, en français, sur un ton direct et concret. Règles :\n',
    '- Réponse courte : 2 à 6 phrases, ou une liste de puces courtes. Va au point.\n',
    '- Tu n\'as PAS lu le code ici : si la réponse dépend d\'un détail d\'implémentation que tu ne connais pas, dis-le franchement plutôt que d\'inventer.\n',
    '- Parle de ce que ça change pour Orisha (temps gagné, erreurs évitées, ce qui reste manuel), pas de généralités.\n',
    isIntegration ? '- Si on te demande le coût ou l\'authentification d\'un outil, donne ton meilleur ordre de grandeur en disant que c\'est à vérifier.\n' : '',
    '- Ne prétends jamais avoir implémenté quoi que ce soit : cette discussion ne modifie rien. Si l\'utilisateur veut avancer, il ajoute la suggestion à sa file.\n',
    '- Réponds uniquement par ton message, sans préambule ni signature.',
  ].join('')
}

function chatDigest(suggestion) {
  try {
    if (suggestion.kind === 'integration') {
      const d = buildIntegrationDigest()
      return [
        `Outils déjà branchés (OAuth) :\n${d.oauth || '(aucun)'}`,
        `Outils déjà branchés (clés d'API) :\n${d.envTools || '(aucun)'}`,
        `Pages de l'ERP :\n${d.pages || '(inconnu)'}`,
        `Travaux encore faits à la main :\n${d.recurring || '(aucun)'}`,
      ].join('\n\n')
    }
    const d = buildContextDigest()
    return [
      `Travaux encore faits à la main :\n${d.recurring || '(aucun)'}`,
      `Chantiers récents (commits) :\n${d.gitLog || '(aucun)'}`,
      d.syncErrors ? `Erreurs de synchronisation récentes :\n${d.syncErrors}` : '',
    ].filter(Boolean).join('\n\n')
  } catch { return '' }
}

/**
 * Question de l'utilisateur sur une suggestion : le message est enregistré tout de
 * suite (la carte l'affiche), la réponse arrive plus tard par diffusion temps réel.
 * Retourne { error } plutôt que de lever — les routes rendent une erreur uniforme.
 */
export function askSuggestion(id, { text, userId = null } = {}) {
  const s = getSuggestion(id)
  if (!s) return null
  const t = String(text || '').trim()
  if (!t) return { error: 'empty' }
  if (_answering.has(id)) return { error: 'busy' }

  addSuggestionMessage(id, { role: 'user', text: t, author: userId })
  _answering.add(id)
  broadcastChat(id)

  // Réponse en arrière-plan : la route a déjà rendu la main.
  ;(async () => {
    let reply = ''
    try {
      const thread = listSuggestionMessages(id)
        .map(m => `${m.role === 'user' ? 'Humain' : 'Toi'}: ${m.text}`)
        .join('\n')
      const { text: out } = await runToollessClaude({
        prompt: buildSuggestionChatPrompt({ suggestion: s, thread, digest: chatDigest(s) }),
        model: preferredAgentModel(),
        effort: 'medium',
        timeoutMs: 4 * 60_000,
      })
      reply = String(out || '').trim()
    } catch (e) {
      console.error('🤖 Discussion suggestion:', e.message)
    }
    // Toujours écrire un message, même en échec : sans ça le fil resterait en
    // « Claude réfléchit… » sans que l'utilisateur sache qu'il peut réessayer.
    addSuggestionMessage(id, {
      role: 'agent',
      text: reply || 'Je n\'ai pas réussi à répondre (appel au modèle en échec ou trop long). Repose ta question.',
    })
    _answering.delete(id)
    broadcastChat(id)
  })()

  return { messages: listSuggestionMessages(id), pending: true }
}

// ─── Contexte fourni au modèle ────────────────────────────────────────────────

function gitLog(n = 40) {
  try {
    return execFileSync('git', ['log', `-${n}`, '--pretty=format:%ad %s', '--date=short'], { cwd: REPO, encoding: 'utf8' })
  } catch { return '' }
}

export function buildContextDigest() {
  const recurring = listRecurringTasks()
    .map(t => `- [${t.cadence}${t.owner ? '/' + t.owner : ''}] ${t.label}${t.notes ? ` (${t.notes})` : ''}`)
    .join('\n')

  const recentPrompts = db.prepare(`
    SELECT title, status FROM work_prompts WHERE deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 25
  `).all().map(p => `- (${p.status}) ${p.title}`).join('\n')

  const known = db.prepare(`
    SELECT title, status FROM work_suggestions WHERE deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 60
  `).all().map(s => `- ${s.title}`).join('\n')

  let syncErrors = ''
  try {
    syncErrors = db.prepare(`
      SELECT module, error_message FROM sync_log
      WHERE status='error' AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days')
      ORDER BY created_at DESC LIMIT 15
    `).all().map(r => `- ${r.module}: ${String(r.error_message || '').slice(0, 160)}`).join('\n')
  } catch {}

  return { recurring, recentPrompts, known, gitLog: gitLog(), syncErrors }
}

const SUGGESTION_PROMPT = ({ recurring, recentPrompts, known, gitLog: log, syncErrors }) => [
  'Tu observes l\'évolution de l\'ERP Orisha (app single-tenant : ventes, logistique, assemblage, comptabilité, RH). ',
  'Ton rôle ici est de RECOMMANDER des prochains chantiers, pas de coder.\n\n',
  'Signal le plus important — les travaux que l\'utilisateur fait ENCORE À LA MAIN chaque semaine/mois/trimestre :\n',
  recurring || '(aucun)', '\n\n',
  'Chantiers récents (commits) :\n', log || '(aucun)', '\n\n',
  'Prompts récents de l\'utilisateur (sa direction actuelle) :\n', recentPrompts || '(aucun)', '\n\n',
  syncErrors ? `Erreurs de synchronisation des 14 derniers jours :\n${syncErrors}\n\n` : '',
  'Suggestions DÉJÀ proposées (ne les répète pas, même reformulées) :\n', known || '(aucune)', '\n\n',
  `Propose au maximum ${MAX_NEW_PER_RUN} nouveaux chantiers, classés du plus utile au moins utile. `,
  'Privilégie : automatiser un travail manuel récurrent listé plus haut, fermer une boucle laissée ouverte par un chantier récent, ',
  'ou supprimer une source d\'erreur récurrente. Chaque suggestion doit être réalisable en une seule séance de travail. ',
  'Couvre autant de domaines différents que possible plutôt que d\'empiler plusieurs idées dans le même domaine — l\'utilisateur ',
  'consulte ces suggestions rangées par domaine et veut voir chaque section nourrie, pas une seule qui déborde.\n\n',
  'Réponds UNIQUEMENT par un tableau JSON, sans texte autour, de la forme :\n',
  `[{"title":"titre court","area":"${SUGGESTION_AREAS.join('|')}","rationale":"pourquoi maintenant, 1-2 phrases",`,
  '"prompt":"le prompt complet à donner à un agent qui implémentera le chantier, en français, précis sur le comportement attendu"}]\n',
  'Si tu n\'as rien de solide à proposer, réponds [].',
].join('')

/** Extrait le tableau JSON de la réponse, tolérant à un éventuel enrobage. */
export function parseSuggestionsJson(text) {
  const raw = String(text || '').trim()
  const candidates = []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) candidates.push(fenced[1])
  const bracket = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)
  if (bracket) candidates.push(bracket)
  candidates.push(raw)
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      if (Array.isArray(parsed)) return parsed
    } catch {}
  }
  return []
}

/**
 * Un passage du moteur : demande des recommandations et insère les nouvelles.
 * Idempotent par empreinte de titre — repasser deux fois n'empile pas de doublons.
 */
export async function generateSuggestions() {
  const digest = buildContextDigest()
  const { text } = await runToollessClaude({
    prompt: SUGGESTION_PROMPT(digest),
    model: preferredAgentModel(),
    effort: 'high',
    timeoutMs: 6 * 60_000,
  })
  const items = parseSuggestionsJson(text).slice(0, MAX_NEW_PER_RUN)
  let added = 0
  for (const it of items) {
    if (addSuggestion({ title: it.title, rationale: it.rationale, prompt: it.prompt, area: it.area })) added++
  }
  console.log(`🤖 Suggestions de travaux : ${items.length} proposée(s), ${added} nouvelle(s)`)
  return { proposed: items.length, added }
}

// ─── Second moteur : logiciels / API à brancher ───────────────────────────────
//
// Même liste, autre question : « qu'est-ce qu'on gagnerait à connecter un outil
// externe de plus ? ». Le modèle a besoin de savoir ce qui est DÉJÀ branché,
// sinon il repropose Stripe et QuickBooks — d'où l'inventaire ci-dessous, monté
// depuis les connexions OAuth réelles et les clés d'API présentes (jamais leur
// valeur, seulement leur présence).

// Vendeurs dont une clé en environnement vaut « déjà intégré ». Liste explicite :
// on n'énumère pas process.env à l'aveugle.
const ENV_VENDORS = [
  ['Stripe', 'STRIPE_SECRET_KEY'],
  ['QuickBooks', 'QB_CLIENT_ID'],
  ['Airtable', 'AIRTABLE_CLIENT_ID'],
  ['Google (Gmail/Drive/Sheets)', 'GOOGLE_CLIENT_ID'],
  ['HubSpot', 'HUBSPOT_CLIENT_ID'],
  ['Postmark (envoi de courriels)', 'POSTMARK_API_KEY'],
  ['OpenAI', 'OPENAI_API_KEY'],
  ['Novoxpress (transporteurs)', 'NOVOXPRESS_API_KEY'],
  ['Twilio', 'TWILIO_AUTH_TOKEN'],
  ['Amazon Business', 'AMAZON_CLIENT_ID'],
  ['Slack (webhook entrant)', 'SLACK_WEBHOOK_PERSO'],
  ['Ingestion FTP (Cube ARC, étiquettes)', 'FTP_INGEST_SECRET'],
]

/** Inventaire des outils externes déjà branchés, pour ne pas les reproposer. */
export function buildIntegrationDigest() {
  let oauth = ''
  try {
    oauth = db.prepare(`
      SELECT connector, account_email FROM connector_oauth ORDER BY connector
    `).all().map(r => `- ${r.connector}${r.account_email ? ` (${r.account_email})` : ''}`).join('\n')
  } catch {}

  const envTools = ENV_VENDORS
    .filter(([, key]) => String(process.env[key] || '').trim())
    .map(([label]) => `- ${label}`).join('\n')

  // Périmètre fonctionnel couvert : les pages de l'app suffisent à situer ce que
  // l'ERP fait déjà, sans faire lire le code au modèle.
  let pages = ''
  try {
    pages = readdirSync(`${REPO}/client/src/pages`)
      .filter(f => f.endsWith('.jsx'))
      .map(f => f.replace(/\.jsx$/, ''))
      .join(', ')
  } catch {}

  const recurring = listRecurringTasks()
    .map(t => `- [${t.cadence}${t.owner ? '/' + t.owner : ''}] ${t.label}`)
    .join('\n')

  const known = db.prepare(`
    SELECT title FROM work_suggestions WHERE deleted_at IS NULL AND kind='integration'
    ORDER BY created_at DESC LIMIT 60
  `).all().map(s => `- ${s.title}`).join('\n')

  return { oauth, envTools, pages, recurring, known }
}

const INTEGRATION_PROMPT = ({ oauth, envTools, pages, recurring, known }) => [
  'Orisha conçoit, fabrique et vend en direct des produits IoT de contrôle climatique pour serres (Québec, clients CA/US). ',
  'Son ERP interne single-tenant couvre marketing, ventes, logistique, assemblage, comptabilité, RH et dashboards.\n\n',
  'Ta mission ici : proposer des LOGICIELS ou des API EXTERNES à brancher à cet ERP, et ce que chaque branchement débloquerait concrètement. ',
  'Tu ne codes pas, tu recommandes.\n\n',
  'Déjà branché — connexions OAuth actives :\n', oauth || '(aucune)', '\n\n',
  'Déjà branché — clés d\'API présentes :\n', envTools || '(aucune)', '\n\n',
  'Périmètre fonctionnel actuel (pages de l\'ERP) :\n', pages || '(inconnu)', '\n\n',
  'Travaux encore faits À LA MAIN chaque semaine/mois (souvent le meilleur candidat à un branchement) :\n',
  recurring || '(aucun)', '\n\n',
  'Intégrations DÉJÀ proposées (ne les répète pas, même reformulées) :\n', known || '(aucune)', '\n\n',
  `Propose au maximum ${MAX_NEW_INTEGRATIONS_PER_RUN} intégrations, de la plus utile à la moins utile. Règles :\n`,
  '- Ne propose JAMAIS un outil déjà branché ci-dessus (Stripe, QuickBooks, Airtable, Google, HubSpot, Postmark, OpenAI, Novoxpress… selon les listes).\n',
  '- L\'outil doit avoir une API publique documentée et un intérêt réel pour une PME manufacturière IoT de cette taille — pas de suite entreprise hors de prix, pas de gadget.\n',
  '- Dis ce que ça remplace ou automatise pour Orisha, pas ce que l\'outil fait en général.\n',
  '- Chaque intégration doit tenir dans une seule séance de travail pour une première version utile (un flux, une direction), pas un chantier de six mois.\n\n',
  'Réponds UNIQUEMENT par un tableau JSON, sans texte autour, de la forme :\n',
  `[{"title":"Connecter <outil> — <ce que ça débloque>","area":"${SUGGESTION_AREAS.join('|')}",`,
  '"rationale":"ce que ça remplace/automatise chez Orisha et pourquoi maintenant, 1-3 phrases, en mentionnant le coût et le type d\'authentification (OAuth, clé d\'API) si tu le sais",',
  '"prompt":"le prompt complet à donner à un agent qui implémentera une première version utile : quel flux, dans quel sens, quelles pages/tables de l\'ERP touchées, quel comportement attendu"}]\n',
  'Si tu n\'as rien de solide à proposer, réponds [].',
].join('')

/** Un passage du moteur « intégrations ». Même déduplication par empreinte. */
export async function generateIntegrationSuggestions() {
  const digest = buildIntegrationDigest()
  const { text } = await runToollessClaude({
    prompt: INTEGRATION_PROMPT(digest),
    model: preferredAgentModel(),
    effort: 'high',
    timeoutMs: 6 * 60_000,
  })
  const items = parseSuggestionsJson(text).slice(0, MAX_NEW_INTEGRATIONS_PER_RUN)
  let added = 0
  for (const it of items) {
    if (addSuggestion({ title: it.title, rationale: it.rationale, prompt: it.prompt, area: it.area, kind: 'integration' })) added++
  }
  console.log(`🔌 Suggestions d'intégrations : ${items.length} proposée(s), ${added} nouvelle(s)`)
  return { proposed: items.length, added }
}

/**
 * Passage complet : les deux moteurs, en séquence (un seul appel modèle à la
 * fois — `runToollessClaude` démarre un vrai process). `kind` restreint à un
 * moteur ; sans `kind`, les deux tournent.
 */
export async function runSuggestionEngines({ kind = null } = {}) {
  const out = {}
  if (kind !== 'integration') out.chantiers = await generateSuggestions()
  if (kind !== 'chantier') out.integrations = await generateIntegrationSuggestions()
  return out
}
