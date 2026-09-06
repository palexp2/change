import { useState, useEffect, useCallback, useMemo } from 'react'
import api from './api.js'
import { fmtDate } from './formatDate.js'
import { fmtNumber } from '../utils/formatters.js'
import {
  formatCurrency, UrlValue, PhoneValue, isCheckboxTruthy, parseAttachments, LinkedRecordsValue,
} from './customFieldDisplay.jsx'
import { TABLE_LABELS, TABLE_RECORD_LABELS } from './tableDefs.js'
import { Badge } from '../components/Badge.jsx'
import { seedFieldGate } from './fieldGate.js'

// Personnalisation d'affichage des champs NATIFS d'une table (renommage /
// changement de type) — les colonnes définies en dur dans tableDefs.js.
// Purement cosmétique : aucune colonne SQL n'est modifiée, les syncs continuent
// d'écrire dans les colonnes d'origine. Depuis l'unification des champs, c'est
// persisté dans custom_fields (kind='native') via /api/custom-fields/:table/native
// — même table et même route que les champs perso — et appliqué par DataTable
// via applyFieldOverrides().

// Types d'affichage proposés dans la modale commune de champ (CustomFieldModal,
// mode natif). Doit rester aligné avec NATIVE_TYPES côté serveur
// (routes/custom-fields.js).
export const OVERRIDE_TYPES = [
  { value: 'text',     label: 'Texte' },
  { value: 'number',   label: 'Nombre' },
  { value: 'currency', label: 'Devise (CAD)' },
  { value: 'date',     label: 'Date' },
  // 'checkbox' est le vocabulaire unifié (celui des champs perso) ; 'boolean'
  // reste accepté en lecture pour les personnalisations écrites avant la fusion.
  { value: 'checkbox', label: 'Case à cocher' },
  { value: 'url',      label: 'URL' },
  { value: 'phone',    label: 'Téléphone' },
]

// Famille « lien vers une autre table » : le type vaut `link:<table ERP>`, la
// cible est portée par le type lui-même (un champ natif n'a pas d'autre endroit
// où la ranger, et le réglage reste réversible d'un simple changement de type).
// La valeur de la colonne est résolue par le serveur — id ERP, record ID
// Airtable, ou simplement le NOM de la fiche (`projects.company_name` porte le
// nom de l'entreprise, pas son id). Cf. server/src/services/recordLinks.js.
export const LINK_TYPE_PREFIX = 'link:'

// Table cible d'un type `link:<table>`, ou null si ce n'en est pas un.
export function linkTargetOfType(type) {
  const t = String(type || '')
  return t.startsWith(LINK_TYPE_PREFIX) ? t.slice(LINK_TYPE_PREFIX.length) : null
}

// Nom d'UNE fiche de la table cible : « Entreprise », pas « Entreprises » — le
// champ mène à un enregistrement, pas à la liste.
export function linkTargetLabel(table) {
  return TABLE_RECORD_LABELS[table] || TABLE_LABELS[table] || table
}

// Normalise un type venu de tableDefs.js vers le vocabulaire unifié des champs
// (celui de custom_fields). Seul 'boolean' diffère — même chose que 'checkbox'
// sous un autre nom, héritage des deux systèmes de champs d'avant la fusion.
export function normalizeFieldType(type) {
  if (!type) return 'text'
  return type === 'boolean' ? 'checkbox' : type
}

// Libellé FR d'un type de colonne (types d'override + types natifs tableDefs).
export function typeLabel(type) {
  const t = OVERRIDE_TYPES.find(o => o.value === type)
  if (t) return t.label
  if (type === 'boolean') return 'Case à cocher'
  const target = linkTargetOfType(type)
  if (target) return `Lien vers ${linkTargetLabel(target)}`
  return {
    link:          'Lien',
    long_text:     'Texte long',
    single_select: 'Sélection',
    multi_select:  'Sélection multiple',
    duration:      'Durée',
    user:          'Utilisateur',
    button:        'Bouton',
    attachment:    'Attachement',
  }[type] || 'Texte'
}

// Libellé FR de la FAMILLE d'un champ perso (custom_fields.kind), pour les
// champs virtuels dont le seul type de valeur ne dit pas grand-chose : une
// formule qui rend du texte n'est pas un champ texte. `null` pour un champ
// « donnée » ordinaire — c'est alors typeLabel(type) qui le nomme.
export function kindLabel(kind) {
  return {
    formula:            'Formule',
    lookup:             'Lookup',
    rollup:             'Rollup',
    button:             'Bouton',
    link:               'Lien',
    created_time:       'Créé le',
    last_modified_time: 'Modifié le',
    created_by:         'Créé par',
    last_modified_by:   'Modifié par',
  }[kind] || null
}

// Champs dont la valeur est PRODUITE par l'ERP (recalculée à la lecture, ou
// posée par le système à l'écriture) : aucun champ Airtable ne peut les
// alimenter. `data` et `native` en sont exclus — ce sont de vraies colonnes
// stockées, donc mappables. Le mapping est refusé côté serveur aussi
// (routes/connectors.js, airtableFieldMappingHandler).
const COMPUTED_KINDS = new Set([
  'formula', 'lookup', 'rollup', 'button',
  'created_time', 'last_modified_time', 'created_by', 'last_modified_by',
])
export function isComputedKind(kind) {
  return COMPUTED_KINDS.has(kind)
}

