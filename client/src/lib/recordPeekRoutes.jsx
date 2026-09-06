import { lazy } from 'react'
import api from './api.js'
import { fmtAddress } from '../utils/formatters.js'
import { shipmentTitle, shipmentSubtitle } from './shipmentLabel.js'

// Registre des fiches ouvrables en side-peek à partir d'un lien.
//
// C'est LE registre des enregistrements de l'app : une fiche ne s'affiche
// jamais en pleine page, toujours dans un panneau latéral. Il sert deux
// chemins d'ouverture, qui aboutissent au même panneau :
//  1. Un lien cliqué DEPUIS un panneau (le produit d'une ligne de commande…) :
//     on n'a pas la ligne du tableau sous la main, seule l'URL est connue →
//     `matchPeekRoute` fait le pont URL → fiche embarquée.
//  2. Une route de fiche atteinte par navigation ou rechargement
//     (/orders/<id>) : App.jsx rend la page de fond (liste d'origine) et
//     superpose le panneau, au lieu d'une page pleine. Voir
//     `components/RecordRoutePanel.jsx`.
//
// Chaque entrée :
//  - label     : titre provisoire affiché pendant le chargement du record
//  - width     : largeur par défaut du panneau (alignée sur la liste d'origine)
//  - list      : route de la liste d'origine — page de fond quand la fiche est
//                ouverte directement (lien externe, rechargement) et cible de
//                repli à la fermeture du panneau.
//  - Component : la page *Detail.jsx, en import dynamique — un import statique
//                créerait un cycle (OrderDetail → DataTable → RecordPeekDrawer
//                → ce registre → OrderDetail).
//  - load      : GET du record (le cache de `api` le partage avec la fiche
//                embarquée qui le refetch juste après : pas d'appel en double)
//  - title / subtitle : dérivés du record chargé.
//  - guard     : 'admin' | 'hr' — rôle requis (aligné sur la route de la liste).
//  - idPattern : forme des id de la table, si elle sort de l'ordinaire
//                (défaut : entier ou UUID — voir `matchPeekRoute`).
export const PEEK_ROUTES = {
  orders: {
    label: 'Commande',
    width: 900,
    list: '/orders',
    Component: lazy(() => import('../pages/OrderDetail.jsx')),
    load: id => api.orders.get(id),
    // Pas de sous-titre : l'entreprise est déjà dans la fiche, en chip
    // cliquable et modifiable — l'écrire ici la ferait apparaître deux fois.
    title: r => (r.order_number ? `Commande #${r.order_number}` : `Commande #${r.id}`),
  },
  products: {
    label: 'Produit',
    width: 720,
    list: '/products',
    Component: lazy(() => import('../pages/ProductDetail.jsx')),
    load: id => api.products.get(id),
    title: r => r.name_fr || r.name_en || r.name || 'Produit',
    subtitle: r => [r.sku, r.type].filter(Boolean).join(' · '),
  },
  companies: {
    label: 'Entreprise',
    width: 720,
    list: '/companies',
    Component: lazy(() => import('../pages/CompanyDetail.jsx')),
    load: id => api.companies.get(id),
    title: r => r.name || 'Entreprise',
    subtitle: r => [r.type, r.city].filter(Boolean).join(' · '),
  },
  contacts: {
    label: 'Contact',
    width: 560,
    list: '/contacts',
    Component: lazy(() => import('../pages/ContactDetail.jsx')),
    load: id => api.contacts.get(id),
    title: r => `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Contact',
    subtitle: r => r.company_name || r.email || '',
  },
  projects: {
    label: 'Projet',
    width: 720,
    list: '/pipeline',
    Component: lazy(() => import('../pages/ProjectDetail.jsx')),
    load: id => api.projects.get(id),
    title: r => r.name || 'Projet',
    subtitle: r => [r.company_name, r.type].filter(Boolean).join(' · '),
  },
  serials: {
    label: 'Numéro de série',
    width: 680,
    list: '/serials',
    Component: lazy(() => import('../pages/SerialDetail.jsx')),
    load: id => api.serials.get(id),
    title: r => r.serial || 'Numéro de série',
    subtitle: r => r.company_name || r.product_name || '',
  },
  factures: {
    label: 'Facture',
    width: 720,
    list: '/factures',
    Component: lazy(() => import('../pages/FactureDetail.jsx')),
    load: id => api.factures.get(id),
    title: r => r.document_number || 'Facture',
    subtitle: r => r.company_name || '',
  },
  envois: {
    label: 'Envoi',
    width: 860,
    list: '/envois',
    Component: lazy(() => import('../pages/EnvoisDetail.jsx')),
    load: id => api.shipments.get(id),
    title: r => shipmentTitle(r),
    subtitle: r => shipmentSubtitle(r),
  },
  adresses: {
    label: 'Adresse',
    width: 720,
    list: '/companies',
    Component: lazy(() => import('../pages/AdresseDetail.jsx')),
    load: id => api.adresses.get(id),
    title: r => fmtAddress(r) || 'Adresse',
    subtitle: r => [r.company_name, r.address_type].filter(Boolean).join(' · '),
  },
  retours: {
    label: 'Retour',
    width: 720,
    list: '/retours',
    Component: lazy(() => import('../pages/RetourDetail.jsx')),
    load: id => api.retours.get(id),
    title: r => r.n_de_retour || 'Retour',
    subtitle: r => r.company_name || '',
  },
  purchases: {
    label: 'Achat',
    width: 680,
    list: '/purchases',
    Component: lazy(() => import('../pages/PurchaseDetail.jsx')),
    load: id => api.purchases.get(id),
    title: r => r.product_name || r.reference || 'Achat',
    subtitle: r => r.supplier_company_name || r.supplier || '',
  },
  tickets: {
    label: 'Billet',
    width: 720,
    list: '/tickets',
    Component: lazy(() => import('../pages/TicketDetail.jsx')),
    load: id => api.tickets.get(id),
    title: r => r.title || 'Billet',
    subtitle: r => r.company_name || r.contact_name || '',
  },
  soumissions: {
    label: 'Soumission',
    width: 980,
    list: '/pipeline',
    Component: lazy(() => import('../pages/SoumissionDetail.jsx')),
    load: id => api.documents.soumissions.get(id),
    title: r => r.title || (r.quote_number ? `Soumission #${r.quote_number}` : 'Soumission'),
    subtitle: r => [r.company_name, r.project_name].filter(Boolean).join(' · '),
  },
  'sale-receipts': {
    // Poste de travail (PDF à gauche, extraction à droite) : panneau large.
    label: 'Reçu',
    width: 1240,
    list: '/sale-receipts',
    Component: lazy(() => import('../pages/SaleReceiptDetail.jsx')),
    load: id => api.saleReceipts.get(id),
    title: r => r.company || r.original_name || 'Reçu',
    subtitle: r => [r.supplier, r.status].filter(Boolean).join(' · '),
  },
  'stripe-payouts': {
    label: 'Payout Stripe',
    width: 980,
    list: '/stripe-payouts',
    // Les payouts sont adressés par leur id Stripe (po_…), pas par un UUID.
    idPattern: /^po_[A-Za-z0-9]+$/,
    Component: lazy(() => import('../pages/StripePayoutDetail.jsx')),
    load: id => api.stripePayouts.get(id),
    title: r => (r.payout?.stripe_id || r.stripe_id || 'Payout Stripe'),
  },
  'depots-directs': {
    label: 'Dépôt direct',
    width: 860,
    list: '/paiements',
    Component: lazy(() => import('../pages/DirectDepositDetail.jsx')),
    load: id => api.payments.directDeposit(id),
    title: r => (r.deposit || r.candidate)?.document_number || 'Dépôt direct',
    subtitle: r => (r.deposit || r.candidate)?.company_name || '',
  },
  'discovery-forms': {
    label: 'System builder',
    width: 760,
    list: '/discovery-forms',
    Component: lazy(() => import('../pages/DiscoveryFormDetail.jsx')),
    load: id => api.discoveryForms.get(id),
    title: r => r.company_name || 'System builder',
    subtitle: r => (r.status === 'submitted' ? 'Soumis' : 'En cours'),
  },
  employees: {
    label: 'Employé',
    width: 720,
    list: '/employees',
    guard: 'hr',
    Component: lazy(() => import('../pages/EmployeeDetail.jsx')),
    load: id => api.employees.get(id),
    title: r => `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Employé',
    subtitle: r => [r.job_title, r.status].filter(Boolean).join(' · '),
  },
}

// Rôle suffisant pour ouvrir la fiche (miroir des gardes de route de la liste).
export function canOpenRecord(user, def) {
  if (!user) return false
  if (def?.guard === 'admin') return user.role === 'admin'
  if (def?.guard === 'hr') return ['admin', 'rh'].includes(user.role)
  return true
}

// Forme par défaut d'un id : entier, id compact (`borB4Fehk9jYd4s4B`, la forme
// des enregistrements créés depuis le 2026-09-04) ou UUID (les plus anciens).
// Exiger l'une de ces formes écarte les sous-routes qui ressemblent à une fiche
// (/projects/fields, /products/nouveau…), qui doivent naviguer normalement.
const DEFAULT_ID_PATTERN = /^(?:\d+|bor[0-9A-Za-z]{14}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

// Reconnaît « /<ressource>/<id> » (une fois le basename retiré) et renvoie
// { resource, id, path } si la fiche est ouvrable en panneau. `null` sinon :
// le lien navigue alors normalement (liste, page hors registre…).
export function matchPeekRoute(pathname, basename = '/') {
  if (!pathname) return null
  let p = pathname
  const base = basename.replace(/\/$/, '')
  if (base && p.startsWith(base)) p = p.slice(base.length)
  const m = /^\/([^/]+)\/([^/]+)$/.exec(p)
  if (!m) return null
  const [, resource, id] = m
  const def = PEEK_ROUTES[resource]
  if (!def) return null
  if (!(def.idPattern || DEFAULT_ID_PATTERN).test(id)) return null
  return { resource, id, path: `/${resource}/${id}` }
}

export default PEEK_ROUTES
