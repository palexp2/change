import { useState, useEffect, useCallback, useMemo } from 'react'
import api from './api.js'
import { fmtDate } from './formatDate.js'
import { formatCurrency, UrlValue, PhoneValue, isCheckboxTruthy } from './customFieldDisplay.jsx'

// Overrides d'affichage des champs NATIFS d'une table (renommage / changement
// de type) — pendant, pour les colonnes définies en dur dans tableDefs.js, du
// CustomFieldModal des champs custom. L'override est purement cosmétique :
// aucune colonne SQL n'est modifiée, les syncs continuent d'écrire dans les
// colonnes d'origine. Persisté côté serveur (table field_overrides) via
// /api/field-overrides, appliqué par DataTable via applyFieldOverrides().

// Types d'affichage proposés dans la modale commune de champ (CustomFieldModal,
// mode natif). Doit rester aligné avec
// ALLOWED_TYPES côté serveur (routes/field-overrides.js).
export const OVERRIDE_TYPES = [
  { value: 'text',     label: 'Texte' },
  { value: 'number',   label: 'Nombre' },
  { value: 'currency', label: 'Devise (CAD)' },
  { value: 'date',     label: 'Date' },
  { value: 'boolean',  label: 'Case à cocher' },
  { value: 'url',      label: 'URL' },
  { value: 'phone',    label: 'Téléphone' },
]

// Libellé FR d'un type de colonne (types d'override + types natifs tableDefs).
export function typeLabel(type) {
  const t = OVERRIDE_TYPES.find(o => o.value === type)
  if (t) return t.label
  return {
    single_select: 'Sélection',
    multi_select:  'Sélection multiple',
    duration:      'Durée',
    user:          'Utilisateur',
    button:        'Bouton',
  }[type] || 'Texte'
}

// Tables dont les champs natifs sont alimentés par une synchronisation externe.
// Sert uniquement à l'avertissement de la modale de champ quand l'utilisateur
// change le type d'un champ : si la sync continue d'écrire des valeurs du type
// d'origine, l'affichage/tri/filtres peuvent devenir incohérents. Les clés
// dérivées (company_*, project_*) pointent vers la même source que la table mère.
const SYNC_MANAGED_TABLES = {
  factures:            'les syncs Stripe (factures / remboursements) et Airtable (Factures)',
  project_factures:    'les syncs Stripe (factures / remboursements) et Airtable (Factures)',
  company_factures:    'les syncs Stripe (factures / remboursements) et Airtable (Factures)',
  orders:              'la sync Airtable (Commandes)',
  company_orders:      'la sync Airtable (Commandes)',
  products:            'la sync Airtable (Pièces)',
  purchases:           'la sync Airtable (Achats)',
  company_achats:      'la sync Airtable (Achats)',
  tickets:             'la sync Airtable (Billets)',
  company_tickets:     'la sync Airtable (Billets)',
  serial_numbers:      'la sync Airtable (Numéros de série)',
  company_serials:     'la sync Airtable (Numéros de série)',
  shipments:           'la sync Airtable (Envois)',
  company_envois:      'la sync Airtable (Envois)',
  soumissions:         'la sync Airtable (Soumissions)',
  project_soumissions: 'la sync Airtable (Soumissions)',
  retours:             'la sync Airtable (Retours)',
  company_retours:     'la sync Airtable (Retours)',
  bom_items:           'la sync Airtable (BOM)',
  assemblages:         'la sync Airtable (Assemblages)',
  projects:            'la sync Airtable (Projets)',
  abonnements:         'la sync Stripe (Abonnements)',
  company_abonnements: 'la sync Stripe (Abonnements)',
  abonnement_events:   'la sync Stripe (Abonnements)',
  stripe_payouts:      'la sync Stripe (Payouts)',
  stripe_invoice_items:'la sync Stripe (Items vendus)',
  sale_receipts:       "l'ingestion Gmail des reçus / factures fournisseurs",
  achats_fournisseurs: "l'ingestion des factures fournisseurs",
  companies:           'les syncs HubSpot / Airtable (Clients)',
  contacts:            'les syncs HubSpot / Airtable (Contacts)',
  journal_entries:     'la sync QuickBooks (écritures de journal)',
}

// Nom de la sync qui alimente les champs natifs de `table`, ou null si la
// table n'est pas connue comme synchronisée.
export function syncSourceForTable(table) {
  return SYNC_MANAGED_TABLES[table] || null
}