// Champs calculés qui peuvent quand même être POUSSÉS vers Airtable : rien ne
// les alimente depuis Airtable, mais leur valeur (calculée par la vue
// <table>_v) s'écrit très bien dans un champ Airtable. Seul le bouton en est
// exclu — une action ne porte aucune valeur. Le serveur décide au cas par cas
// (il faut aussi que la table sache écrire vers Airtable) et le dit via
// `push_only` sur la colonne — cf. services/airtableWriteback.js.
export function isPushOnlyKind(kind) {
  return isComputedKind(kind) && kind !== 'button'
}

// Pourquoi ce champ n'accepte aucun mapping Airtable — texte affiché tel quel
// (fiche du champ) ou en infobulle (colonne « Champ Airtable » du tableau).
export function noMappingReason(kind) {
  if (!isComputedKind(kind)) return null
  const k = kindLabel(kind) || 'calculé'
  return kind === 'button'
    ? 'Champ bouton : il déclenche une action et ne porte aucune valeur — rien à importer d’Airtable.'
    : `Champ « ${k} » : sa valeur est produite par l’ERP, aucun champ Airtable ne peut l’alimenter.`
}

// Infobulle d'un champ calculé mappable en push seulement (cellule « Champ
// Airtable » et icône de sens du tableau des champs).
export function pushOnlyMappingReason(kind) {
  const k = kindLabel(kind) || 'calculé'
  return `Champ « ${k} » : calculé par Boréal, donc poussé vers Airtable — jamais importé.`
}

