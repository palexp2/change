import { hasRole } from '../../../shared/roles.mjs'
import { lazy } from 'react'
import api from './api.js'
import { fmtAddress } from '../utils/formatters.js'
import { shipmentTitle, shipmentSubtitle } from './shipmentLabel.js'
import { interactionTitle, interactionSubtitle } from './interactionLabel.js'

// Registre des fiches ouvrables en side-peek à partir d'un lien.
//
// C'est LE registre des enregistrements ouverts en panneau latéral (les
// ressources qui n'y figurent pas ont une vraie route pleine page). Il sert
// deux chemins d'ouverture, qui aboutissent au même panneau :
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
//  - historySource : l'historique nomme l'automatisation des révisions « Système ».
export const PEEK_ROUTES = {
  products: {
    label: 'Produit',
    width: 720,
    list: '/products',
    Component: lazy(() => import('../pages/ProductDetail.jsx')),
    load: id => api.products.get(id),
    title: r => r.name_fr || r.name_en || r.name || 'Produit',
    subtitle: r => [r.sku, r.type].filter(Boolean).join(' · '),
  },
  // Commandes, entreprises et contacts ne sont plus dans ce registre : leur
  // fiche s'ouvre en pleine page (/orders/:id, /companies/:id, /contacts/:id —
  // routes réelles dans App.jsx, pages/OrderDetailPage.jsx,
  // CompanyDetailPage.jsx et ContactDetailPage.jsx), pas dans ce panneau. Les
  // aperçus imbriqués (contacts et commandes d'une entreprise, entreprise
  // d'une facture) gardent leur propre side-peek local, indépendant de ce
  // registre — voir CompanyDetail.jsx et Factures.jsx.
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
    // Le n° RMA vit dans le champ personnalisé « # de retour » (cf_de_retour)
    // depuis la migration serveur 037. Pas de sous-titre : l'id Boréal n'apporte rien.
    title: r => r.cf_de_retour || 'Retour',
    // Historique : nomme l'automatisation derrière « Système ».
    historySource: true,
  },
  purchases: {
    label: 'Achat',
    width: 680,
    list: '/purchases',
    Component: lazy(() => import('../pages/PurchaseDetail.jsx')),
    load: id => api.purchases.get(id),
    title: r => r.nom_de_la_piece || r.at_id || 'Achat',
    subtitle: r => r.supplier_company_name || r.supplier_vendor_name || '',
  },
  tickets: {
    label: 'Billet',
    width: 720,
    list: '/tickets',
    Component: lazy(() => import('../pages/TicketDetail.jsx')),
    load: id => api.tickets.get(id),
    // Titre, entreprise et contact ont été droppés (migration 040) : un billet
    // n'a plus de libellé propre : on affiche son ID (`cf_billet`, formule
    // Airtable « ID »).
    title: r => r.cf_billet || 'Billet',
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
    title: r => [r.form_number && `SYS-${r.form_number}`, r.company_name].filter(Boolean).join(' · ') || 'System builder',
    subtitle: r => (r.status === 'submitted' ? 'Soumis' : 'En cours'),
  },
  interactions: {
    label: 'Interaction',
    width: 720,
    list: '/interactions',
    Component: lazy(() => import('../pages/InteractionDetail.jsx')),
    load: id => api.interactions.get(id),
    title: r => interactionTitle(r),
    subtitle: r => interactionSubtitle(r),
  },
  'problemes-operations': {
    label: 'Problème',
    width: 720,
    list: '/problemes-operations',
    Component: lazy(() => import('../pages/OpsIssueDetail.jsx')),
    load: id => api.opsIssues.get(id),
    title: r => r.title || 'Problème',
    subtitle: r => [r.area, r.status].filter(Boolean).join(' · '),
  },
  fournitures: {
    label: 'Fourniture',
    width: 680,
    list: '/fournitures',
    Component: lazy(() => import('../pages/FournitureDetail.jsx')),
    load: id => api.fournitures.get(id),
    title: r => r.name || 'Fourniture',
    subtitle: r => r.supplier || '',
  },
  formulaires: {
    label: 'Formulaire',
    width: 760,
    list: '/formulaires',
    Component: lazy(() => import('../pages/MarketingFormDetail.jsx')),
    load: id => api.marketingForms.get(id),
    title: r => r.name || 'Formulaire',
    subtitle: r => [r.language?.toUpperCase(), `${r.submission_count || 0} soumissions`].filter(Boolean).join(' · '),
  },
  'rendez-vous': {
    label: 'Page de rendez-vous',
    width: 760,
    list: '/rendez-vous',
    Component: lazy(() => import('../pages/MeetingTypeDetail.jsx')),
    load: id => api.meetings.getType(id),
    title: r => r.name || 'Page de rendez-vous',
    subtitle: r => [r.owner_name, r.durations?.map(d => `${d} min`).join(' / ')].filter(Boolean).join(' · '),
  },
  acceptations: {
    label: 'Acceptation',
    width: 720,
    list: '/acceptations',
    Component: lazy(() => import('../pages/AcceptationDetail.jsx')),
    load: id => api.publicFiles.getAcceptance(id),
    title: r => r.contact_name || r.name || 'Acceptation',
    subtitle: r => r.page_name || '',
  },
  'catalogue-vente': {
    label: 'Produit Stripe',
    width: 720,
    list: '/catalogue-vente',
    idPattern: /^prod_[A-Za-z0-9]+$/,
    Component: lazy(() => import('../pages/StripeProductDetail.jsx')),
    load: id => api.stripeCatalog.get(id),
    title: r => r.name || 'Produit',
    subtitle: r => (r.active ? '' : 'Archivé'),
  },
  'modeles-courriel': {
    label: 'Modèle de courriel',
    width: 720,
    list: '/modeles-courriel',
    Component: lazy(() => import('../pages/EmailTemplateDetail.jsx')),
    load: id => api.emailTemplates.get(id),
    title: r => r.name || 'Modèle de courriel',
    subtitle: r => r.subject || '',
  },
  employees: {
    label: 'Employé',
    width: 720,
    list: '/employees',
    Component: lazy(() => import('../pages/EmployeeDetail.jsx')),
    load: id => api.employees.get(id),
    title: r => `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Employé',
    subtitle: r => [r.job_title, r.status].filter(Boolean).join(' · '),
  },
}

// Rôle suffisant pour ouvrir la fiche (miroir des gardes de route de la liste).
export function canOpenRecord(user, def) {
  if (!user) return false
  if (def?.guard === 'admin') return hasRole(user, 'admin')
  if (def?.guard === 'hr') return hasRole(user, 'rh')
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
