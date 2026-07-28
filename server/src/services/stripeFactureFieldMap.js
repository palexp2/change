// Mapping configurable des champs Stripe → colonnes de la table `factures`.
//
// Historiquement ce mapping était hardcodé dans stripe-webhooks.js
// (upsertFactureFromStripeInvoice) et stripe-queue.js (batch-enrich). Il est
// maintenant centralisé ici et l'utilisateur peut choisir, pour chaque colonne
// ERP configurable, quel champ de l'objet Stripe Invoice l'alimente (modale
// « Mapping Stripe » sur /factures). La config vit dans connector_config
// (connector='stripe', key='facture_field_map') sous forme d'overrides JSON —
// absence de config = comportement historique inchangé.
//
// Les champs « fixes » (statut, entreprise, abonnement, encaissement…) ne sont
// pas configurables : leur logique dépasse un simple choix de champ source
// (lookups DB, mapping de statuts, reset conditionnel). Ils sont tout de même
// déclarés ici (STRIPE_FACTURE_FIXED) pour que la modale les affiche.

import db from '../db/database.js'

// Chaque spec : colonne ERP ← chemin dans l'objet Stripe Invoice.
//   type       : conversion appliquée à la valeur brute
//                'money' (cents → dollars), 'date' (epoch → YYYY-MM-DD), 'string'
//   default    : chemin Stripe historique (comportement d'origine)
//   fallbacks  : chaîne de repli quand le chemin choisi est null côté Stripe
//                (préserve les `??` historiques, ex. subtotal_excluding_tax ?? subtotal)
//   candidates : chemins proposés dans la modale — la sauvegarde est restreinte
//                à cette liste (pas de chemin arbitraire)
export const STRIPE_FACTURE_FIELDS = [
  {
    key: 'document_number', label: 'Numéro de document', column: 'document_number', type: 'string',
    default: 'number', fallbacks: [],
    hint: 'Sert aussi de clé de correspondance avec Airtable',
    candidates: [
      { path: 'number', label: 'number — numéro séquentiel Stripe (ex. ORIS-0042)' },
      { path: 'id', label: 'id — identifiant technique Stripe (in_…)' },
    ],
  },
  {
    key: 'document_date', label: 'Date du document', column: 'document_date', type: 'date',
    default: 'created', fallbacks: [],
    candidates: [
      { path: 'created', label: 'created — date de création de la facture' },
      { path: 'status_transitions.finalized_at', label: 'status_transitions.finalized_at — date de finalisation' },
      { path: 'status_transitions.paid_at', label: 'status_transitions.paid_at — date de paiement' },
      { path: 'period_start', label: 'period_start — début de la période facturée' },
      { path: 'period_end', label: 'period_end — fin de la période facturée' },
    ],
  },
  {
    key: 'due_date', label: "Date d'échéance", column: 'due_date', type: 'date',
    default: 'due_date', fallbacks: [],
    candidates: [
      { path: 'due_date', label: 'due_date — échéance Stripe (null si paiement immédiat)' },
      { path: 'period_end', label: 'period_end — fin de la période facturée' },
    ],
  },
  {
    key: 'amount_before_tax', label: 'Montant avant taxes', column: 'amount_before_tax_cad', type: 'money',
    default: 'subtotal_excluding_tax', fallbacks: ['subtotal'],
    hint: 'subtotal_excluding_tax est universellement HT, même en prix taxes incluses',
    candidates: [
      { path: 'subtotal_excluding_tax', label: 'subtotal_excluding_tax — sous-total hors taxes' },
      { path: 'subtotal', label: 'subtotal — sous-total (TTC si prix taxes incluses)' },
      { path: 'total_excluding_tax', label: 'total_excluding_tax — total hors taxes (après rabais)' },
    ],
  },
  {
    key: 'total_amount', label: 'Montant total', column: 'total_amount', type: 'money',
    default: 'total', fallbacks: [],
    candidates: [
      { path: 'total', label: 'total — total de la facture (taxes incluses)' },
      { path: 'amount_due', label: 'amount_due — montant exigible' },
      { path: 'amount_paid', label: 'amount_paid — montant encaissé' },
    ],
  },
  {
    key: 'balance_due', label: 'Solde dû', column: 'balance_due', type: 'money',
    default: 'amount_remaining', fallbacks: ['amount_due'],
    candidates: [
      { path: 'amount_remaining', label: 'amount_remaining — restant à payer' },
      { path: 'amount_due', label: 'amount_due — montant exigible' },
    ],
  },
  {
    key: 'customer_email', label: 'Courriel du client', column: 'customer_email', type: 'string',
    default: 'customer_email', fallbacks: ['customer.email'],
    hint: "Identifie les clients Stripe sans entreprise dans l'ERP",
    candidates: [
      { path: 'customer_email', label: 'customer_email — courriel du client au moment de la facture' },
      { path: 'customer_name', label: 'customer_name — nom du client au moment de la facture' },
    ],
  },
]

