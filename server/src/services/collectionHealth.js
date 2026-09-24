// Santé de la collecte de factures — « est-ce que ça marche encore ? »
//
// Le constat qui a motivé ce module : les quatre collecteurs de portails ont
// échoué chaque nuit pendant un mois sans que personne ne l'apprenne. L'état
// existait (scraper_runs, scraper_accounts.last_error) mais il fallait aller
// sur la page pour le voir, et rien n'y poussait.
//
// Ici on résume, en français, ce qu'il faut savoir sans ouvrir la page : quels
// portails sont en panne, depuis quand, et lequel attend un geste humain.
import db from '../db/database.js'
import { SCRAPERS, VENDOR_LABELS } from './scrapers/index.js'

// Au-delà de ça, une session importée est probablement morte : les portails
// renouvellent rarement un témoin de connexion plus longtemps.
export const SESSION_STALE_DAYS = 30

const daysSince = iso => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000) : null)

// Un message d'erreur de collecteur traîne parfois vingt lignes de journal
// Playwright. Le bandeau n'en veut qu'une phrase ; le détail complet reste sur
// la page de collecte, avec la capture d'écran.
function oneLine(text) {
  const first = String(text || '')
    // eslint-disable-next-line no-control-regex -- les journaux Playwright sont colorisés
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')[0]
    .trim()
  return first.length > 120 ? `${first.slice(0, 120)}…` : first
}

/**
 * État de chaque compte de collecte actif.
 * `state` ∈ ok | session_a_envoyer | session_vieillie | casse | jamais_tourne
 */
export function collectionHealth() {
  const accounts = db.prepare(`
    SELECT id, vendor, label, last_status, last_error, last_run_at, last_imported,
           storage_state_at, (storage_state_enc IS NOT NULL) AS has_session
    FROM scraper_accounts
    WHERE deleted_at IS NULL AND enabled = 1
    ORDER BY vendor
  `).all()

  const lastSuccess = db.prepare(`
    SELECT account_id, MAX(started_at) AS at FROM scraper_runs
    WHERE status = 'success' GROUP BY account_id
  `).all()
  const successAt = new Map(lastSuccess.map(r => [r.account_id, r.at]))

  return accounts.map(a => {
    const label = a.label || VENDOR_LABELS[a.vendor] || a.vendor
    const needsSession = !!SCRAPERS[a.vendor]?.requiresImportedSession
    const sessionAge = daysSince(a.storage_state_at)
    let state = 'ok'
    let detail = null

    if (!SCRAPERS[a.vendor]) {
      // Compte laissé par un ancien connecteur : aucun collecteur ne porte ce
      // nom, la tournée échouerait avant de commencer.
      state = 'sans_collecteur'
      detail = "Aucun collecteur ne porte ce nom — compte à retirer de la liste."
    } else if (needsSession && !a.has_session) {
      state = 'session_a_envoyer'
      detail = 'Ce portail refuse toute connexion automatique — envoyer la session depuis le module de navigateur.'
    } else if (a.last_status === 'error') {
      state = 'casse'
      detail = oneLine(a.last_error) || 'La dernière tournée a échoué.'
    } else if (a.last_status === 'needs_otp') {
      state = 'casse'
      detail = 'Un code de vérification est attendu.'
    } else if (!a.last_run_at) {
      state = 'jamais_tourne'
      detail = "Ce portail n'a encore jamais été interrogé."
    } else if (a.has_session && sessionAge != null && sessionAge >= SESSION_STALE_DAYS) {
      state = 'session_vieillie'
      detail = `La session date de ${sessionAge} jours — la renvoyer depuis le module de navigateur.`
    }

    return {
      account_id: a.id,
      vendor: a.vendor,
      label,
      state,
      detail,
      session_required: needsSession,
      has_session: !!a.has_session,
      session_age_days: sessionAge,
      last_run_at: a.last_run_at,
      // Depuis quand plus rien n'est descendu de ce portail.
      days_since_success: daysSince(successAt.get(a.id)),
    }
  })
}

/** Une ligne pour un bandeau : rien à dire → null. */
export function collectionHealthSummary() {
  const rows = collectionHealth()
  const broken = rows.filter(r => r.state !== 'ok')
  if (!broken.length) return null
  const needSession = broken.filter(r => r.state.startsWith('session'))
  return {
    total: rows.length,
    broken: broken.length,
    portals: broken.map(r => r.label),
    // Ce qui attend un geste : c'est le seul cas où l'utilisateur peut agir tout de suite.
    awaiting_human: needSession.map(r => r.label),
  }
}
