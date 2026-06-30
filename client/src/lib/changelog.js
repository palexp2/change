import data from '../data/changelog.json'

// Entrées du journal des nouveautés, triées par date décroissante (plus récente
// en premier). Source : client/src/data/changelog.json (fichier versionné).
export const changelogEntries = [...(data.entries || [])].sort((a, b) =>
  a.date < b.date ? 1 : a.date > b.date ? -1 : 0
)

// Date de l'entrée la plus récente (chaîne 'YYYY-MM-DD'), ou null si vide.
export const latestChangelogDate = changelogEntries[0]?.date || null

// localStorage : date de la dernière entrée vue par l'utilisateur. Comme les
// dates sont au format 'YYYY-MM-DD', la comparaison lexicographique suffit.
const LAST_SEEN_KEY = 'erp.changelog.lastSeen'

// Événement émis quand l'utilisateur consulte la page — permet à la sidebar de
// retirer la pastille « nouveautés » sans recharger.
export const CHANGELOG_SEEN_EVENT = 'changelog:seen'

export function getChangelogLastSeen() {
  try {
    return localStorage.getItem(LAST_SEEN_KEY)
  } catch {
    return null
  }
}

// Vrai s'il existe au moins une entrée plus récente que la dernière vue.
export function hasUnseenChangelog() {
  if (!latestChangelogDate) return false
  const seen = getChangelogLastSeen()
  if (!seen) return true
  return latestChangelogDate > seen
}

// Marque le journal comme lu (au niveau de l'entrée la plus récente) et notifie
// les écouteurs (sidebar).
export function markChangelogSeen() {
  if (!latestChangelogDate) return
  try {
    localStorage.setItem(LAST_SEEN_KEY, latestChangelogDate)
  } catch {}
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGELOG_SEEN_EVENT))
  }
}