// Catalogue des chemins de l'objet Stripe Invoice proposés pour les champs
// personnalisés (kind='data') de la table factures. Contrairement aux specs
// natives (candidats restreints par colonne), un champ personnalisé peut être
// alimenté par n'importe quel chemin du catalogue — le type de conversion est
// porté par le chemin Stripe, pas par la colonne ERP.
export const STRIPE_INVOICE_CATALOG = [
  { path: 'id', label: 'id — identifiant technique Stripe (in_…)', type: 'string' },
  { path: 'number', label: 'number — numéro séquentiel Stripe (ex. ORIS-0042)', type: 'string' },
  { path: 'customer', label: 'customer — identifiant du client Stripe (cus_…)', type: 'string' },
  { path: 'customer_email', label: 'customer_email — courriel du client', type: 'string' },
  { path: 'customer_name', label: 'customer_name — nom du client', type: 'string' },
  { path: 'customer_phone', label: 'customer_phone — téléphone du client', type: 'string' },
  { path: 'description', label: 'description — description/note de la facture', type: 'string' },
  { path: 'status', label: 'status — statut Stripe brut (paid, open, void…)', type: 'string' },
  { path: 'currency', label: 'currency — devise (code ISO minuscule)', type: 'string' },
  { path: 'collection_method', label: 'collection_method — charge_automatically ou send_invoice', type: 'string' },
  { path: 'billing_reason', label: 'billing_reason — raison de facturation (subscription_cycle…)', type: 'string' },
  { path: 'hosted_invoice_url', label: 'hosted_invoice_url — lien public de la facture', type: 'string' },
  { path: 'invoice_pdf', label: 'invoice_pdf — lien de téléchargement du PDF', type: 'string' },
  { path: 'charge', label: 'charge — identifiant de la charge (ch_…)', type: 'string' },
  { path: 'payment_intent', label: 'payment_intent — identifiant du PaymentIntent (pi_…)', type: 'string' },
  { path: 'parent.subscription_details.subscription', label: 'parent.subscription_details.subscription — identifiant de l\'abonnement (sub_…)', type: 'string' },
  { path: 'created', label: 'created — date de création de la facture', type: 'date' },
  { path: 'due_date', label: 'due_date — échéance Stripe (null si paiement immédiat)', type: 'date' },
  { path: 'period_start', label: 'period_start — début de la période facturée', type: 'date' },
  { path: 'period_end', label: 'period_end — fin de la période facturée', type: 'date' },
  { path: 'status_transitions.finalized_at', label: 'status_transitions.finalized_at — date de finalisation', type: 'date' },
  { path: 'status_transitions.paid_at', label: 'status_transitions.paid_at — date de paiement', type: 'date' },
  { path: 'status_transitions.voided_at', label: 'status_transitions.voided_at — date d\'annulation (void)', type: 'date' },
  { path: 'effective_at', label: 'effective_at — date d\'effet de la facture', type: 'date' },
  { path: 'next_payment_attempt', label: 'next_payment_attempt — prochaine tentative de paiement', type: 'date' },
  { path: 'total', label: 'total — total de la facture (taxes incluses)', type: 'money' },
  { path: 'subtotal', label: 'subtotal — sous-total (TTC si prix taxes incluses)', type: 'money' },
  { path: 'subtotal_excluding_tax', label: 'subtotal_excluding_tax — sous-total hors taxes', type: 'money' },
  { path: 'total_excluding_tax', label: 'total_excluding_tax — total hors taxes (après rabais)', type: 'money' },
  { path: 'amount_due', label: 'amount_due — montant exigible', type: 'money' },
  { path: 'amount_paid', label: 'amount_paid — montant encaissé', type: 'money' },
  { path: 'amount_remaining', label: 'amount_remaining — restant à payer', type: 'money' },
  { path: 'amount_shipping', label: 'amount_shipping — frais de livraison', type: 'money' },
  { path: 'starting_balance', label: 'starting_balance — solde client avant application', type: 'money' },
  { path: 'ending_balance', label: 'ending_balance — solde client après application', type: 'money' },
  { path: 'attempt_count', label: 'attempt_count — nombre de tentatives de paiement', type: 'number' },
]

