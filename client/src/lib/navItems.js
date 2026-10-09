import {
  LayoutDashboard,
  TrendingUp, ShoppingCart, Package, LifeBuoy,
  ShoppingBag, Truck, RotateCcw, FileText, Wrench,
  Barcode, MessageSquare, CheckSquare, Hammer,
  Landmark, Users, Banknote, Contact,
  Clock, Mail, PhoneCall, FlaskConical,
  FolderOpen, Building2, ListChecks, Bot, Zap, Plug, Instagram, AlertTriangle, MessageCircle, Send, Megaphone, ClipboardList, CalendarClock, Tags, FileSignature } from 'lucide-react'
import { FINANCE_GROUPS, FINANCE_SECTIONS } from './financeSections.js'

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

// Groupes renommés : le nom du groupe SERT de clé de préférence, donc un
// renommage orphelinerait l'ordre et les masquages déjà enregistrés en DB
// (la section renommée retomberait en fin de liste / redeviendrait visible).
// Les préférences sont relues à travers cette table au chargement.
const RENAMED_NAV_KEYS = {
  'group:Envois': 'group:Transport',
  'group:Inventaire': 'group:Atelier',
}

const canonicalKey = (key) => RENAMED_NAV_KEYS[key] || key

export function canonicalNavHidden(hidden) {
  return hidden.map(canonicalKey)
}

export function canonicalNavOrder(order) {
  return Object.fromEntries(Object.entries(order).map(([container, keys]) => [
    canonicalKey(container),
    Array.isArray(keys) ? keys.map(canonicalKey) : keys,
  ]))
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

// `accent` : teinte de section (cf. index.css, `--acc-*`). Attachée au nom du
// groupe et non à sa position — l'ordre de la nav est personnalisable par
// utilisateur (`applyNavOrder`), la couleur ne doit pas se déplacer avec.
//
// `menuHidden` : absent du menu (et de sa personnalisation) mais gardé pour la
// palette ⌘K et le titre de page. Le Dashboard : le logo y mène déjà.
export const defaultNavItems = [
  { to: '/dashboard',    icon: LayoutDashboard, label: 'Dashboard', menuHidden: true },
  { group: 'Clients', icon: Contact, accent: 'clients', items: [
    { to: '/contacts',     icon: Contact,       label: 'Contacts' },
    { to: '/companies',    icon: Building2,     label: 'Entreprises' },
    { to: '/pipeline',     icon: TrendingUp,    label: 'Projets' },
    { to: '/tasks',        icon: CheckSquare,   label: 'Tâches' },
    { to: '/tickets',      icon: LifeBuoy,      label: 'Billets' },
    { to: '/interactions', icon: MessageSquare, label: 'Interactions' },
    { to: '/qualification-call', icon: PhoneCall, label: 'Appels de qualification' },
    { to: '/relance-qualification', icon: Mail, label: 'Relances qualification' },
    { to: '/modeles-courriel', icon: Mail, label: 'Modèles de courriel' },
    { to: '/discovery-forms', icon: FileText, label: 'System builder' },
    { to: '/catalogue-vente', icon: Tags, label: 'Catalogue de vente' },
    { to: '/instagram', icon: Instagram, label: 'Instagram' },
  ]},
  { group: 'Marketing', icon: Megaphone, accent: 'marketing', items: [
    { to: '/formulaires', icon: ClipboardList, label: 'Formulaires' },
    { to: '/rendez-vous', icon: CalendarClock, label: 'Rendez-vous' },
  ]},
  { group: 'Transport', icon: Truck, accent: 'envois', items: [
    { to: '/orders',   icon: ShoppingCart, label: 'Commandes' },
    { to: '/envois',   icon: Truck,        label: 'Envois' },
    { to: '/retours',  icon: RotateCcw,    label: 'Retours' },
  ]},
  // `inlineFlyout` : le panneau de la section montre directement les sections
  // de l'Espace finance (au lieu d'un second panneau au survol de sa ligne).
  // Toutes les pages compta vivent dans lib/financeSections.js.
  { group: 'Comptabilité', icon: Landmark, accent: 'compta', inlineFlyout: true, items: [
    // Le clic sur « Espace finance » mène au dashboard comptabilité.
    { to: '/comptabilite',          icon: Landmark,   label: 'Espace finance', flyoutGroups: FINANCE_GROUPS },
  ]},
  { group: 'Atelier', icon: Hammer, accent: 'inventaire', items: [
    { to: '/purchases',    icon: ShoppingBag, label: 'Achats' },
    { to: '/assemblages',  icon: Wrench,      label: 'Assemblages' },
    { to: '/products',     icon: Package,     label: 'Pièces/Produits' },
    { to: '/serials',      icon: Barcode,     label: 'Numéros de série' },
  ]},
  { group: 'RH', icon: Users, accent: 'rh', items: [
    { to: '/employees',        icon: Users,    label: 'Employés', selfLabel: 'Ma fiche personnelle' },
    { to: '/feuille-de-temps', icon: Clock,    label: 'Feuille de temps' },
    { to: '/heures-rsde',      icon: FlaskConical, label: 'Heures RSDE', hrOnly: true },
    { to: '/paies',            icon: Banknote, label: 'Paies' },
  ]},
  { group: 'Autres outils', icon: Wrench, accent: 'outils', items: [
    { to: '/priorite-assemblage', icon: ListChecks, label: "Priorité d'assemblage" },
    { to: '/automations',  icon: Zap,             label: 'Automatisations' },
    // La page existait mais n'était joignable que par la section Connecteurs
    // des Paramètres (réservée aux admins) : introuvable pour les autres, et
    // absente de la palette ⌘K qui se construit sur cette même liste. Entrée à
    // plat, comme la route (ProtectedRoute sans adminOnly) et l'API (requireAuth).
    { to: '/connectors',   icon: Plug,            label: 'Connecteurs' },
    { to: '/public-files', icon: FolderOpen,      label: 'Fichiers publics' },
    { to: '/acceptations', icon: FileSignature,   label: 'Acceptations' },
    { to: '/problemes-operations', icon: AlertTriangle, label: "Problèmes d'opérations" },
    { to: '/fournitures', icon: ShoppingCart, label: 'Fournitures' },
    { external: true, href: 'https://customer.orisha.io/chatbot/admin', icon: Bot, label: 'Admin Chatbot' },
  ]},
]

/**
 * Entrée de menu qui « possède » une route — icône + teinte de section.
 * Sert aux titres de page (cf. `components/PageTitle.jsx`) pour reprendre le
 * même repère visuel que la sidebar sans le redéclarer page par page.
 *
 * Le plus long préfixe gagne : `/comptes-prepayes/3` retombe sur
 * `/comptes-prepayes`, et une entrée plus précise l'emporterait sur elle.
 * Les sections de l'Espace finance sont incluses (teinte `compta`) : elles
 * vivent sous le groupe Comptabilité, dans un panneau flottant.
 */
export function findNavEntry(pathname) {
  if (!pathname) return null
  let best = null
  const consider = (item, accent) => {
    const path = (item.to || '').split('?')[0]
    if (!path) return
    if (pathname !== path && !pathname.startsWith(path + '/')) return
    if (!best || path.length > best.path.length) {
      best = { path, icon: item.icon, accent, label: item.label }
    }
  }
  for (const entry of defaultNavItems) {
    if (entry.items) entry.items.forEach(item => consider(item, entry.accent))
    else consider(entry, entry.accent)
  }
  FINANCE_SECTIONS.forEach(section => consider(section, 'compta'))
  return best
}
