// Préréglage automatique d'un prompt de la file de travaux (« Auto »).
//
// Même mécanique que le titre automatique (promptTitle.js), appliquée au choix
// Rapide / Standard / Approfondi : l'utilisateur n'a plus à juger lui-même le
// calibre de sa demande. Deux étages :
//
//   1. `provisionalPreset()` — synchrone et déterministe : un préréglage sûr posé
//      à la création, pour que l'item soit exécutable même si le modèle est
//      indisponible. Volontairement prudent (jamais « rapide ») : mieux vaut
//      sur-servir une tâche que la confier à un modèle trop petit.
//   2. `classifyPreset()` — un passage modèle sans outils (haiku, effort bas) qui
//      juge le calibre réel de la demande. Best-effort : au moindre doute sur la
//      réponse, on retourne null et le provisoire reste en place.
//
// Le préréglage n'est jamais reclassé quand l'utilisateur en a choisi un à la
// main (voir promptQueue : flag preset_auto, même contrat que title_auto).
import { runToollessClaude } from './taskRunner.js'

export const PRESET_KEYS = ['fast', 'standard', 'deep']

const CLASSIFY_TIMEOUT_MS = 90_000

/**
 * Préréglage provisoire, en attendant (ou à défaut de) la classification modèle.
 * Une question part en « standard » (lecture seule, rarement un chantier) ; une
 * implémentation part en « approfondi » — l'ancien défaut de la file.
 */
export function provisionalPreset(mode) {
  return mode === 'question' ? 'standard' : 'deep'
}

/**
 * Nettoie la réponse du modèle et la ramène à une clé de préréglage. Retourne
 * null si elle n'y ressemble pas (préambule, refus, paragraphe) — mieux vaut
 * garder le provisoire qu'exécuter sur un calibre choisi au hasard.
 */
export function sanitizePresetAnswer(text) {
  const first = String(text || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l) || ''
  const word = first
    .replace(/^[«"'`*\s]+|[»"'`*.\s]+$/g, '')
    .toLowerCase()
  if (['rapide', 'fast', 'haiku'].includes(word)) return 'fast'
  if (['standard', 'sonnet'].includes(word)) return 'standard'
  if (['approfondi', 'approfondie', 'deep', 'fable', 'opus'].includes(word)) return 'deep'
  return null
}

/**
 * Calibre retenu en mode Auto : jamais « rapide » (haiku). Trop d'erreurs sur les
 * tâches qu'il recevait (demande de Pierre-Alexandre Papillon, 2026-09-30) — il
 * reste sélectionnable à la main, pas par le classement automatique.
 */
export function autoPresetFrom(key) {
  return key === 'fast' ? 'standard' : key
}

const CLASSIFY_PROMPT = ({ prompt, mode }) => [
  'Tu calibres une tâche dans la file de travaux d\'un ERP (ventes, logistique, assemblage, ',
  'comptabilité, RH). Deux niveaux d\'exécution existent :\n\n',
  '- STANDARD — modèle intermédiaire. Pour : question simple ou qui demande de lire du code, ',
  'retouche de texte ou de libellé, correctif ou petite fonctionnalité bien délimitée ',
  '(un écran, une route), ajustement d\'un comportement existant.\n',
  '- APPROFONDI — meilleur modèle, effort maximal. Pour : chantier multi-étapes, nouvelle ',
  'fonctionnalité complète, logique comptable ou financière, migration ou refonte, débogage dont ',
  'la cause est inconnue, demande ambiguë ou aux ramifications incertaines.\n\n',
  mode === 'question'
    ? 'La demande ci-dessous est une QUESTION (lecture seule, rien ne sera implémenté).\n'
    : 'La demande ci-dessous est une tâche d\'IMPLÉMENTATION (du code sera modifié).\n',
  'En cas de doute entre deux niveaux, choisis le plus élevé des deux. ',
  'La demande est souvent dictée à la voix : ignore le remplissage oral et juge l\'intention.\n\n',
  'Ne réponds QUE par un seul mot, sur une seule ligne : STANDARD ou APPROFONDI.\n\n',
  '--- Demande ---\n',
  String(prompt || '').slice(0, 4000),
].join('')

/**
 * Préréglage jugé par le modèle ('standard' | 'deep'), ou null (échec,
 * timeout, réponse douteuse). Ne lève jamais : l'appelant garde son provisoire.
 */
export async function classifyPreset({ prompt, mode = 'implement' } = {}) {
  const text = String(prompt || '').trim()
  if (!text) return null
  try {
    const { text: out } = await runToollessClaude({
      prompt: CLASSIFY_PROMPT({ prompt: text, mode }),
      model: 'haiku',
      effort: 'low',
      timeoutMs: CLASSIFY_TIMEOUT_MS,
    })
    return autoPresetFrom(sanitizePresetAnswer(out))
  } catch {
    return null
  }
}
