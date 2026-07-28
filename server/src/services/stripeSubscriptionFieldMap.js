// Mapping configurable des champs Stripe → colonnes de la table `subscriptions`.
//
// Pendant abonnements de stripeFactureFieldMap.js : l'utilisateur choisit, pour
// chaque colonne ERP configurable, quel champ de l'objet Stripe Subscription
// l'alimente (modale « Sync Stripe » sur /abonnements). La config vit dans
// connector_config (connector='stripe', key='subscription_field_map') sous forme
// d'overrides JSON — absence de config = comportement historique inchangé.
//
// Les champs « fixes » (statut, montant mensuel, entreprise, intervalle…) ne
// sont pas configurables : leur logique dépasse un simple choix de champ source
// (mapping de statuts, computeMonthlyNet, lookups DB). Ils sont déclarés ici
// (STRIPE_SUBSCRIPTION_FIXED) pour que la modale les affiche.
//
// Le mapping est appliqué par les DEUX chemins de sync (polling
// syncStripeSubscriptions et webhook customer.subscription.*) — sinon le
// prochain webhook écraserait les valeurs resynchronisées avec le mapping.

import db from '../db/database.js'
import { getPath, convert } from './stripeFactureFieldMap.js'

// Chaque spec : colonne ERP ← chemin dans l'objet Stripe Subscription.
// Mêmes conventions que STRIPE_FACTURE_FIELDS (type, default, fallbacks,
// candidates — la sauvegarde est restreinte à cette liste).
export const STRIPE_SUBSCRIPTION_FIELDS = [
  {
    key: 'start_date', label: 'Date de début', column: 'start_date', type: 'date',
    default: 'start_date', fallbacks: [],
    candidates: [
      { path: 'start_date', label: "start_date — début de l'abonnement (survit aux changements de plan)" },
      { path: 'created', label: "created — date de création de l'objet Stripe" },
      { path: 'billing_cycle_anchor', label: 'billing_cycle_anchor — ancre du cycle de facturation' },
      { path: 'trial_start', label: "trial_start — début de la période d'essai" },
    ],
  },
  {
    key: 'cancel_date', label: "Date d'annulation", column: 'cancel_date', type: 'date',
    default: 'canceled_at', fallbacks: [],
    candidates: [
      { path: 'canceled_at', label: "canceled_at — date de la demande d'annulation" },
      { path: 'ended_at', label: "ended_at — fin effective de l'abonnement" },
      { path: 'cancel_at', label: 'cancel_at — annulation programmée (fin de période)' },
    ],
  },
  {
    key: 'trial_end_date', label: "Fin d'essai", column: 'trial_end_date', type: 'date',
    default: 'trial_end', fallbacks: [],
    candidates: [
      { path: 'trial_end', label: "trial_end — fin de la période d'essai" },
      { path: 'trial_start', label: "trial_start — début de la période d'essai" },
    ],
  },
  {
    key: 'customer_email', label: 'Courriel du client', column: 'customer_email', type: 'string',
    default: 'customer.email', fallbacks: [],
    hint: "Identifie les clients Stripe sans entreprise dans l'ERP",
    candidates: [
      { path: 'customer.email', label: 'customer.email — courriel du client Stripe' },
      { path: 'customer.name', label: 'customer.name — nom du client Stripe' },
      { path: 'customer.description', label: 'customer.description — description du client Stripe' },
    ],
  },
]

// Champs non configurables, affichés à titre informatif dans la modale.
export const STRIPE_SUBSCRIPTION_FIXED = [
  { label: 'Statut', source: 'status — traduit (active, trialing, past_due, canceled…)' },
  { label: 'Montant mensuel', source: 'latest_invoice.total_excluding_tax ?? items × qty − rabais — net, avant taxes, mensualisé (computeMonthlyNet)' },
  { label: 'Devise', source: 'currency — code ISO en majuscules' },
  { label: 'Entreprise', source: 'customer — lookup companies.stripe_customer_id' },
  { label: 'Intervalle', source: 'items[0].price.recurring — interval_count + interval (mois/année)' },
  { label: 'Client Stripe', source: 'customer — identifiant cus_…' },
  { label: 'Lien Stripe', source: 'id — https://dashboard.stripe.com/subscriptions/{id}' },
]

const CONFIG_SQL_GET = "SELECT value FROM connector_config WHERE connector='stripe' AND key='subscription_field_map'"

// Map effective { key: cheminStripe } — overrides sauvegardés (valides) par-dessus
// les défauts. Ne lève jamais : config corrompue = défauts.
export function getSubscriptionFieldMap() {
  let saved = {}
  try {
    const row = db.prepare(CONFIG_SQL_GET).get()
    if (row?.value) saved = JSON.parse(row.value) || {}
  } catch { saved = {} }
  const map = {}
  for (const f of STRIPE_SUBSCRIPTION_FIELDS) {
    const v = saved[f.key]
    map[f.key] = (typeof v === 'string' && f.candidates.some(c => c.path === v)) ? v : f.default
  }
  return map
}

// Valide et persiste le mapping. Seules les clés connues avec un chemin candidat
// sont acceptées ; on ne stocke que les écarts aux défauts.
export function saveSubscriptionFieldMap(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('field_map (objet) requis')
  }
  const specs = new Map(STRIPE_SUBSCRIPTION_FIELDS.map(f => [f.key, f]))
  const overrides = {}
  for (const [k, v] of Object.entries(body)) {
    const spec = specs.get(k)
    if (!spec) throw new Error(`Champ inconnu : ${k}`)
    if (v == null || v === '' || v === spec.default) continue
    if (typeof v !== 'string' || !spec.candidates.some(c => c.path === v)) {
      throw new Error(`Champ Stripe invalide pour ${spec.label} : ${v}`)
    }
    overrides[k] = v
  }
  db.prepare(`
    INSERT INTO connector_config (connector, key, value) VALUES ('stripe', 'subscription_field_map', ?)
    ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
  `).run(JSON.stringify(overrides))
  return getSubscriptionFieldMap()
}

// Résout tous les champs configurables d'un Subscription Stripe selon le mapping
// courant. Retourne { start_date, cancel_date, trial_end_date, customer_email }
// prêts à insérer. Nota : côté webhook, `customer` n'est pas expandé (string) —
// les chemins customer.* y résolvent null, mais le webhook n'écrit pas ces
// colonnes de toute façon.
export function resolveStripeSubscriptionFields(sub) {
  const map = getSubscriptionFieldMap()
  const out = {}
  for (const f of STRIPE_SUBSCRIPTION_FIELDS) {
    let raw = getPath(sub, map[f.key])
    for (const fb of f.fallbacks) {
      if (raw != null) break
      if (fb !== map[f.key]) raw = getPath(sub, fb)
    }
    out[f.key] = convert(raw, f.type)
  }
  return out
}
