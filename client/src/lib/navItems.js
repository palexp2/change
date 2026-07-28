import {
  LayoutDashboard,
  TrendingUp, ShoppingCart, Package, LifeBuoy,
  ShoppingBag, Truck, RotateCcw, FileText, RefreshCw, Wrench,
  Barcode, MessageSquare, CheckSquare,
  Receipt, ReceiptText, Landmark, Users, Banknote, Contact, BookOpen,
  ArrowLeftRight, CreditCard, Clock, Tag, Wallet, Mail, PhoneCall,
  FolderOpen, Building2, ListChecks, Bot, Activity, Zap, BookUser
} from 'lucide-react'

// Structure canonique du menu de gauche, partagée entre la sidebar (Layout)
// et la page Paramètres (customisation afficher/cacher).
//
// Clés de customisation (cf. nav_hidden / navPrefs) :
//   - item à plat ou sous-item d'un groupe → clé = `item.to`
//   - groupe entier → clé = `group:<group>`
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
  ]},
  { group: 'Envois', icon: Truck, items: [
    { to: '/orders',   icon: ShoppingCart, label: 'Commandes' },
    { to: '/envois',   icon: Truck,        label: 'Envois' },
    { to: '/retours',  icon: RotateCcw,    label: 'Retours' },
  ]},
  { group: 'Comptabilité', icon: Landmark, items: [
    { to: '/comptabilite',          icon: Landmark,   label: 'Dashboard comptabilité' },
    { to: '/factures',              icon: FileText,   label: 'Factures clients' },
    { to: '/paiements',             icon: Banknote,   label: 'Paiements' },
    { to: '/items-vendus',          icon: Tag,        label: 'Items vendus' },
    { to: '/abonnements',           icon: RefreshCw,  label: 'Abonnements' },
    { to: '/abonnements/mouvements', icon: RefreshCw, label: "Mouvements d'abonnements" },
    { to: '/fournisseurs',          icon: BookUser,   label: 'Fournisseurs' },
    { to: '/comptes-prepayes',      icon: Wallet,     label: 'Comptes prépayés' },
    { to: '/dettes-lt',             icon: Landmark,   label: 'Dettes long terme' },
    { to: '/sale-receipts',         icon: ReceiptText,label: 'Extraction de données' },
    { to: '/stripe-payouts',        icon: CreditCard, label: 'Stripe Payouts' },
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
    { to: '/public-files', icon: FolderOpen,      label: 'Fichiers publics' },
    { external: true, href: 'https://customer.orisha.io/chatbot/admin', icon: Bot, label: 'Admin Chatbot' },
  ]},
]
