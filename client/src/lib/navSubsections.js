import api from './api.js'

// Sous-sections d'une page — ce qu'on voit comme onglets/vues en haut de la
// page, exposé aussi au survol de son entrée dans le menu de gauche.
//
// Trois natures :
//   - `tabs`    : onglets codés en dur, adressables par ?<param>=<valeur>
//   - `routes`  : la page a de vraies sous-routes (rien à traduire)
//   - `views`   : les vues (pills) configurables d'un DataTable, adressables
//                 par ?vue=<id> — chargées à la demande depuis le serveur
//   - `accounts`: comptes bancaires du rapprochement, adressables par ?compte=
//
// Les pages sans onglet (dashboard comptabilité, état du close, Stripe Payouts,
// dettes long terme, écritures de fin de mois, mouvements d'abonnements) sont
// volontairement absentes : leur entrée de menu reste un simple lien.
export const NAV_SUBSECTIONS = {
  // ── Espace finance ────────────────────────────────────────────────────────
  '/travaux': {
    kind: 'tabs', param: 'onglet', items: [
      { value: 'file', label: 'Ma file de prompts' },
      { value: 'suggestions', label: 'Suggestions de Claude' },
      { value: 'idees', label: 'De côté & idées' },
      { value: 'recurrents', label: 'Travaux récurrents' },
    ],
  },
  '/paiements-emis': {
    kind: 'tabs', param: 'onglet', items: [
      { value: 'cedule', label: 'À payer (cédule)' },
      { value: 'pending', label: 'À passer à la banque' },
      { value: 'cleared', label: 'Passés' },
      { value: 'all', label: 'Tous' },
    ],
  },
  '/comptes-prepayes': {
    kind: 'tabs', param: 'onglet', items: [
      { value: 'ledger', label: 'Soldes fournisseurs' },
      { value: 'fpa', label: 'Cédule FPA' },
    ],
  },
  '/inventaire-drive': {
    kind: 'tabs', param: 'onglet', items: [
      { value: 'suggestions', label: 'Suggestions' },
      { value: 'documents', label: 'Documents' },
    ],
  },
  '/fournisseurs': {
    kind: 'routes', items: [
      { to: '/fournisseurs', label: 'Profils' },
      { to: '/fournisseurs/achats', label: 'Achats' },
      { to: '/fournisseurs/abonnements', label: 'Abonnements' },
    ],
  },
  '/rapprochement': { kind: 'accounts', param: 'compte' },
  // Bac à sable « Tests – Antoine » : l'import MAPAQ (la page elle-même) et la
  // prospection tirée du Registre des entreprises du Québec, chacune sur sa
  // propre route.
  '/tests-antoine': {
    kind: 'routes', items: [
      { to: '/tests-antoine', label: 'Import MAPAQ (serres)' },
      { to: '/tests-antoine/prospects-req', label: 'Prospects REQ' },
    ],
  },

  // L'entrée « Agent » (bas de la sidebar) est volontairement sans sous-menu :
  // un clic ouvre directement la page Agent, qui porte elle-même le lien vers
  // ses travaux (/agent/travaux).

  // ── Groupe Comptabilité ───────────────────────────────────────────────────
  '/factures':        { kind: 'views', param: 'vue', table: 'factures' },
  '/paiements':       { kind: 'views', param: 'vue', table: 'payments' },
  '/items-vendus':    { kind: 'views', param: 'vue', table: 'stripe_invoice_items' },
  '/abonnements':     { kind: 'views', param: 'vue', table: 'abonnements' },
  '/sale-receipts': {
    kind: 'tabs', param: 'onglet', items: [
      { value: 'recus', label: 'Reçus' },
      { value: 'collecte', label: 'Collecte de factures' },
    ],
  },
  '/journal-entries': { kind: 'views', param: 'vue', table: 'journal_entries' },
  '/stock-movement':  { kind: 'views', param: 'vue', table: 'stock_movements' },
  '/comptabilite/regles-serials': { kind: 'views', param: 'vue', table: 'serial_missing_valuations' },
}

export function getSubsections(route) {
  return NAV_SUBSECTIONS[route] || null
}

// Les listes dynamiques (vues, comptes) ne changent quasi jamais pendant une
// session : un cache par route évite de refrapper le serveur à chaque survol.
const cache = new Map()

function link(route, param, value, label) {
  return { to: `${route}?${param}=${encodeURIComponent(value)}`, label }
}

/**
 * Sous-sections prêtes à afficher pour une route : `[{ to, label }]`.
 * Renvoie [] si la route n'en a pas (ou si le chargement échoue — un sous-menu
 * est un raccourci, jamais un point de blocage).
 */
export async function resolveSubsections(route) {
  const desc = getSubsections(route)
  if (!desc) return []
  if (cache.has(route)) return cache.get(route)

  let items = []
  try {
    if (desc.kind === 'routes') {
      items = desc.items.map(i => ({ to: i.to, label: i.label }))
    } else if (desc.kind === 'tabs') {
      items = desc.items.map(i => link(route, desc.param, i.value, i.label))
    } else if (desc.kind === 'views') {
      const { pills } = await api.views.get(desc.table)
      items = (pills || []).map(p => link(route, desc.param, p.id, p.label))
    } else if (desc.kind === 'accounts') {
      const list = await api.bank.accounts()
      items = (list || []).map(a => link(route, desc.param, a.id, a.name))
    }
  } catch {
    items = []
  }
  // Les listes vides ne sont pas mises en cache : une vue créée juste après
  // apparaîtra au survol suivant.
  if (items.length) cache.set(route, items)
  return items
}