// Hook : charge les overrides actifs d'une table. Retourne { overrides, reload }
// où `overrides` est une Map field_id → { field_id, label, type, decimals }.
// `table` falsy → pas de fetch (usage conditionnel, comme useCustomFields).
export function useFieldOverrides(table) {
  const [list, setList] = useState([])
  const reload = useCallback(() => {
    if (!table) { setList([]); return Promise.resolve() }
    return api.fieldOverrides.list(table)
      .then(d => setList(d.data || []))
      .catch(() => setList([]))
  }, [table])
  useEffect(() => { reload() }, [reload])
  const overrides = useMemo(() => {
    const m = new Map()
    for (const o of list) m.set(o.field_id, o)
    return m
  }, [list])
  return { overrides, reload }
}

// Type de colonne DataTable correspondant à un type d'override (pilote les
// opérateurs de filtre, le tri et l'éditeur inline).
const OVERRIDE_TO_COLUMN_TYPE = {
  text: 'text',
  number: 'number',
  currency: 'number',
  date: 'date',
  boolean: 'boolean',
  url: 'text',
  phone: 'text',
}

// Rendu générique d'une valeur selon le type d'override — remplace le render()
// spécifique de la page quand le type est changé (l'ancien render suppose la
// sémantique du type d'origine, ex. fmtCad sur un montant).
export function renderOverriddenValue(ov, value) {
  if (ov.type === 'boolean') {
    return <span className={isCheckboxTruthy(value) ? 'text-slate-700' : 'text-slate-400'}>{isCheckboxTruthy(value) ? 'Oui' : 'Non'}</span>
  }
  if (value == null || value === '') return <span className="text-slate-400">—</span>
  if (ov.type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return <span className="text-slate-700">{String(value)}</span>
    const d = Number.isInteger(ov.decimals) ? Math.max(0, Math.min(5, ov.decimals)) : null
    const formatted = d == null
      ? n.toLocaleString('fr-CA')
      : n.toLocaleString('fr-CA', { minimumFractionDigits: d, maximumFractionDigits: d })
    return <span className="tabular-nums text-slate-700">{formatted}</span>
  }
  if (ov.type === 'currency') {
    const formatted = formatCurrency(value, ov.decimals ?? 2)
    return <span className="tabular-nums text-slate-700">{formatted != null ? formatted : String(value)}</span>
  }
  if (ov.type === 'date') return <span className="text-slate-500">{fmtDate(value)}</span>
  if (ov.type === 'url') return <UrlValue value={value} />
  if (ov.type === 'phone') return <PhoneValue value={value} countryCode={phoneCountryCodePref(ov)} />
  return <span className="text-slate-700">{String(value)}</span>
}

// Résout la préférence d'indicatif de pays d'un override téléphone. Valeurs
// stockées : 'show' | 'hide' | null (défaut → 'auto', comportement historique).
function phoneCountryCodePref(ov) {
  return ov?.country_code === 'show' || ov?.country_code === 'hide' ? ov.country_code : 'auto'
}

// Applique les overrides aux colonnes d'une DataTable (match par col.id).
// - label : remplace le libellé partout (en-tête, panneau Champs, filtres…).
// - type  : si différent du type d'origine, remplace le type de colonne ET le
//   render de la page (dont la logique suppose le type d'origine).
export function applyFieldOverrides(columns, overrides) {
  if (!overrides || overrides.size === 0) return columns
  return columns.map(col => {
    const ov = overrides.get(col.id)
    if (!ov) return col
    const next = { ...col }
    if (ov.label) next.label = ov.label
    const origType = col.type || 'text'
    if (ov.type && ov.type !== origType) {
      next.type = OVERRIDE_TO_COLUMN_TYPE[ov.type] || 'text'
      next.render = row => renderOverriddenValue(ov, row[col.field])
      // Les choix d'un ancien single_select n'ont plus de sens pour le filtre.
      if (next.type !== 'single_select') { delete next.options; delete next.selectChoices }
    } else if (origType === 'phone' && (ov.country_code === 'show' || ov.country_code === 'hide')) {
      // Champ téléphone natif dont seule la préférence d'indicatif change : on
      // remplace le rendu par PhoneValue (le render natif fmtPhone masque
      // toujours l'indicatif) sans toucher au type/tri/filtre.
      next.render = row => renderOverriddenValue({ type: 'phone', country_code: ov.country_code }, row[col.field])
    }
    return next
  })
}