// Colonnes de factures déjà écrites par la logique fixe du sync Stripe (upsert
// webhooks/batch) — un champ personnalisé assis sur une de ces colonnes ne doit
// pas être re-mappable, il serait écrasé par les deux chemins.
const FIXED_WRITTEN_COLUMNS = new Set(['montant_avant_taxes', 'sync_source', 'lien_stripe', 'subscription_id'])

// Specs dynamiques : un spec par champ personnalisé kind='data' de factures
// (CLAUDE.md : tous les champs de l'ERP doivent pouvoir être mappés). Clé
// préfixée `cf:` pour ne jamais collisionner avec les clés natives. Défaut ''
// = non synchronisé — comportement historique (le sync Stripe n'y touche pas).
export function getCustomFieldSpecs() {
  let rows = []
  try {
    rows = db.prepare(`
      SELECT name, column_name, type FROM custom_fields
      WHERE erp_table='factures' AND kind='data' AND deleted_at IS NULL
      ORDER BY sort_order, name
    `).all()
  } catch { rows = [] }
  return rows
    .filter(r => !FIXED_WRITTEN_COLUMNS.has(r.column_name) && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(r.column_name))
    .map(r => ({
      key: `cf:${r.column_name}`,
      label: r.name,
      column: r.column_name,
      custom: true,
      fieldType: r.type,
      default: '',
      fallbacks: [],
      candidates: STRIPE_INVOICE_CATALOG,
    }))
}

// Champs non configurables, affichés à titre informatif dans la modale.
export const STRIPE_FACTURE_FIXED = [
  { label: 'Statut', source: "status — traduit (paid → Payé, open → À payer, void → Void…)" },
  { label: 'Devise', source: 'currency — code ISO en majuscules' },
  { label: 'Entreprise', source: 'customer — lookup companies.stripe_customer_id' },
  { label: 'Abonnement / type', source: 'parent.subscription_details.subscription — lookup subscriptions.stripe_id ; kind = subscription/order' },
  { label: 'Encaissement (date, montant, charge, PI)', source: 'status_transitions.paid_at, amount_paid, charge, payment_intent — posés seulement si status=paid' },
  { label: 'Lien Stripe', source: 'id — https://dashboard.stripe.com/invoices/{id}' },
  { label: 'PDF', source: 'invoice_pdf — téléchargé au premier passage' },
]

const CONFIG_SQL_GET = "SELECT value FROM connector_config WHERE connector='stripe' AND key='facture_field_map'"

// Map effective { key: cheminStripe } — overrides sauvegardés (valides) par-dessus
// les défauts. Ne lève jamais : config corrompue = défauts.
export function getFactureFieldMap() {
  let saved = {}
  try {
    const row = db.prepare(CONFIG_SQL_GET).get()
    if (row?.value) saved = JSON.parse(row.value) || {}
  } catch { saved = {} }
  const map = {}
  for (const f of [...STRIPE_FACTURE_FIELDS, ...getCustomFieldSpecs()]) {
    const v = saved[f.key]
    map[f.key] = (typeof v === 'string' && f.candidates.some(c => c.path === v)) ? v : f.default
  }
  return map
}

