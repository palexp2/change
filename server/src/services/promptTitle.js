// Titre automatique d'un prompt de la file de travaux.
//
// L'utilisateur écrit (souvent dicte) son prompt comme il l'écrirait dans le
// terminal : plusieurs phrases, du remplissage oral, aucun titre. Jusqu'ici la
// carte affichait les 120 premiers caractères du texte brut — illisible dans la
// file comme dans le recap Slack. Deux étages :
//
//   1. `heuristicTitle()` — synchrone et déterministe : la première phrase
//      nettoyée. Posé à la création, donc jamais de carte sans titre lisible même
//      si le modèle est indisponible.
//   2. `refineTitle()` — un passage modèle sans outils (haiku, effort bas) qui
//      nomme la NATURE de la tâche en une ligne. Best-effort : au moindre doute
//      sur la réponse, on retourne null et l'heuristique reste en place.
//
// Le titre n'est jamais généré quand l'utilisateur en a saisi un (voir
// promptQueue.createPrompt), et une retouche manuelle n'est jamais écrasée.
import { runToollessClaude } from './taskRunner.js'

export const MAX_TITLE_LEN = 80

const TITLE_TIMEOUT_MS = 90_000

/** Coupe au dernier mot entier avant `max`, avec points de suspension. */
function truncateWords(s, max = MAX_TITLE_LEN) {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/, '') + '…'
}

function capitalize(s) {
  return s ? s[0].toLocaleUpperCase('fr-CA') + s.slice(1) : s
}

/**
 * Titre déterministe tiré du prompt : première ligne non vide, débarrassée de sa
 * puce / numérotation, réduite à sa première phrase si elle est longue.
 */
