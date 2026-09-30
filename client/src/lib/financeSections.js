import {
  Landmark, BookUser, Wallet, CalendarCheck, CalendarClock,
  Banknote, ArrowLeftRight, CreditCard, Ship, Megaphone, HardDrive, FlaskConical, Wand2,
  FileText, Tag, RefreshCw, ReceiptText, BookOpen,
} from 'lucide-react'

// Espace finance — les pages du suivi comptable quotidien, réunies derrière une
// seule entrée de menu qui déploie son sous-menu au survol (voir NavFlyoutItem
// dans components/Layout.jsx). Les liens pointent vers les pages elles-mêmes,
// en pleine largeur : un survol + un clic suffisent, sans page intermédiaire.
//
// Ce module ne contient QUE des métadonnées (pas d'import de page) : il est lu
// par navItems.js et par la palette de recherche, elle-même importée par
// Layout — importer les pages ici créerait un cycle.
// Le dashboard comptabilité n'a plus d'entrée ici : c'est la destination de
// l'entrée « Espace finance » elle-même (un clic dessus y mène, le survol
// continue d'ouvrir ce sous-menu).
export const FINANCE_SECTIONS = [
  { to: '/paiements-emis',   label: 'Paiements émis',           icon: Banknote,       group: 'Trésorerie' },
  { to: '/rapprochement',    label: 'Transactions bancaires',  icon: ArrowLeftRight, group: 'Trésorerie' },
  { to: '/regles-bancaires', label: 'Règles bancaires',         icon: Wand2,          group: 'Trésorerie' },
  { to: '/stripe-payouts',   label: 'Versements Stripe',        icon: CreditCard,     group: 'Trésorerie' },
  { to: '/comptes-prepayes', label: 'Comptes prépayés',         icon: Wallet,         group: 'Trésorerie' },
  { to: '/cartes-paiement',  label: 'Cartes de paiement',       icon: CreditCard,     group: 'Trésorerie' },
  // Le compte CARM de l'ASFC est un compte prépayé : il vit dans un onglet de
  // la page ci-dessus, l'entrée de menu y saute directement.
  { to: '/comptes-prepayes?onglet=douanes', label: 'Douanes (ASFC)', icon: Ship,      group: 'Trésorerie' },

  // Anciennes entrées à plat du groupe Comptabilité, rangées ici depuis que le
  // survol de l'icône Comptabilité montre directement ce sous-menu.
  { to: '/factures',         label: 'Factures clients',         icon: FileText,       group: 'Ventes' },
  { to: '/paiements',        label: 'Paiements',                icon: Banknote,       group: 'Ventes' },
  { to: '/items-vendus',     label: 'Items vendus',             icon: Tag,            group: 'Ventes' },
  { to: '/abonnements',      label: 'Abonnements',              icon: RefreshCw,      group: 'Ventes' },
  { to: '/abonnements/mouvements', label: "Mouvements d'abonnements", icon: RefreshCw, group: 'Ventes' },

  { to: '/fournisseurs',     label: 'Fournisseurs',             icon: BookUser,       group: 'Fournisseurs & engagements' },
  { to: '/dettes-lt',        label: 'Dettes long terme',        icon: Landmark,       group: 'Fournisseurs & engagements' },
  { to: '/budget-marketing', label: 'Budget marketing',         icon: Megaphone,      group: 'Fournisseurs & engagements' },
  // La collecte de factures est un onglet de cette page (lib/navSubsections.js).
  { to: '/sale-receipts',    label: 'Extraction de données',    icon: ReceiptText,    group: 'Fournisseurs & engagements' },

  { to: '/journal-entries',  label: 'Écritures de journal',     icon: BookOpen,       group: 'Écritures' },
  { to: '/fin-de-mois',      label: 'Écritures de fin de mois', icon: CalendarCheck,  group: 'Écritures' },
  { to: '/revenus-reportes', label: "Revenus perçus d'avance",   icon: CalendarClock,  group: 'Écritures' },
  { to: '/comptabilite/regles-serials', label: 'Mouvements numéros de série', icon: BookOpen, group: 'Écritures' },
  { to: '/stock-movement',   label: "Mouvements d'inventaire",  icon: ArrowLeftRight, group: 'Écritures' },

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

// Le menu ne montre plus les 23 pages : il en montre 9 « regroupements », et les
// pages d'un regroupement deviennent des onglets en haut de chacune d'elles
// (components/FinanceHubTabs.jsx). Chaque page garde sa propre URL.
const HUB_DEFS = [
  { label: 'Banque',            icon: ArrowLeftRight, group: 'Trésorerie', pages: [
    ['/rapprochement', 'Transactions'], ['/rapprochement-qbo', 'Rapprochement'],
    ['/paiements-emis', 'Paiements émis'], ['/regles-bancaires', 'Règles'],
    ['/sale-receipts', 'Extraction de données'] ] },
  { label: 'Comptes & cartes',  icon: Wallet,         group: 'Trésorerie', pages: [
    ['/comptes-prepayes', 'Comptes prépayés'], ['/comptes-prepayes?onglet=douanes', 'Douanes (ASFC)'],
    ['/cartes-paiement', 'Cartes de paiement'] ] },
  { label: 'Ventes',            icon: FileText,       group: 'Ventes', pages: [
    ['/factures', 'Factures clients'], ['/items-vendus', 'Items vendus'],
    ['/paiements', 'Paiements'], ['/stripe-payouts', 'Versements Stripe'] ] },
  { label: 'Abonnements',       icon: RefreshCw,      group: 'Ventes', pages: [
    ['/abonnements', 'Abonnements'], ['/abonnements/mouvements', 'Mouvements'] ] },
  { label: 'Achats',            icon: BookUser,       group: 'Achats', pages: [
    ['/fournisseurs', 'Fournisseurs'], ['/dettes-lt', 'Dettes long terme'],
    ['/budget-marketing', 'Budget marketing'] ] },
  { label: 'Écritures',         icon: BookOpen,       group: 'Livres', pages: [
    ['/journal-entries', 'Journal'], ['/fin-de-mois', 'Fin de mois'],
    ['/revenus-reportes', "Revenus perçus d'avance"] ] },
  { label: 'Inventaire',        icon: HardDrive,      group: 'Livres', pages: [
    ['/stock-movement', "Mouvements d'inventaire"], ['/comptabilite/regles-serials', 'Numéros de série'],
    ['/inventaire-drive', 'Inventaire Drive'] ] },
  { label: 'Tests – Antoine',   icon: FlaskConical,   group: 'Tests', hidden: true, pages: [
    ['/tests-antoine', 'Import MAPAQ (serres)'], ['/tests-antoine/carte', 'Carte des clients'] ] },
]

// Entrée de menu d'un regroupement : mène à sa première page ; `hubPages`
// sert à l'état actif, au sous-menu au survol et à la recherche.
export const FINANCE_HUBS = HUB_DEFS.map(h => {
  const hubPages = h.pages.map(([to, label]) => ({
    to, label, icon: FINANCE_SECTIONS.find(s => s.to === to)?.icon || h.icon,
  }))
  return { to: hubPages[0].to, label: h.label, icon: h.icon, group: h.group, hidden: h.hidden, hubPages }
})

// Regroupement (et onglet) de la page courante. Le chemin le plus long gagne
// (`/abonnements/mouvements` ≠ `/abonnements`) ; un onglet `?onglet=` visé par
// une entrée (Douanes) l'emporte sur la page nue.
export function findFinanceHub(pathname, search = '') {
  const currentTab = new URLSearchParams(search).get('onglet')
  let best = null
  for (const hub of FINANCE_HUBS) {
    for (const page of hub.hubPages) {
      const [path, query] = page.to.split('?')
      if (pathname !== path && !pathname.startsWith(path + '/')) continue
      const tab = new URLSearchParams(query || '').get('onglet')
      if (tab && tab !== currentTab) continue
      if (!tab && (NAV_TAB_CLAIMS[path] || []).includes(currentTab)) continue
      const score = path.length * 2 + (tab ? 1 : 0)
      if (!best || score > best.score) best = { hub, page, score }
    }
  }
  return best
}

// Groupes du sous-menu, dérivés des regroupements. Un regroupement `hidden`
// (Tests – Antoine) garde ses onglets mais n'est pas au menu : on y entre par
// l'icône discrète à côté du titre de la page Comptabilité.
export const FINANCE_GROUPS = FINANCE_HUBS.filter(h => !h.hidden).reduce((groups, s) => {
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