// Valide et persiste le mapping. `body` = { key: cheminStripe } complet ou partiel ;
// seules les clés connues avec un chemin candidat sont acceptées. On ne stocke que
// les écarts aux défauts — retirer un override redonne le comportement historique.
export function saveFactureFieldMap(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('field_map (objet) requis')
  }
  const specs = new Map([...STRIPE_FACTURE_FIELDS, ...getCustomFieldSpecs()].map(f => [f.key, f]))
  const overrides = {}
  for (const [k, v] of Object.entries(body)) {
    const spec = specs.get(k)
    // Champ personnalisé supprimé entre le chargement de la modale et la
    // sauvegarde : on l'ignore silencieusement plutôt que de bloquer le save.
    if (!spec && k.startsWith('cf:')) continue
    if (!spec) throw new Error(`Champ inconnu : ${k}`)
    if (v == null || v === '' || v === spec.default) continue
    if (typeof v !== 'string' || !spec.candidates.some(c => c.path === v)) {
      throw new Error(`Champ Stripe invalide pour ${spec.label} : ${v}`)
    }
    overrides[k] = v
  }
  db.prepare(`
    INSERT INTO connector_config (connector, key, value) VALUES ('stripe', 'facture_field_map', ?)
    ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
  `).run(JSON.stringify(overrides))
  return getFactureFieldMap()
}

// Lecture d'un chemin pointé ('status_transitions.finalized_at') dans l'invoice.
// Exporté : partagé avec stripeSubscriptionFieldMap.js (pendant abonnements).
export function getPath(obj, path) {
  let cur = obj
  for (const part of path.split('.')) {
    if (cur == null) return null
    cur = cur[part]
  }
  return cur ?? null
}

export function convert(raw, type) {
  if (type === 'money') return (raw ?? 0) / 100
  if (type === 'date') return raw ? new Date(raw * 1000).toISOString().slice(0, 10) : null
  return raw || null // string — '' → null
}

// Résout tous les champs configurables d'une invoice Stripe selon le mapping
// courant. Retourne { document_number, document_date, due_date,
// amount_before_tax, total_amount, balance_due } prêts à insérer.
export function resolveStripeInvoiceFields(invoice) {
  const map = getFactureFieldMap()
  const out = {}
  for (const f of STRIPE_FACTURE_FIELDS) {
    let raw = getPath(invoice, map[f.key])
    // Chaîne de repli historique (ex. subtotal_excluding_tax ?? subtotal) —
    // appliquée seulement si le chemin choisi ne donne rien.
    for (const fb of f.fallbacks) {
      if (raw != null) break
      if (fb !== map[f.key]) raw = getPath(invoice, fb)
    }
    out[f.key] = convert(raw, f.type)
  }
  return out
}

// Résout les champs personnalisés mappés → { column_name: valeur }. Le type de
// conversion vient du chemin Stripe choisi (catalogue), pas de la colonne ERP.
// Les objets expandés (customer, charge…) sont réduits à leur id.
export function resolveStripeInvoiceCustomColumns(invoice) {
  const specs = getCustomFieldSpecs()
  if (!specs.length) return {}
  const map = getFactureFieldMap()
  const out = {}
  for (const f of specs) {
    const path = map[f.key]
    if (!path) continue // non synchronisé (défaut)
    let raw = getPath(invoice, path)
    if (raw && typeof raw === 'object' && typeof raw.id === 'string') raw = raw.id
    const cand = STRIPE_INVOICE_CATALOG.find(c => c.path === path)
    if (raw == null) { out[f.column] = null; continue }
    const t = cand?.type || 'string'
    out[f.column] = t === 'money' ? raw / 100
      : t === 'date' ? new Date(raw * 1000).toISOString().slice(0, 10)
      : t === 'number' ? raw
      : String(raw)
  }
  return out
}

// Applique les colonnes personnalisées mappées sur une facture déjà upsertée.
// Appelé par les deux chemins de sync (webhook temps réel et batch-enrich).
// Les noms de colonnes viennent de custom_fields.column_name, déjà filtrés au
// pattern identifiant dans getCustomFieldSpecs — sûrs à interpoler.
export function applyStripeCustomFieldColumns(factureId, invoice) {
  const cols = resolveStripeInvoiceCustomColumns(invoice)
  const names = Object.keys(cols)
  if (!names.length) return
  try {
    const sets = names.map(c => `${c}=?`).join(', ')
    db.prepare(`UPDATE factures SET ${sets} WHERE id=?`).run(...names.map(c => cols[c]), factureId)
  } catch (e) {
    // Colonne disparue (champ supprimé) ou valeur incompatible — ne jamais
    // faire échouer le sync Stripe pour un champ personnalisé.
    console.error(`⚠️ Stripe custom field map ${factureId}:`, e.message)
  }
}
