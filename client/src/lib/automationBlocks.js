import { CheckSquare, MessageSquare, Mail, Pencil, Search, Users, BookOpen, Code2 } from 'lucide-react'

// Catalogue des blocs de la page Automatisations (façon Airtable). Le moteur
// côté serveur : server/src/services/ruleActions/steps.js (mêmes types).

export const TABLE_LABELS = {
  shipments: 'Envois', orders: 'Commandes', factures: 'Factures', companies: 'Entreprises',
  contacts: 'Contacts', products: 'Produits', serial_numbers: 'Numéros de série', tickets: 'Billets',
  projects: 'Projets', order_items: 'Lignes de commande', return_items: 'Items de retour', returns: 'Retours',
  purchases: 'Achats', achats_fournisseurs: 'Achats fournisseurs', sale_receipts: 'Reçus de vente',
  adresses: 'Adresses', tasks: 'Tâches', stock_movements: 'Mouvements d’inventaire', bom_items: 'Nomenclatures',
}
export const tableLabel = t => TABLE_LABELS[t] || t

// Tables que le bloc « Trouver » peut lire (READABLE_TABLES du serveur).
export const READABLE_TABLES = Object.keys(TABLE_LABELS)
// Tables suivies en continu par le déclencheur « enregistrement ».
export const WATCHED_TABLES = ['factures', 'products', 'orders', 'shipments', 'companies', 'contacts', 'serial_numbers']

export const OPS = [
  { value: 'eq', label: 'est' },
  { value: 'ne', label: 'n’est pas' },
  { value: 'gt', label: '>' },
  { value: 'lt', label: '<' },
  { value: 'not_null', label: 'n’est pas vide' },
]
export const opLabel = op => OPS.find(o => o.value === op)?.label || op

export const FREQS = [
  { value: 'min5', label: 'Toutes les 5 min' },
  { value: 'min15', label: 'Toutes les 15 min' },
  { value: 'hour', label: 'Toutes les heures' },
  { value: 'day', label: 'Chaque jour' },
  { value: 'week', label: 'Chaque semaine' },
  { value: 'month', label: 'Chaque mois' },
]
export const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']

// Champs : [clé, libellé, type]. type : text | area | code | number | user |
// priority | table | readable | object | fields | conditions | slack_channel.
export const BLOCKS = {
  task:    { Icon: CheckSquare, bg: '#dcfce7', label: 'Créer une tâche', fields: [['title', 'Titre', 'text'], ['assigned_to', 'Assigné à', 'user'], ['priority', 'Priorité', 'priority'], ['due_in_days', 'Échéance (jours)', 'number'], ['description', 'Description', 'area']] },
  slack:   { Icon: MessageSquare, bg: '#ede9fe', label: 'Message Slack', fields: [['channel', 'Destinataire', 'slack_channel'], ['text', 'Message', 'area']] },
  email:   { Icon: Mail, bg: '#dbeafe', label: 'Envoyer un courriel', fields: [['to', 'À', 'text'], ['subject', 'Objet', 'text'], ['body', 'Message', 'area']] },
  update:  { Icon: Pencil, bg: '#fef3c7', label: 'Modifier l’enregistrement', fields: [['fields', 'Champs', 'fields']] },
  find:    { Icon: Search, bg: '#f1f5f9', label: 'Trouver des enregistrements', fields: [['table', 'Table', 'readable'], ['conditions', 'Conditions', 'conditions'], ['limit', 'Maximum', 'number']] },
  hubspot: { Icon: Users, bg: '#ffedd5', label: 'HubSpot', fields: [['object', 'Objet', 'object'], ['record', 'Contact (id ou courriel)', 'text'], ['property', 'Propriété', 'text'], ['value', 'Valeur', 'text']] },
  qb:      { Icon: BookOpen, bg: '#dcfce7', label: 'QuickBooks', fields: [['debit', 'Débit (n° de compte)', 'text'], ['credit', 'Crédit (n° de compte)', 'text'], ['amount', 'Montant', 'text'], ['memo', 'Mémo', 'text'], ['date', 'Date (AAAA-MM-JJ)', 'text']] },
  script:  { Icon: Code2, bg: '#e2e8f0', label: 'Script', fields: [['code', 'Code', 'code']] },
}