// Hook : charge les overrides actifs d'une table. Retourne { overrides, reload }
// où `overrides` est une Map field_id → { field_id, label, type, decimals }.
// `table` falsy → pas de fetch (usage conditionnel, comme useCustomFields).
export function useFieldOverrides(table) {
  const [list, setList] = useState([])
  const reload = useCallback(() => {
    if (!table) { setList([]); return Promise.resolve() }
    return api.fieldOverrides.list(table)
      // Le portier des champs supprimés lit la même route : on l'alimente au
      // passage pour qu'une suppression faite ici se voie immédiatement sur les
      // fiches et formulaires déjà montés (cf. lib/fieldGate.js).
      .then(d => { setList(d.data || []); seedFieldGate(table, d.data || []) })
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
  checkbox: 'boolean',
  boolean: 'boolean',
  url: 'text',
  phone: 'text',
}

// Rendu générique d'une valeur selon le type d'override — remplace le render()
// spécifique de la page quand le type est changé (l'ancien render suppose la
// sémantique du type d'origine, ex. fmtCad sur un montant).
export function renderOverriddenValue(ov, value) {
  const linkTarget = linkTargetOfType(ov.type)
  if (linkTarget) {
    return (
      <LinkedRecordsValue
        field={{ record_link_target: linkTarget }}
        value={value}
        byLabel
      />
    )
  }
  if (ov.type === 'checkbox' || ov.type === 'boolean') {
    return <span className={isCheckboxTruthy(value) ? 'text-slate-700' : 'text-slate-400'}>{isCheckboxTruthy(value) ? 'Oui' : 'Non'}</span>
  }
  if (value == null || value === '') return <span className="text-slate-400">—</span>
  // Attachement : la valeur est un tableau JSON de fichiers. Sans l'id du champ
  // ni celui de l'enregistrement (ce rendu générique ne les reçoit pas), on ne
  // peut pas construire les liens — on affiche le nombre de fichiers plutôt que
  // le JSON brut. Les fiches passent par <AttachmentField> pour la vraie vue.
  if (ov.type === 'attachment') {
    const n = parseAttachments(value).length
    return <span className="text-slate-600">{n ? `${n} fichier${n > 1 ? 's' : ''}` : '—'}</span>
  }
  if (ov.type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return <span className="text-slate-700">{String(value)}</span>
    const d = Number.isInteger(ov.decimals) ? Math.max(0, Math.min(5, ov.decimals)) : null
    const formatted = fmtNumber(n, { decimals: d })
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

// Choix personnalisés d'un champ natif de type Sélection, lus depuis la config
// `options` (JSON string côté serveur) : [{ value, label, color|null }].
// `value` est la valeur RÉELLEMENT stockée en base (jamais réécrite) ; `label`
// est son affichage ; `color` à null = « couleur d'origine », c'est-à-dire le
// rendu que la page fait déjà de cette valeur.
export function parseNativeChoices(ov) {
  let opts = ov?.options
  if (!opts) return []
  if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch { return [] } }
  const choices = Array.isArray(opts?.choices) ? opts.choices : []
  return choices
    .map(c => {
      const value = String(c?.value ?? c?.label ?? '')
      return { value, id: value, label: String(c?.label ?? value), color: c?.color || null }
    })
    .filter(c => c.value !== '')
}

// Valeurs d'un multi_select natif : tableau JSON (forme écrite par les syncs et
// les éditeurs de l'app) ou valeur simple.
function parseMultiValues(value) {
  if (Array.isArray(value)) return value.map(String).filter(v => v !== '')
  if (value == null || value === '') return []
  const str = String(value)
  if (str.trim().startsWith('[')) {
    try { const a = JSON.parse(str); if (Array.isArray(a)) return a.map(String).filter(v => v !== '') } catch { /* texte libre */ }
  }
  return [str]
}

// Rendu d'une valeur de Sélection native selon les choix configurés. Un choix
// laissé à sa couleur d'origine et non renommé retombe sur le rendu de la page
// (badge maison, pastille…) : personnaliser l'ORDRE d'une liste ne doit pas
// faire perdre les couleurs déjà en place.
function renderNativeSelectValue(choices, value, origRender, row, multi) {
  const byValue = new Map(choices.map(c => [c.value, c]))
  const values = multi ? parseMultiValues(value) : (value == null || value === '' ? [] : [String(value)])
  if (values.length === 0) return origRender ? origRender(row) : <span className="text-slate-400">—</span>
  const untouched = values.every(v => {
    const c = byValue.get(v)
    return !c || (!c.color && c.label === v)
  })
  if (untouched && origRender) return origRender(row)
  return (
    <div className="flex items-center gap-1 overflow-hidden">
      {values.map((v, i) => {
        const c = byValue.get(v)
        return (
          <Badge key={i} color={c?.color || 'gray'} className="shrink-0 whitespace-nowrap">
            {c?.label || v}
          </Badge>
        )
      })}
    </div>
  )
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
    // Description saisie par l'utilisateur : remplace celle codée dans
    // tableDefs.js (infobulle « ? » de l'en-tête de colonne).
    if (ov.description) next.description = ov.description
    const origType = col.type || 'text'
    if (ov.type && ov.type !== origType) {
      next.type = OVERRIDE_TO_COLUMN_TYPE[ov.type] || 'text'
      // Type choisi par l'utilisateur, conservé pour l'affichage (icône de type
      // du panneau « Champs ») : la table ci-dessus l'aplatit vers le type de
      // colonne DataTable (devise → 'number', URL/téléphone → 'text').
      next.fieldType = ov.type
      next.render = row => renderOverriddenValue(ov, row[col.field])
      // Le rendu sur-mesure de la page a été remplacé : son nom de type ne doit
      // plus être annoncé (sinon /champs/:table continue d'afficher « Lien vers
      // Entreprise » sur un champ passé en Nombre).
      next.renderTypeLabel = typeLabel(ov.type)
      // Les choix d'un ancien single_select n'ont plus de sens pour le filtre.
      if (next.type !== 'single_select') { delete next.options; delete next.selectChoices }
    } else if ((origType === 'single_select' || origType === 'multi_select') && ov.options) {
      // Sélection native personnalisée : ordre, libellés d'affichage et couleurs
      // des choix. La colonne garde son type (tri/filtre/éditeur inline
      // inchangés) ; seuls les choix proposés et leur rendu suivent la config.
      const choices = parseNativeChoices(ov)
      if (choices.length) {
        const origRender = col.render
        next.selectChoices = choices
        // Le filtre compare des valeurs BRUTES (le renommage est cosmétique) :
        // on lui donne les valeurs, pas les libellés.
        next.options = choices.map(c => c.value)
        next.render = row => renderNativeSelectValue(choices, row[col.field], origRender, row, origType === 'multi_select')
      }
    } else if (origType === 'phone' && (ov.country_code === 'show' || ov.country_code === 'hide')) {
      // Champ téléphone natif dont seule la préférence d'indicatif change : on
      // remplace le rendu par PhoneValue (le render natif fmtPhone masque
      // toujours l'indicatif) sans toucher au type/tri/filtre.
      next.render = row => renderOverriddenValue({ type: 'phone', country_code: ov.country_code }, row[col.field])
    }
    return next
  })
}

// Applique l'ordre d'affichage choisi par l'utilisateur (sort_order des
// overrides, persisté par la modale de configuration des champs). Les champs
// sans ordre explicite restent à leur position d'origine, après les champs
// ordonnés. Les colonnes d'action (`alwaysVisible`) ne sont jamais déplacées :
// elles restent en fin de tableau.
export function applyFieldOrder(columns, overrides) {
  if (!overrides || overrides.size === 0) return columns
  let hasOrder = false
  for (const o of overrides.values()) if (o.sort_order != null) { hasOrder = true; break }
  if (!hasOrder) return columns
  const pinned = columns.filter(c => c.alwaysVisible)
  const orderable = columns.filter(c => !c.alwaysVisible)
  const keyed = orderable.map((c, i) => {
    const so = overrides.get(c.id)?.sort_order
    return { c, ordered: so != null, so: so ?? 0, i }
  })
  keyed.sort((a, b) => {
    if (a.ordered !== b.ordered) return a.ordered ? -1 : 1
    if (a.ordered) return a.so - b.so || a.i - b.i
    return a.i - b.i
  })
  return [...keyed.map(k => k.c), ...pinned]
}
