// Vocabulaire du journal des problèmes d'opérations (/problemes-operations).
// Partagé par la liste, la fiche et les métadonnées de colonnes (tableDefs.js)
// — les choix d'un select ne doivent exister qu'à un seul endroit.

export const OPS_AREAS = [
  'Assemblage', 'Expédition', 'Réception', 'Inventaire', 'Achats',
  'Installation', 'Service client', 'Administration', 'Autre',
]

export const OPS_SEVERITIES = ['Mineur', 'Moyen', 'Bloquant']

export const OPS_STATUSES = ['Ouvert', 'En cours', 'Résolu']

// `SearchableSelect` attend des options { value, label } ; `tableDefs` et
// `RecordForm`, eux, se contentent des libellés bruts ci-dessus.
const asOptions = list => list.map(v => ({ value: v, label: v }))

export const OPS_AREA_OPTIONS = asOptions(OPS_AREAS)
export const OPS_SEVERITY_OPTIONS = asOptions(OPS_SEVERITIES)
export const OPS_STATUS_OPTIONS = asOptions(OPS_STATUSES)

export const OPS_SEVERITY_COLORS = { Mineur: 'slate', Moyen: 'yellow', Bloquant: 'red' }

export const OPS_STATUS_COLORS = { Ouvert: 'red', 'En cours': 'yellow', 'Résolu': 'green' }