export const DEFAULT_CONFIG = {
  task: { title: '', priority: 'Normal', due_in_days: 0 },
  slack: { channel: '', text: '' },
  email: { to: '{{email}}', subject: '', body: '' },
  update: { fields: [] },
  find: { table: 'contacts', conditions: [], limit: 50 },
  hubspot: { object: 'contacts', record: '{{email}}', property: '', value: '' },
  qb: { debit: '', credit: '', amount: '', memo: '' },
  script: { code: '// row = enregistrement déclencheur, trigger.etapes = sorties des actions précédentes\n' },
}

const cut = (s, n = 60) => (s && s.length > n ? `${s.slice(0, n)}…` : s)

/** Résumé d'une action pour son bloc du canevas. */
export function stepSummary(step, users = []) {
  const c = step.config || {}
  switch (step.type) {
    case 'task': return [c.title, users.find(u => u.id === c.assigned_to)?.name].filter(Boolean).join(' · ')
    case 'slack': return c.channel
    case 'email': return [c.to, c.subject].filter(Boolean).join(' · ')
    case 'update': return (c.fields || []).map(f => f.column).filter(Boolean).join(', ')
    case 'find': return tableLabel(c.table) + ((c.conditions || []).length ? ` · ${c.conditions.length} condition(s)` : '')
    case 'hubspot': return [c.object === 'companies' ? 'Entreprise' : 'Contact', c.property].filter(Boolean).join(' · ')
    case 'qb': return c.debit || c.credit ? `Écriture · Dr ${c.debit || '?'} / Cr ${c.credit || '?'}` : ''
    case 'script': return cut((c.code || '').split('\n').find(l => l.trim() && !l.trim().startsWith('//')) || '')
    default: return ''
  }
}

// Champs offerts par le déclencheur « abonnement contient un produit ».
export const SUB_TOKENS = [
  ['email', 'Courriel du contact'], ['contact_name', 'Nom du contact'], ['first_name', 'Prénom'], ['last_name', 'Nom'],
  ['hubspot_record_id', 'Id HubSpot'], ['role', 'Rôle (contact / signataire)'], ['stripe_id', 'Abonnement Stripe'],
  ['produits', 'Produits'], ['cause', 'Départ (annulé / retiré)'], ['maintenant', 'Maintenant (date)'], ['maintenant_ms', 'Maintenant (ms)'],
].map(([value, label]) => ({ value, label }))

export const triggerKindOf = (a, tc) => (a.kind !== 'flow' ? 'field_rule' : tc?.type === 'subscription_product' ? 'subscription_product' : 'schedule')
export const TRIGGER_TITLES = {
  field_rule: 'Quand un enregistrement correspond', schedule: 'Planifié', subscription_product: 'Quand un abonnement contient un produit',
}

/** Résumé du déclencheur. */
export function triggerSummary(a, tc, labelOf = c => c, productLabel = p => p) {
  if (tc?.type === 'subscription_product') {
    const p = (tc.products || []).map(productLabel)
    return p.length ? p.join(', ') : 'aucun produit'
  }
  if (a.kind === 'flow') {
    const f = FREQS.find(x => x.value === tc.freq)?.label || 'Planifié'
    if (tc.freq === 'week') return `${f} · ${WEEKDAYS[tc.weekday ?? 1]} à ${tc.time}`
    if (tc.freq === 'month') return `${f} · le ${tc.monthday ?? 1} à ${tc.time}`
    return tc.freq === 'day' ? `${f} à ${tc.time}` : f
  }
  const rules = (tc.conditions?.rules || []).filter(r => r.column)
  const conj = tc.conditions?.conjunction === 'OR' ? ' ou ' : ' et '
  return `${tableLabel(tc.erp_table)}${rules.length ? ' · ' + rules.map(r => `${labelOf(r.column)} ${opLabel(r.op)}${r.op === 'not_null' ? '' : ' ' + (r.value ?? '')}`).join(conj) : ' · aucune condition'}`
}
