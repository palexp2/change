import data from '../data/changelog.json'

// Entrées du journal des nouveautés, triées par date décroissante (plus récente
// en premier). Source : client/src/data/changelog.json (fichier versionné).
export const changelogEntries = [...(data.entries || [])].sort((a, b) =>
  a.date < b.date ? 1 : a.date > b.date ? -1 : 0
)
