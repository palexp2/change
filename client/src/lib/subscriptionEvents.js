// Source unique de vérité pour les catégories de mouvements d'abonnements.
// Utilisé par AbonnementMouvements (page liste), SubscriptionHistory (fiche
// détail abonnement) et tableDefs (config DataTable).

export const CATEGORIES = ['creation', 'upgrade', 'downgrade', 'churn', 'reactivation']

export const CATEGORY_LABELS = {
  creation:     'Création',
  upgrade:      'Upgrade',
  downgrade:    'Downgrade',
  churn:        'Churn',
  reactivation: 'Réactivation',
}

export const CATEGORY_COLORS = {
  creation:     'green',
  upgrade:      'blue',
  downgrade:    'orange',
  churn:        'red',
  reactivation: 'purple',
}

// Statuts de rachat (post-churn) — utilisés sur la page Mouvements et le panel
// Dashboard. NULL = non vérifié (pas de badge rendu).
export const RACHAT_STATUSES = ['probable', 'confirmed', 'none']

export const RACHAT_LABELS = {
  probable:  'Rachat probable',
  confirmed: 'Rachat confirmé',
  none:      'Pas de rachat',
}

export const RACHAT_COLORS = {
  probable:  'yellow',
  confirmed: 'green',
  none:      'gray',
}