export function heuristicTitle(prompt) {
  const line = String(prompt || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l) || ''

  let t = line
    .replace(/^[-*•>#]+\s*/, '')        // puce ou citation markdown
    .replace(/^\d+[.)]\s+/, '')         // « 1. » / « 2) »
    .replace(/\*\*/g, '')               // gras markdown
    .replace(/\s+/g, ' ')
    .trim()

  // Trop long pour tenir : on garde la première phrase si elle suffit.
  if (t.length > MAX_TITLE_LEN) {
    const m = /[.!?](\s|$)/.exec(t)
    if (m && m.index > 15 && m.index <= MAX_TITLE_LEN) t = t.slice(0, m.index)
  }

  t = truncateWords(t.replace(/[.\s]+$/, ''))
  return capitalize(t) || 'Sans titre'
}

/**
 * Nettoie la réponse du modèle. Retourne null si elle ne ressemble pas à un
 * titre (préambule, refus, JSON, paragraphe) — mieux vaut garder l'heuristique
 * qu'afficher une phrase de conversation en titre de carte.
 */
export function sanitizeModelTitle(text) {
  const first = String(text || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l) || ''

  let t = first
    .replace(/^```.*$/, '')
    .replace(/^(?:titre|title)\s*[:—-]\s*/i, '')
    .replace(/^[«"'`*\s]+|[»"'`*\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.]+$/, '')
    .trim()

  if (t.length < 3) return null
  if (t.length > 140) return null                       // paragraphe, pas un titre
  if (/^[[{]/.test(t)) return null                      // JSON
  if (/\b(je ne peux|désolé|voici (le|un) titre|as an ai)\b/i.test(t)) return null

  return capitalize(truncateWords(t))
}

const TITLE_PROMPT = (prompt) => [
  'Tu nommes une tâche dans la file de travaux d\'un ERP (ventes, logistique, assemblage, comptabilité, RH). ',
  'À partir de la demande ci-dessous, écris UN titre court en français qui reflète la nature de la tâche ',
  '(ce qui va changer et où), au maximum 8 mots. ',
  'Commence par un verbe à l\'infinitif ou un groupe nominal, sans point final, sans guillemets, sans préambule. ',
  'La demande est souvent dictée à la voix : ignore le remplissage oral (« tu comprends », « merci », « dans le fond ») ',
  'et garde uniquement l\'intention.\n\n',
  'Exemples de bons titres : « Titre automatique des prompts de la file », « Corriger l\'erreur à l\'ouverture de la fin de mois », ',
  '« Adapter le formulaire de paiement selon le moyen ».\n\n',
  'Ne réponds QUE par le titre, sur une seule ligne.\n\n',
  '--- Demande ---\n',
  String(prompt || '').slice(0, 4000),
].join('')

/**
 * Titre proposé par le modèle, ou null (échec, timeout, réponse douteuse).
 * Ne lève jamais : l'appelant garde son titre heuristique.
 */
export async function refineTitle(prompt) {
  const text = String(prompt || '').trim()
  if (!text) return null
  try {
    const { text: out } = await runToollessClaude({
      prompt: TITLE_PROMPT(text),
      model: 'haiku',
      effort: 'low',
      timeoutMs: TITLE_TIMEOUT_MS,
    })
    return sanitizeModelTitle(out)
  } catch {
    return null
  }
}

// ─── Titre dynamique : le fil de discussion est le projet ─────────────────────
// Un item de la file n'est pas figé à sa première phrase : l'humain répond, la
// demande se précise ou change de cap, l'agent rend compte. Le titre suit donc le
// FIL et pas seulement le prompt d'origine.

const MSG_MAX_CHARS = 600
const DIGEST_MAX_CHARS = 6000
const MAX_MESSAGES = 12

/**
 * Résumé lisible du fil pour le modèle : la demande d'origine puis les derniers
 * tours dans l'ordre. On garde la FIN du fil (le cap le plus récent l'emporte) et
 * chaque message est écourté — un titre n'a pas besoin des détails.
 */
export function buildThreadDigest(prompt, messages = []) {
  const clip = s => {
    const t = String(s || '').replace(/\s+/g, ' ').trim()
    return t.length > MSG_MAX_CHARS ? t.slice(0, MSG_MAX_CHARS) + '…' : t
  }
  const turns = (Array.isArray(messages) ? messages : [])
    .slice(-MAX_MESSAGES)
    .map(m => `${m.role === 'agent' ? 'Claude' : 'Humain'} : ${clip(m.text)}`)
    .filter(l => l.length > 12)

  const head = `Demande d'origine : ${clip(prompt)}`
  const digest = [head, ...turns].join('\n')
  return digest.length > DIGEST_MAX_CHARS ? '…' + digest.slice(-DIGEST_MAX_CHARS) : digest
}

const PROJECT_TITLE_PROMPT = ({ digest, current }) => [
  'Tu nommes un PROJET dans la file de travaux d\'un ERP (ventes, logistique, assemblage, comptabilité, RH). ',
  'Un projet, ici, c\'est un fil de discussion : une demande d\'origine puis des échanges qui la précisent ',
  'ou la font évoluer.\n\n',
  'Écris le titre qui reflète la nature du projet TEL QU\'IL EST MAINTENANT, au maximum 8 mots, en français. ',
  'Le cap le plus récent de l\'humain compte plus que la formulation d\'origine : si l\'échange a élargi ou ',
  'déplacé la demande, le titre doit le montrer. ',
  'Les messages sont souvent dictés à la voix : ignore le remplissage oral (« tu comprends », « merci », ',
  '« dans le fond ») et garde l\'intention.\n\n',
  current
    ? `Titre actuel : « ${current} ». S'il décrit encore correctement le projet, réponds-le mot pour mot au lieu d'en inventer un autre.\n\n`
    : '',
  'Sans point final, sans guillemets, sans préambule. Ne réponds QUE par le titre, sur une seule ligne.\n\n',
  '--- Fil ---\n',
  digest,
].join('')

/**
 * Titre du projet déduit du fil complet, ou null si le modèle échoue / répond
 * autre chose qu'un titre. Ne lève jamais.
 */
export async function refineProjectTitle({ prompt, messages = [], current = '' }) {
  const digest = buildThreadDigest(prompt, messages)
  if (!digest.trim()) return null
  try {
    const { text: out } = await runToollessClaude({
      prompt: PROJECT_TITLE_PROMPT({ digest, current: String(current || '').trim() }),
      model: 'haiku',
      effort: 'low',
      timeoutMs: TITLE_TIMEOUT_MS,
    })
    return sanitizeModelTitle(out)
  } catch {
    return null
  }
}
