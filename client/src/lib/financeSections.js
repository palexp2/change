import {
  Landmark, BookUser, Wallet, CalendarCheck,
  Banknote, ArrowLeftRight, CreditCard, Ship, Megaphone, HardDrive, FlaskConical,
} from 'lucide-react'

// Espace finance — les pages du suivi comptable quotidien, réunies derrière une
// seule entrée de menu qui déploie son sous-menu au survol (voir NavFlyoutItem
// dans components/Layout.jsx). Les liens pointent vers les pages elles-mêmes,
// en pleine largeur : un survol + un clic suffisent, sans page intermédiaire.
//
// Ce module ne contient QUE des métadonnées (pas d'import de page) : il est lu
// par navItems.js et par la palette de recherche, elle-même importée par
// Layout — importer les pages ici créerait un cycle.
export const FINANCE_SECTIONS = [
  { to: '/comptabilite',     label: 'Dashboard comptabilité',   icon: Landmark,       group: 'Pilotage' },

  { to: '/paiements-emis',   label: 'Paiements émis',           icon: Banknote,       group: 'Trésorerie' },
  { to: '/rapprochement',    label: 'Rapprochement bancaire',   icon: ArrowLeftRight, group: 'Trésorerie' },
  { to: '/stripe-payouts',   label: 'Stripe Payouts',           icon: CreditCard,     group: 'Trésorerie' },
  { to: '/comptes-prepayes', label: 'Comptes prépayés',         icon: Wallet,         group: 'Trésorerie' },
  // Le compte CARM de l'ASFC est un compte prépayé : il vit dans un onglet de
  // la page ci-dessus, l'entrée de menu y saute directement.
  { to: '/comptes-prepayes?onglet=douanes', label: 'Douanes (ASFC)', icon: Ship,      group: 'Trésorerie' },

  { to: '/fournisseurs',     label: 'Fournisseurs',             icon: BookUser,       group: 'Fournisseurs & engagements' },
  { to: '/dettes-lt',        label: 'Dettes long terme',        icon: Landmark,       group: 'Fournisseurs & engagements' },
  { to: '/budget-marketing', label: 'Budget marketing',         icon: Megaphone,      group: 'Fournisseurs & engagements' },

  { to: '/fin-de-mois',      label: 'Écritures de fin de mois', icon: CalendarCheck,  group: 'Écritures' },

  { to: '/inventaire-drive', label: 'Inventaire Drive',         icon: HardDrive,      group: 'Pilotage' },

  // Bac à sable : les chantiers en cours de validation avant d'être promus dans
  // leur section définitive (aujourd'hui l'import MAPAQ des exploitations en serre).
  { to: '/tests-antoine',    label: 'Tests – Antoine',          icon: FlaskConical,   group: 'Tests' },
]

// Onglets revendiqués par une entrée de menu, par page (`/page` → ['douanes']).
// Sert à l'état actif de la sidebar : deux entrées visant la même page sur des
// onglets différents ne doivent pas s'allumer ensemble.
export const NAV_TAB_CLAIMS = FINANCE_SECTIONS.reduce((claims, s) => {
  const [path, query] = s.to.split('?')
  const tab = new URLSearchParams(query || '').get('onglet')
  if (tab) (claims[path] ||= []).push(tab)
  return claims
}, {})

// Groupes du sous-menu, dérivés des sections pour qu'ajouter une entrée dans un
// groupe existant suffise.
export const FINANCE_GROUPS = FINANCE_SECTIONS.reduce((groups, s) => {
  const found = groups.find(g => g.label === s.group)
  if (found) found.items.push(s)
  else groups.push({ label: s.group, items: [s] })
  return groups
}, [])

// Compatibilité : la première version de l'Espace finance était une page
// d'accueil à /finance/<section>. Ces URLs redirigent vers la page pleine
// largeur correspondante pour ne casser aucun signet.
export function legacyFinanceTarget(rest) {
  const clean = '/' + String(rest || '').replace(/^\/+|\/+$/g, '')
  const hit = FINANCE_SECTIONS.find(s => clean === s.to || clean.startsWith(s.to + '/'))
  return hit ? clean : '/comptabilite'
}
