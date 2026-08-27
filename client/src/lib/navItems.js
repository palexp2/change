import {
  LayoutDashboard,
  TrendingUp, ShoppingCart, Package, LifeBuoy,
  ShoppingBag, Truck, RotateCcw, FileText, RefreshCw, Wrench,
  Barcode, MessageSquare, CheckSquare,
  Receipt, ReceiptText, Landmark, Users, Banknote, Contact, BookOpen,
  ArrowLeftRight, Clock, Tag, Wallet, Mail, PhoneCall,
  FolderOpen, Building2, ListChecks, Bot, Activity, Zap, Plug, Instagram
} from 'lucide-react'
import { FINANCE_GROUPS } from './financeSections.js'

// Structure canonique du menu de gauche, partagée entre la sidebar (Layout)
// et la page Paramètres (customisation afficher/cacher).
//
// Clés de customisation (cf. nav_hidden / navPrefs) :
//   - item à plat ou sous-item d'un groupe → clé = `item.to`
//   - groupe entier → clé = `group:<group>`
//
// Ordre personnalisé (cf. nav_order / navPrefs) : objet
// { root: [clés], 'group:<nom>': [clés] } — clé d'un item = `to` (ou `href`
// pour un lien externe), clé d'un groupe = `group:<nom>`. Sémantique partielle :
// toute clé absente de la liste garde sa position par défaut, à la suite.
export function navKey(item) {
  if (item.group) return `group:${item.group}`
  return item.to || item.href
}

function sortByKeys(list, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return list
  const rank = new Map(keys.map((k, i) => [k, i]))
  // Tri stable : les clés inconnues (nouvelle entrée ajoutée au code depuis)
  // conservent leur ordre par défaut, après les clés explicitement ordonnées.
  const unknown = keys.length
  const rankOf = (item) => (rank.has(navKey(item)) ? rank.get(navKey(item)) : unknown)
  return [...list].sort((a, b) => rankOf(a) - rankOf(b))
}

// Applique l'ordre personnalisé aux sections et à leurs sous-items.
export function applyNavOrder(items, order) {
  if (!order || typeof order !== 'object') return items
  return sortByKeys(items, order.root).map(item => (
    item.items ? { ...item, items: sortByKeys(item.items, order[navKey(item)]) } : item
  ))
}

export const defaultNavItems = [
  { to: '/dashboard',    icon: LayoutDashboard, label: 'Dashboard' },
  { group: 'Clients', icon: Contact, items: [
    { to: '/contacts',     icon: Contact,       label: 'Contacts' },
    { to: '/companies',    icon: Building2,     label: 'Entreprises' },
    { to: '/pipeline',     icon: TrendingUp,    label: 'Projets' },
    { to: '/tasks',        icon: CheckSquare,   label: 'Tâches' },
    { to: '/tickets',      icon: LifeBuoy,      label: 'Billets' },
    { to: '/interactions', icon: MessageSquare, label: 'Interactions' },
    { to: '/qualification-call', icon: PhoneCall, label: 'Appels de qualification' },
    { to: '/relance-qualification', icon: Mail, label: 'Relances qualification' },
    { to: '/discovery-forms', icon: FileText, label: 'Formulaires de découverte' },
    { to: '/prospects-instagram', icon: Instagram, label: 'Prospects Instagram' },
  ]},
  { group: 'Envois', icon: Truck, items: [
    { to: '/orders',   icon: ShoppingCart, label: 'Commandes' },
    { to: '/envois',   icon: Truck,        label: 'Envois' },
    { to: '/retours',  icon: RotateCcw,    label: 'Retours' },
  ]},
  { group: 'Comptabilité', icon: Landmark, items: [
    // Espace finance, en tête du groupe : hub du suivi comptable quotidien.
    // `flyoutGroups` en fait une entrée qui déploie ses sections dans un
    // panneau flottant au survol (NavFlyoutItem) au lieu de mener à une page —
    // les liens vont droit aux pages, en pleine largeur. Sections définies dans
    // lib/financeSections.js.
    { to: '/finance',               icon: Landmark,   label: 'Espace finance', flyoutGroups: FINANCE_GROUPS },
    { to: '/factures',              icon: FileText,   label: 'Factures clients' },
    { to: '/paiements',             icon: Banknote,   label: 'Paiements' },
    { to: '/items-vendus',          icon: Tag,        label: 'Items vendus' },
    { to: '/abonnements',           icon: RefreshCw,  label: 'Abonnements' },
    { to: '/abonnements/mouvements', icon: RefreshCw, label: "Mouvements d'abonnements" },
    { to: '/sale-receipts',         icon: ReceiptText,label: 'Extraction de données' },
    { to: '/journal-entries',       icon: BookOpen,   label: 'Écritures de journal' },
    { to: '/comptabilite/regles-serials', icon: BookOpen, label: 'Mouvements numéros de série' },
    { to: '/stock-movement',        icon: ArrowLeftRight, label: "Mouvements d'inventaire" },
  ]},
  { group: 'Inventaire', icon: Package, items: [
    { to: '/purchases',    icon: ShoppingBag, label: 'Achats' },
    { to: '/assemblages',  icon: Wrench,      label: 'Assemblages' },
    { to: '/products',     icon: Package,     label: 'Pièces/Produits' },
    { to: '/serials',      icon: Barcode,     label: 'Numéros de série' },
  ]},
  { group: 'RH', icon: Users, items: [
    { to: '/employees',        icon: Users,    label: 'Employés',              hrOnly: true },
    { to: '/feuille-de-temps', icon: Clock,    label: 'Feuille de temps' },
    { to: '/codes-activite',   icon: Tag,      label: "Codes d'activité",      hrOnly: true },
    { to: '/paies',            icon: Banknote, label: 'Paies' },
    { to: '/banque-heures',    icon: Wallet,   label: "Banque d'heures" },
  ]},
  { group: 'Autres outils', icon: Wrench, items: [
    { to: '/priorite-assemblage', icon: ListChecks, label: "Priorité d'assemblage" },
    { to: '/automations',  icon: Zap,             label: 'Automatisations' },
    // La page existait mais n'était joignable que par l'onglet Connecteurs de
    // /admin (réservé aux admins) : introuvable pour tout le monde d'autre, et
    // absente de la palette ⌘K qui se construit sur cette même liste. Entrée à
    // plat, comme la route (ProtectedRoute sans adminOnly) et l'API (requireAuth).
    { to: '/connectors',   icon: Plug,            label: 'Connecteurs' },
    { to: '/public-files', icon: FolderOpen,      label: 'Fichiers publics' },
    { external: true, href: 'https://customer.orisha.io/chatbot/admin', icon: Bot, label: 'Admin Chatbot' },
  ]},
]
