import { useState, useEffect, useMemo, useRef } from 'react'
import { Plus, X, Check, Star, AlertTriangle, RotateCcw } from 'lucide-react'
import { Modal } from './Modal.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import api from '../lib/api.js'
import { OVERRIDE_TYPES, typeLabel, syncSourceForTable, normalizeFieldType } from '../lib/fieldOverrides.jsx'
import { formatDurationSeconds, normalizeDurationFormat } from '../lib/duration.js'
import { currencyCodeOf, phoneCountryCodeOf, dateFormatOf } from '../lib/customFieldDisplay.jsx'
import { DATE_DISPLAY_FORMATS, normalizeDateFormat } from '../lib/formatDate.js'
import { TABLE_LABELS, TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { groupDependents, DEPENDENT_CATEGORY_LABELS } from '../lib/customFieldDeps.js'

// Libellé UI d'une colonne cible (lookup/rollup) : label curé des DataTables
// (tableDefs) > nom du champ Airtable (renvoyé par le serveur) > nom technique.
// Affiche les champs comme l'utilisateur les voit ailleurs dans l'app.
function uiColumnLabel(table, opt) {
  const meta = (TABLE_COLUMN_META[table] || []).find(c => c.field === opt.column)
  const label = meta?.label || opt.label
  return label ? `${label} (${opt.column})` : opt.column
}

function uiTableLabel(table) {
  return TABLE_LABELS[table] ? `${TABLE_LABELS[table]} (${table})` : table
}

// Agrégations de rollup (alignées sur ROLLUP_AGGS serveur). ARRAY / ARRAYUNIQUE
// concatènent les valeurs liées (toutes / distinctes) en une liste texte.
const ROLLUP_AGG_OPTIONS = [
  { value: 'SUM', label: 'SUM' },
  { value: 'COUNT', label: 'COUNT' },
  { value: 'AVG', label: 'AVG' },
  { value: 'MIN', label: 'MIN' },
  { value: 'MAX', label: 'MAX' },
  { value: 'ARRAY', label: 'ARRAY' },
  { value: 'ARRAYUNIQUE', label: 'UNIQUE' },
]
const isArrayAgg = agg => agg === 'ARRAY' || agg === 'ARRAYUNIQUE'

// Styles d'un champ Bouton (alignés sur BUTTON_STYLES serveur + BUTTON_STYLE_CLS client).
const BUTTON_STYLE_OPTIONS = [
  { v: 'brand', label: 'Bleu',  dot: 'bg-brand-500' },
  { v: 'green', label: 'Vert',  dot: 'bg-green-500' },
  { v: 'red',   label: 'Rouge', dot: 'bg-red-500' },
  { v: 'slate', label: 'Gris',  dot: 'bg-slate-400' },
]

// Devises proposées pour un champ « Devise » (code ISO 4217 + libellé fr).
// Plus de 10 options → sélecteur avec recherche (règle « dropdowns avec
// recherche »). Le serveur accepte tout code ISO à 3 lettres.
const CURRENCY_OPTIONS = [
  { code: 'CAD', label: 'Dollar canadien' },
  { code: 'USD', label: 'Dollar américain' },
  { code: 'EUR', label: 'Euro' },
  { code: 'GBP', label: 'Livre sterling' },
  { code: 'AUD', label: 'Dollar australien' },
  { code: 'NZD', label: 'Dollar néo-zélandais' },
  { code: 'JPY', label: 'Yen japonais' },
  { code: 'CNY', label: 'Yuan chinois' },
  { code: 'CHF', label: 'Franc suisse' },
  { code: 'HKD', label: 'Dollar de Hong Kong' },
  { code: 'SGD', label: 'Dollar de Singapour' },
  { code: 'SEK', label: 'Couronne suédoise' },
  { code: 'NOK', label: 'Couronne norvégienne' },
  { code: 'DKK', label: 'Couronne danoise' },
  { code: 'MXN', label: 'Peso mexicain' },
  { code: 'BRL', label: 'Réal brésilien' },
  { code: 'INR', label: 'Roupie indienne' },
  { code: 'KRW', label: 'Won sud-coréen' },
  { code: 'PLN', label: 'Złoty polonais' },
  { code: 'CZK', label: 'Couronne tchèque' },
  { code: 'HUF', label: 'Forint hongrois' },
  { code: 'ZAR', label: 'Rand sud-africain' },
  { code: 'TRY', label: 'Livre turque' },
  { code: 'AED', label: 'Dirham des Émirats' },
  { code: 'SAR', label: 'Riyal saoudien' },
  { code: 'ILS', label: 'Shekel israélien' },
  { code: 'THB', label: 'Baht thaïlandais' },
  { code: 'PHP', label: 'Peso philippin' },
  { code: 'TWD', label: 'Dollar taïwanais' },
  { code: 'COP', label: 'Peso colombien' },
  { code: 'CLP', label: 'Peso chilien' },
]

// Palette de couleurs des choix (alignée sur Badge.jsx + SELECT_COLORS serveur).
const SELECT_COLORS = ['gray', 'slate', 'blue', 'indigo', 'green', 'yellow', 'orange', 'red', 'purple', 'pink', 'teal']
// Pastille de couleur dans le sélecteur (mêmes fonds que Badge).
const COLOR_DOT = {
  gray: 'bg-slate-300', slate: 'bg-slate-400', blue: 'bg-blue-400', indigo: 'bg-brand-400',
  green: 'bg-green-400', yellow: 'bg-yellow-400', orange: 'bg-orange-400', red: 'bg-red-400',
  purple: 'bg-purple-400', pink: 'bg-pink-400', teal: 'bg-teal-400',
}

// Id de choix généré côté client (slug sûr) — le serveur le préserve tel quel,
// donc default_id/default_ids reste valide dès la création.
function tmpChoiceId() {
  return `opt_${Math.random().toString(36).slice(2, 10)}`
}

// Parse la config options (string JSON) d'un champ select en état éditable.
function parseOptionsState(raw) {
  let opts = raw
  if (typeof raw === 'string') { try { opts = JSON.parse(raw) } catch { opts = {} } }
  const choices = Array.isArray(opts?.choices)
    ? opts.choices.map(c => ({ id: c.id || tmpChoiceId(), label: c.label || '', color: c.color || 'gray' }))
    : []
  return {
    choices,
    default_id: opts?.default_id || null,
    default_ids: Array.isArray(opts?.default_ids) ? opts.default_ids : [],
    alphabetize: !!opts?.alphabetize,
  }
}

// Sous-types de champs auto-remplis (lecture seule, calculés à la lecture).
// Le `kind` stocké côté serveur est directement le sous-type ; côté UI on les
// regroupe sous l'onglet « Auto ».
const AUTO_KINDS = ['created_time', 'last_modified_time', 'created_by', 'last_modified_by']
const AUTO_TYPE_OPTIONS = [
  { v: 'created_time',       label: 'Date de création',       hint: 'Quand l\'enregistrement a été créé' },
  { v: 'last_modified_time', label: 'Date de modification',   hint: 'Quand l\'enregistrement a été modifié pour la dernière fois' },
  { v: 'created_by',         label: 'Créé par',               hint: 'Utilisateur ayant créé l\'enregistrement' },
  { v: 'last_modified_by',   label: 'Modifié par',            hint: 'Dernier utilisateur ayant modifié' },
]

// Modale UNIQUE de modification de champ, commune à tous les champs de toutes
// les tables :
//   - champs custom (création + édition) → CustomFieldModalInner ci-dessous ;
//   - champs natifs (colonnes de tableDefs.js) → NativeFieldModal : renommage +
//     changement de type d'affichage via un override cosmétique persisté dans
//     field_overrides (la colonne SQL et les syncs ne bougent pas).
// Passer `native={{ column, override }}` pour éditer un champ natif ; sinon la
// modale se comporte comme avant (champ custom).
export function CustomFieldModal(props) {
  if (props.native?.column) return <NativeFieldModal {...props} />
  return <CustomFieldModalInner {...props} />
}

// Édition d'un champ NATIF (colonne définie dans tableDefs.js) : renommage +
// changement de type d'affichage. Même présentation que le mode édition d'un
// champ custom (labels, cartes de type, autosave au blur/changement, footer
// « Réinitialiser / Fermer ») pour que la modale « Modifier le champ » soit
// identique quel que soit le champ cliqué. L'override est cosmétique (label +
// type d'affichage/tri/filtres) — la colonne SQL et les syncs qui l'alimentent
// ne bougent pas — mais un changement de type sur un champ alimenté par une
// sync affiche un avertissement explicite.
//
// `native.column` = définition D'ORIGINE de la colonne (pré-override),
// `native.override` = override actif ou null.
function NativeFieldModal({ isOpen, onClose, erpTable, native, onSaved }) {
  const { addToast } = useToast()
  const table = erpTable
  const column = native?.column || null
  const override = native?.override || null
  const [label, setLabel] = useState('')
  const [type, setType] = useState('text')
  const [decimals, setDecimals] = useState(2)
  // Préférence d'indicatif de pays pour les champs téléphone : 'show' | 'hide'.
  // Baseline (= pas d'override) : 'hide', cohérent avec le rendu natif fmtPhone.
  const [countryCode, setCountryCode] = useState('hide')
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState(null)
  // Override actif côté serveur — suivi localement pour que les autosaves
  // successifs (et le bouton Réinitialiser) restent cohérents sans attendre le
  // rafraîchissement de la prop `override` par le parent.
  const [hasOverride, setHasOverride] = useState(false)
  // Dernières valeurs persistées — évite de re-PATCH un champ inchangé au blur.
  const lastSaved = useRef({ label: '', type: 'text', decimals: 2, countryCode: 'hide' })

  // Type/label d'origine de la colonne, tels que définis dans tableDefs.js.
  // Vocabulaire unifié : tableDefs.js dit encore 'boolean' là où les champs
  // perso disent 'checkbox'. On normalise ici pour que le type d'origine et le
  // type proposé dans la liste soient la même valeur — sinon « Case à cocher »
  // apparaîtrait deux fois, dont une comme un changement de type fictif.
  const originalType = normalizeFieldType(column?.type)
  const originalLabel = column?.label || column?.id || ''

  useEffect(() => {
    if (!isOpen || !column) return
    const l = override?.label || originalLabel
    const t = override?.type || originalType
    const d = Number.isInteger(override?.decimals) ? override.decimals : 2
    const cc = override?.country_code === 'show' ? 'show' : 'hide'
    setLabel(l)
    setType(t)
    setDecimals(d)
    setCountryCode(cc)
    setHasOverride(!!override)
    lastSaved.current = { label: l, type: t, decimals: d, countryCode: cc }
    setError(null)
    // `override` volontairement hors deps : après un autosave, le parent
    // recharge les overrides et la prop change — sans ce garde, l'effet
    // écraserait la saisie en cours avec les valeurs re-fetchées.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, column?.id])

  if (!column) return null

  const typeChanged = type !== originalType
  const syncSource = syncSourceForTable(table)
  // Types proposés : le type d'origine d'abord (= pas d'override), puis les
  // types d'affichage supportés.
  //
  // Une colonne dotée d'un rendu sur-mesure (lien cliquable vers une fiche,
  // badge…) annonce ce rendu comme un TYPE À PART ENTIÈRE — « Lien vers
  // Entreprise » plutôt que « Texte ». Sans ce nom, choisir « Texte » faisait
  // perdre le lien sans que rien ne l'annonce, et rien n'indiquait comment le
  // retrouver ; le re-sélectionner rétablit le rendu d'origine.
  const typeOptions = [
    { value: originalType, label: column?.renderTypeLabel || typeLabel(originalType), origin: true },
    ...OVERRIDE_TYPES.filter(t => t.value !== originalType),
  ]

  // Autosave (règle « autosave partout ») : persiste l'état courant, avec
  // valeurs explicites pour contourner l'asynchronisme de setState. Valeurs
  // revenues à l'origine → l'override est retiré.
  async function persist(next = {}) {
    const cur = {
      label: (next.label ?? label).trim(),
      type: next.type ?? type,
      decimals: next.decimals ?? decimals,
      countryCode: next.countryCode ?? countryCode,
    }
    if (!cur.label) { setError('Le nom du champ est requis'); return }
    const ls = lastSaved.current
    if (cur.label === ls.label && cur.type === ls.type && cur.decimals === ls.decimals && cur.countryCode === ls.countryCode) return
    const labelChanged = cur.label !== originalLabel
    const typeIsOverridden = cur.type !== originalType
    // Préférence d'indicatif applicable seulement si le champ s'affiche en
    // téléphone. Baseline 'hide' → seul 'show' constitue un override.
    const isPhone = cur.type === 'phone'
    const ccIsOverridden = isPhone && cur.countryCode === 'show'
    setError(null)
    setSaving(true)
    try {
      if (!labelChanged && !typeIsOverridden && !ccIsOverridden) {
        // Tout est revenu aux valeurs d'origine → on retire l'override.
        if (hasOverride) {
          await api.fieldOverrides.reset(table, column.id)
          setHasOverride(false)
        }
      } else {
        await api.fieldOverrides.save(table, column.id, {
          label: labelChanged ? cur.label : null,
          type: typeIsOverridden ? cur.type : null,
          decimals: typeIsOverridden && (cur.type === 'number' || cur.type === 'currency') ? cur.decimals : null,
          country_code: isPhone ? cur.countryCode : null,
        })
        setHasOverride(true)
      }
      lastSaved.current = cur
      onSaved?.()
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    } catch (e) {
      setError(e.message || 'Erreur')
    } finally {
      setSaving(false)
    }
  }

  async function handleReset() {
    setSaving(true)
    setError(null)
    try {
      await api.fieldOverrides.reset(table, column.id)
      setLabel(originalLabel)
      setType(originalType)
      setDecimals(2)
      setCountryCode('hide')
      setHasOverride(false)
      lastSaved.current = { label: originalLabel, type: originalType, decimals: 2, countryCode: 'hide' }
      addToast({ message: 'Champ réinitialisé', type: 'success' })
      onSaved?.()
    } catch (e) {
      setError(e.message || 'Erreur')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Modifier le champ" size="md">
      <form onSubmit={e => { e.preventDefault(); persist() }} className="space-y-4">
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
          Champ natif de l'ERP{syncSource ? ` — alimenté par ${syncSource}` : ''}.
          Nom et rendu sont éditables ici ; la colonne d'origine et les syncs qui
          l'alimentent ne changent pas.
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Nom</label>
          <input
            autoFocus
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            onBlur={() => persist()}
            maxLength={120}
            className="input text-sm w-full"
            data-testid="field-override-name"
          />
          {label.trim() !== originalLabel && (
            <p className="text-[11px] text-slate-400 mt-1">Nom d'origine : {originalLabel}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Type</label>
          <div className="grid grid-cols-2 gap-2" data-testid="field-override-type">
            {typeOptions.map(t => (
              <label
                key={t.value}
                data-testid={`field-override-type-${t.value}`}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border cursor-pointer transition-colors ${type === t.value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'}`}
              >
                <input
                  type="radio" name="field-override-type" value={t.value}
                  checked={type === t.value}
                  onChange={() => { setType(t.value); persist({ type: t.value }) }}
                  className="sr-only"
                />
                {t.label}
                {t.origin && <span className="text-[11px] text-slate-400">(origine)</span>}
              </label>
            ))}
          </div>
          {!typeChanged && (
            <p className="text-[11px] text-slate-400 mt-1">Le changement de type modifie l'affichage, le tri et les filtres de cette colonne.</p>
          )}
        </div>

        {typeChanged && (type === 'number' || type === 'currency') && (
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Décimales (0 à 5)</label>
            <input
              type="number" min={0} max={5}
              value={decimals}
              onChange={e => setDecimals(Math.max(0, Math.min(5, parseInt(e.target.value) || 0)))}
              onBlur={() => persist()}
              className="input text-sm w-24"
              data-testid="field-override-decimals"
            />
          </div>
        )}

        {/* Préférence d'indicatif de pays — uniquement pour l'affichage téléphone. */}
        {type === 'phone' && (
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Indicatif de pays</label>
            <div className="grid grid-cols-2 gap-2" data-testid="field-override-country-code">
              {[
                { value: 'hide', label: 'Masquer', hint: '(514) 123-4567' },
                { value: 'show', label: 'Afficher', hint: '+1 (514) 123-4567' },
              ].map(o => (
                <label
                  key={o.value}
                  data-testid={`field-override-country-code-${o.value}`}
                  className={`flex flex-col items-center justify-center gap-0.5 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${countryCode === o.value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'}`}
                >
                  <input
                    type="radio" name="field-override-country-code" value={o.value}
                    checked={countryCode === o.value}
                    onChange={() => { setCountryCode(o.value); persist({ countryCode: o.value }) }}
                    className="sr-only"
                  />
                  <span className="text-sm">{o.label}</span>
                  <span className="text-[11px] text-slate-400 tabular-nums">{o.hint}</span>
                </label>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-1">L'indicatif « +1 » n'est ajusté que sur les numéros nord-américains ; les numéros internationaux le conservent toujours.</p>
          </div>
        )}

        {/* Avertissement : changement de type sur un champ alimenté par une sync. */}
        {typeChanged && syncSource && (
          <div
            className="flex gap-2.5 items-start rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"
            data-testid="field-override-sync-warning"
          >
            <AlertTriangle size={16} className="shrink-0 mt-0.5 text-amber-500" />
            <div>
              <p className="font-medium">Ce champ est alimenté par {syncSource}.</p>
              <p className="mt-0.5 text-amber-700">
                Changer son type risque de casser cette sync côté affichage : la sync continuera
                d'écrire des valeurs de type « {column?.renderTypeLabel || typeLabel(originalType)} », qui peuvent devenir
                illisibles ou mal triées/filtrées en « {typeLabel(type)} ».
              </p>
            </div>
          </div>
        )}

        {error && <div className="rounded bg-red-50 border border-red-200 p-2 text-xs text-red-700">{error}</div>}

        {/* Autosave au blur / au changement, pas de bouton « Enregistrer » —
            même footer que le mode édition custom : action à gauche,
            état de sauvegarde discret + « Fermer » à droite. */}
        <div className="flex items-center justify-between gap-3 pt-2">
          {hasOverride ? (
            <button
              type="button"
              onClick={handleReset}
              disabled={saving}
              className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 disabled:opacity-40"
              data-testid="field-override-reset"
            >
              <RotateCcw size={13} /> Réinitialiser le champ
            </button>
          ) : <span />}
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400 min-h-[1rem]" data-testid="field-override-save-state">
              {saving ? 'Enregistrement…' : (savedFlash ? 'Enregistré ✓' : '')}
            </span>
            <button type="button" onClick={onClose} className="btn-secondary">Fermer</button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

// Branche « champ custom » de la modale commune.
// Quatre "kinds" :
//   - data    : colonne réelle stockée (text/number) — éditable inline
//   - formula : expression SQLite calculée à la lecture via la VUE
//   - lookup  : valeur tirée d'une table liée via FK
//   - auto    : champ système lecture seule (created_time, last_modified_time, created_by, last_modified_by)
// En mode édition, le kind est figé.
function CustomFieldModalInner({ isOpen, onClose, erpTable, editing, onSaved, onDeleted }) {
  const { addToast } = useToast()
  const [kind, setKind] = useState('data')
  const [name, setName] = useState('')
  const [type, setType] = useState('text')        // pour kind='data'
  const [decimals, setDecimals] = useState(2)
  const [currencyCode, setCurrencyCode] = useState('CAD') // pour kind='data' type currency (ISO 4217)
  const [durationFormat, setDurationFormat] = useState('h:mm') // pour kind='data' type duration
  const [dateFormat, setDateFormat] = useState('iso_date') // pour kind='data' type date (et formula/lookup/rollup result_type='date')
  const [phoneCountryCode, setPhoneCountryCode] = useState('hide') // pour kind='data' type phone ('show'|'hide')
  const [defaultValue, setDefaultValue] = useState('') // pour kind='data' text/number/currency/url/duration
  // pour kind='data' type single_select/multi_select
  const [choices, setChoices] = useState([])
  const [defaultId, setDefaultId] = useState(null)       // défaut single_select
  const [defaultIds, setDefaultIds] = useState([])       // défaut multi_select
  const [alphabetize, setAlphabetize] = useState(false)
  const [resultType, setResultType] = useState('text')   // pour kind='formula'/'lookup'
  const [autoType, setAutoType] = useState('created_time') // pour kind='auto'
  const [formulaExpr, setFormulaExpr] = useState('')
  const [lookupFk, setLookupFk] = useState('')
  const [lookupTargetTable, setLookupTargetTable] = useState('')
  const [lookupTargetColumn, setLookupTargetColumn] = useState('')
  // pour kind='rollup'
  const [rollupSource, setRollupSource] = useState('')   // `${table}::${fk}` encodé
  const [rollupColumn, setRollupColumn] = useState('')
  const [rollupAgg, setRollupAgg] = useState('SUM')
  // pour kind='button'
  const [buttonLabel, setButtonLabel] = useState('')
  const [buttonAutomationId, setButtonAutomationId] = useState('')
  const [buttonStyle, setButtonStyle] = useState('brand')
  const [automations, setAutomations] = useState([])     // règles de champ disponibles
  const [meta, setMeta] = useState(null)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState(null)
  // Erreur de régénération de VUE persistée côté serveur (colonne source
  // disparue) — affichée en bannière #ERROR ; effacée dès qu'un autosave réussit.
  const [viewError, setViewError] = useState(null)
  // Flux de suppression avec rapport de dépendances (édition uniquement).
  //   'idle'     : pas de suppression en cours
  //   'loading'  : on récupère le rapport d'usage
  //   'confirm'  : rapport affiché, en attente de confirmation
  //   'deleting' : suppression en cours
  const [deleteStep, setDeleteStep] = useState('idle')
  const [dependents, setDependents] = useState([])
  // Valeurs déjà persistées (en mode édition) — évite de re-PATCH un champ
  // inchangé au blur. `editing` (prop du parent) n'est pas rafraîchi après save.
  const lastSaved = useRef({})
  // Dernière config select sérialisée et persistée — évite de re-PATCH les options
  // inchangées au blur d'un champ libellé.
  const lastSavedOptionsJson = useRef('')

  useEffect(() => {
    if (!isOpen) return
    if (editing) {
      lastSaved.current = {
        name: editing.name || '',
        decimals: editing.decimals ?? 2,
        default_value: editing.default_value ?? '',
        options: editing.options || '',
        formula_expr: editing.formula_expr || '',
        lookup_fk: editing.lookup_fk || '',
        lookup_target_table: editing.lookup_target_table || '',
        lookup_target_column: editing.lookup_target_column || '',
        rollup_target_table: editing.rollup_target_table || '',
        rollup_target_fk: editing.rollup_target_fk || '',
        rollup_target_column: editing.rollup_target_column || '',
        rollup_agg: editing.rollup_agg || 'SUM',
      }
      // Les sous-types auto sont stockés directement comme `kind` côté serveur ;
      // on les ramène à l'onglet « auto » + sous-type pour l'affichage.
      const k = editing.kind || 'data'
      const isAuto = AUTO_KINDS.includes(k)
      setKind(isAuto ? 'auto' : k)
      setAutoType(isAuto ? k : 'created_time')
      setName(editing.name || '')
      setType(editing.type || 'text')
      setDecimals(editing.decimals ?? 2)
      setDefaultValue(editing.default_value ?? '')
      // Devise : le code (ISO 4217) est lu depuis options ; défaut CAD pour les
      // champs créés avant le choix de devise.
      setCurrencyCode(editing.type === 'currency' ? currencyCodeOf(editing) : 'CAD')
      if (editing.type === 'duration') {
        // Duration : format (h:mm/h:mm:ss) lu depuis options ; la valeur par défaut
        // (secondes en DB) est affichée formatée et alignée sur lastSaved pour éviter
        // un autosave parasite au premier blur.
        let opts = editing.options
        if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch { opts = null } }
        const fmt = normalizeDurationFormat(opts?.format)
        setDurationFormat(fmt)
        const dvFormatted = (editing.default_value != null && editing.default_value !== '')
          ? formatDurationSeconds(Number(editing.default_value), fmt) : ''
        setDefaultValue(dvFormatted)
        lastSaved.current.default_value = dvFormatted
      } else {
        setDurationFormat('h:mm')
      }
      // Date : format d'affichage lu depuis options (défaut 'iso_date' — voir
      // dateFormatOf, s'applique aussi aux formula/lookup/rollup en result_type='date').
      setDateFormat(editing.type === 'date' || editing.result_type === 'date' ? dateFormatOf(editing) : 'iso_date')
      // Téléphone : affichage de l'indicatif de pays lu depuis options (défaut 'hide').
      setPhoneCountryCode(editing.type === 'phone' ? phoneCountryCodeOf(editing) : 'hide')
      {
        const os = parseOptionsState(editing.options)
        setChoices(os.choices)
        setDefaultId(os.default_id)
        setDefaultIds(os.default_ids)
        setAlphabetize(os.alphabetize)
        // Canonicalise la config courante pour la détection de changement (même
        // forme que buildOptions) — évite un PATCH au premier blur sans édition.
        const t = editing.type
        const cleaned = os.choices
          .map(c => ({ id: c.id, label: (c.label || '').trim(), color: c.color || 'gray' }))
          .filter(c => c.label !== '')
        const ids = new Set(cleaned.map(c => c.id))
        lastSavedOptionsJson.current = JSON.stringify({
          choices: cleaned,
          default_id: t === 'single_select' && os.default_id && ids.has(os.default_id) ? os.default_id : null,
          default_ids: t === 'multi_select' ? os.default_ids.filter(id => ids.has(id)) : [],
          alphabetize: !!os.alphabetize,
        })
      }
      setResultType(editing.result_type || 'text')
      setFormulaExpr(editing.formula_expr || '')
      setLookupFk(editing.lookup_fk || '')
      setLookupTargetTable(editing.lookup_target_table || '')
      setLookupTargetColumn(editing.lookup_target_column || '')
      setRollupSource(editing.rollup_target_table ? `${editing.rollup_target_table}::${editing.rollup_target_fk}` : '')
      setRollupColumn(editing.rollup_target_column || '')
      setRollupAgg(editing.rollup_agg || 'SUM')
      if (editing.type === 'button') {
        let opts = editing.options
        if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch { opts = null } }
        setButtonLabel(opts?.label || editing.name || '')
        setButtonAutomationId(opts?.automation_id || '')
        setButtonStyle(opts?.style || 'brand')
      } else {
        setButtonLabel(''); setButtonAutomationId(''); setButtonStyle('brand')
      }
      setViewError(editing.view_error || null)
    } else {
      setKind('data')
      setName('')
      setType('text')
      setDecimals(2)
      setCurrencyCode('CAD')
      setDurationFormat('h:mm')
      setDateFormat('iso_date')
      setPhoneCountryCode('hide')
      setDefaultValue('')
      setChoices([])
      setDefaultId(null)
      setDefaultIds([])
      setAlphabetize(false)
      lastSavedOptionsJson.current = ''
      setResultType('text')
      setAutoType('created_time')
      setFormulaExpr('')
      setLookupFk('')
      setLookupTargetTable('')
      setLookupTargetColumn('')
      setRollupSource('')
      setRollupColumn('')
      setRollupAgg('SUM')
      setButtonLabel('')
      setButtonAutomationId('')
      setButtonStyle('brand')
      setViewError(null)
    }
    setError(null)
    setDeleteStep('idle')
    setDependents([])
  }, [isOpen, editing])

  // Charge les automations « règle de champ » disponibles pour le câblage d'un
  // bouton (le bouton ne peut déclencher qu'une field_rule).
  useEffect(() => {
    if (!isOpen) return
    api.automations.list()
      .then(list => setAutomations((list || []).filter(a => a.kind === 'field_rule')))
      .catch(() => setAutomations([]))
  }, [isOpen])

  // Charge les méta (FK + tables cibles) une seule fois quand la modale ouvre.
  useEffect(() => {
    if (!isOpen || !erpTable) return
    api.customFields.lookupMeta(erpTable)
      .then(setMeta)
      .catch(() => setMeta({ fk_columns: [], allowed_targets: [], target_columns: {} }))
  }, [isOpen, erpTable])

  // Quand l'utilisateur choisit une FK qui a une cible inférée, pré-remplir.
  useEffect(() => {
    if (kind !== 'lookup' || !meta || !lookupFk) return
    const fk = meta.fk_columns.find(f => f.column === lookupFk)
    if (fk && !lookupTargetTable) setLookupTargetTable(fk.target_table)
  }, [kind, lookupFk, meta, lookupTargetTable])

  const targetColumnOptions = useMemo(() => {
    if (!meta || !lookupTargetTable) return []
    return meta.target_columns[lookupTargetTable] || []
  }, [meta, lookupTargetTable])

  // Rollup : `rollupSource` encode `${table}::${fk}`. On le décompose pour les
  // payloads et pour lister les colonnes agrégeables de la table enfant.
  const [rollupTable, rollupFk] = useMemo(() => {
    if (!rollupSource) return ['', '']
    const i = rollupSource.indexOf('::')
    return i < 0 ? [rollupSource, ''] : [rollupSource.slice(0, i), rollupSource.slice(i + 2)]
  }, [rollupSource])

  const rollupColumnOptions = useMemo(() => {
    if (!meta || !rollupTable) return []
    return meta.target_columns[rollupTable] || []
  }, [meta, rollupTable])

  // Sous-types « Auto » disponibles pour cette table. Le serveur renvoie
  // `supported_auto_types` selon la présence de created_at (created_time) et d'un
  // mapping activity_log (created_by / last_modified_by). Tant que la méta n'est
  // pas chargée — ou si un serveur plus ancien ne renvoie pas le champ — on
  // retombe sur l'ensemble complet pour ne pas masquer à tort.
  const autoOptions = useMemo(() => {
    const supported = meta?.supported_auto_types || AUTO_KINDS
    return AUTO_TYPE_OPTIONS.filter(o => supported.includes(o.v))
  }, [meta])
  const autoDisabled = !!meta && autoOptions.length === 0

  // Si le sous-type auto sélectionné n'est pas (ou plus) supporté par la table,
  // le ramener sur le premier disponible (création uniquement — en édition le
  // type est figé).
  useEffect(() => {
    if (editing || !meta) return
    if (autoOptions.length && !autoOptions.some(o => o.v === autoType)) {
      setAutoType(autoOptions[0].v)
    }
  }, [meta, autoOptions, autoType, editing])

  // Autosave d'un champ en mode édition (PATCH partiel). Pas de bouton
  // « Enregistrer » : on persiste au blur / au changement (règle « autosave partout »).
  async function autosave(payload) {
    if (!editing) return
    setError(null)
    setSaving(true)
    try {
      const result = await api.customFields.update(editing.id, payload)
      Object.assign(lastSaved.current, payload)
      // La VUE a été régénérée : refléter l'état d'erreur courant (corrigé → null).
      setViewError(result?.view_error || null)
      onSaved?.(result)
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    } catch (e) {
      setError(e.message || 'Erreur')
    } finally {
      setSaving(false)
    }
  }

  // Démarre la suppression : récupère d'abord le rapport d'usage (quels autres
  // champs custom référencent celui-ci) pour avertir AVANT de casser des champs
  // calculés. Si le rapport échoue (réseau), on bascule quand même en confirmation
  // sans rapport — la suppression reste possible et reste restaurable.
  async function startDelete() {
    if (!editing) return
    setError(null)
    setDeleteStep('loading')
    try {
      const r = await api.customFields.dependents(editing.id)
      setDependents(r?.dependents || [])
    } catch {
      setDependents([])
    }
    setDeleteStep('confirm')
  }

  async function confirmDelete() {
    if (!editing) return
    setDeleteStep('deleting')
    try {
      await api.customFields.delete(editing.id)
      addToast({ message: 'Champ supprimé', type: 'success' })
      onDeleted?.(editing)
      onClose?.()
    } catch (e) {
      setError(e.message || 'Erreur')
      setDeleteStep('confirm')
    }
  }

  // Autosave d'un rollup en édition : ne PATCH que si la config est complète et
  // a changé. Les valeurs sont passées explicitement (setState est asynchrone).
  function maybeAutosaveRollup({ agg = rollupAgg, table = rollupTable, fk = rollupFk, column = rollupColumn }) {
    if (!editing) return
    if (!table || !fk) return
    if (agg !== 'COUNT' && !column) return
    const ls = lastSaved.current
    const nextCol = agg === 'COUNT' ? null : column
    if (ls.rollup_target_table === table && ls.rollup_target_fk === fk &&
        (ls.rollup_target_column || '') === (nextCol || '') && ls.rollup_agg === agg) return
    autosave({
      rollup_target_table: table,
      rollup_target_fk: fk,
      rollup_target_column: nextCol,
      rollup_agg: agg,
      // ARRAY / ARRAYUNIQUE → liste texte ; on bascule le type de résultat en
      // conséquence pour rester cohérent avec l'affichage.
      result_type: isArrayAgg(agg) ? 'text' : resultType,
    })
  }

  // Autosave de la config d'un bouton en édition : ne PATCH que si label +
  // automation sont présents (config complète). Valeurs passées explicitement
  // (setState asynchrone), à la Rollup.
  function autosaveButton({ label = buttonLabel, automation_id = buttonAutomationId, style = buttonStyle } = {}) {
    if (!editing) return
    const lab = (label || '').trim()
    if (!lab || !automation_id) return
    autosave({ options: { label: lab, automation_id, style } })
  }

  // Construit l'objet options { choices, default_id, default_ids, alphabetize }
  // à partir de l'état courant. Filtre les choix sans libellé. `nextChoices`/etc.
  // explicites pour contourner l'asynchronisme de setState.
  function buildOptions({ ch = choices, di = defaultId, dis = defaultIds, alpha = alphabetize } = {}) {
    const cleaned = ch
      .map(c => ({ id: c.id, label: (c.label || '').trim(), color: c.color || 'gray' }))
      .filter(c => c.label !== '')
    const ids = new Set(cleaned.map(c => c.id))
    return {
      choices: cleaned,
      default_id: type === 'single_select' && di && ids.has(di) ? di : null,
      default_ids: type === 'multi_select' ? dis.filter(id => ids.has(id)) : [],
      alphabetize: !!alpha,
    }
  }

  // Autosave de la config select en mode édition. Ne PATCH que si la config
  // sérialisée a changé (évite les écritures inutiles au blur).
  function saveOptionsIfEditing(overrides) {
    if (!editing) return
    const options = buildOptions(overrides)
    if (!options.choices.length) return // garde au moins un choix valide
    const json = JSON.stringify(options)
    if (json === lastSavedOptionsJson.current) return
    lastSavedOptionsJson.current = json
    autosave({ options })
  }

  async function handleSubmit(e) {
    e?.preventDefault()
    setError(null)
    if (editing) {
      // En édition, pas de submit global — autosave au blur. Enter sauvegarde le nom.
      const v = name.trim()
      if (v && v !== lastSaved.current.name) autosave({ name: v })
      return
    }
    if (!name.trim()) { setError('Nom requis'); return }
    setSaving(true)
    try {
      let result
      if (kind === 'data') {
        if (type === 'single_select' || type === 'multi_select') {
          const options = buildOptions()
          if (!options.choices.length) { setError('Ajouter au moins un choix avec un libellé'); setSaving(false); return }
          result = await api.customFields.create(erpTable, { name: name.trim(), type, options })
        } else {
          result = await api.customFields.create(erpTable, {
            name: name.trim(),
            type,
            ...((type === 'number' || type === 'currency') ? { decimals } : {}),
            ...(type === 'currency' ? { options: { currency: currencyCode } } : {}),
            ...(type === 'duration' ? { options: { format: durationFormat } } : {}),
            ...(type === 'date' ? { options: { format: dateFormat } } : {}),
            ...(type === 'phone' ? { options: { country_code: phoneCountryCode } } : {}),
            ...(defaultValue.trim() !== '' ? { default_value: defaultValue.trim() } : {}),
          })
        }
      } else if (kind === 'formula') {
        if (!formulaExpr.trim()) { setError('Expression requise'); setSaving(false); return }
        result = await api.customFields.createFormula(erpTable, {
          name: name.trim(),
          formula_expr: formulaExpr.trim(),
          result_type: resultType,
        })
      } else if (kind === 'lookup') {
        if (!lookupFk || !lookupTargetTable || !lookupTargetColumn) {
          setError('Choisir un champ de référence, une table cible et une colonne')
          setSaving(false); return
        }
        result = await api.customFields.createLookup(erpTable, {
          name: name.trim(),
          lookup_fk: lookupFk,
          lookup_target_table: lookupTargetTable,
          lookup_target_column: lookupTargetColumn,
          result_type: resultType,
        })
      } else if (kind === 'rollup') {
        if (!rollupTable || !rollupFk) {
          setError('Choisir une table liée'); setSaving(false); return
        }
        if (rollupAgg !== 'COUNT' && !rollupColumn) {
          setError('Choisir une colonne à agréger'); setSaving(false); return
        }
        result = await api.customFields.createRollup(erpTable, {
          name: name.trim(),
          rollup_target_table: rollupTable,
          rollup_target_fk: rollupFk,
          rollup_target_column: rollupAgg === 'COUNT' ? null : rollupColumn,
          rollup_agg: rollupAgg,
          // ARRAY / ARRAYUNIQUE produisent une liste texte → forcer le type texte
          // (le tri/filtre/affichage numérique n'a pas de sens sur une liste).
          result_type: isArrayAgg(rollupAgg) ? 'text' : resultType,
        })
      } else if (kind === 'auto') {
        result = await api.customFields.createAuto(erpTable, {
          name: name.trim(),
          auto_type: autoType,
        })
      } else if (kind === 'button') {
        const lab = buttonLabel.trim()
        if (!lab) { setError('Libellé du bouton requis'); setSaving(false); return }
        if (!buttonAutomationId) { setError('Choisir une automation à déclencher'); setSaving(false); return }
        result = await api.customFields.createButton(erpTable, {
          name: name.trim(),
          options: { label: lab, automation_id: buttonAutomationId, style: buttonStyle },
        })
      }
      addToast({ message: 'Champ créé', type: 'success' })
      onSaved?.(result)
      onClose?.()
    } catch (e) {
      setError(e.message || 'Erreur')
    } finally {
      setSaving(false)
    }
  }

  // Tabs pour le kind, masqués en mode édition
  const KIND_TABS = [
    { value: 'data',    label: 'Donnée',  hint: 'Texte ou nombre éditable' },
    { value: 'formula', label: 'Formule', hint: 'Calcul à partir d\'autres colonnes' },
    { value: 'lookup',  label: 'Lookup',  hint: 'Valeur d\'une table liée' },
    { value: 'rollup',  label: 'Rollup',  hint: 'Agrégat d\'une table liée' },
    { value: 'auto',    label: 'Auto',    hint: 'Créé le, créé/modifié par' },
    { value: 'button',  label: 'Bouton',  hint: 'Déclenche une automation' },
  ]

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? 'Modifier le champ' : 'Nouveau champ'} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {editing?.source === 'airtable' && erpTable !== 'factures' && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
            Connecté à Airtable — cette colonne est alimentée par la synchronisation.
            Nom et rendu sont éditables ici ; pour changer le mapping ou désactiver
            l'import, voir la page de gestion des champs Airtable du module.
          </div>
        )}
        {!editing && (
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Type de champ</label>
            <div className="grid grid-cols-2 gap-2">
              {KIND_TABS.map(t => {
                // L'onglet « Auto » est désactivé si la table n'expose aucun
                // champ auto-rempli (ni created_at, ni historique activity_log).
                const disabled = t.value === 'auto' && autoDisabled
                return (
                  <button
                    type="button"
                    key={t.value}
                    disabled={disabled}
                    title={disabled ? 'Aucun champ auto-rempli disponible pour cette table' : undefined}
                    onClick={() => {
                      setKind(t.value)
                      // Rollup : agrégats numériques par défaut.
                      if (t.value === 'rollup') setResultType('number')
                    }}
                    className={`flex flex-col items-start gap-0.5 px-3 py-2 text-sm rounded-lg border transition-colors ${kind === t.value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                  >
                    <span className="font-medium">{t.label}</span>
                    <span className="text-[11px] text-slate-400">{t.hint}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Nom</label>
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={() => {
              if (!editing) return
              const v = name.trim()
              if (v && v !== lastSaved.current.name) autosave({ name: v })
            }}
            className="input text-sm w-full"
            placeholder={kind === 'lookup' ? 'ex: Email entreprise' : kind === 'formula' ? 'ex: Mois du document' : kind === 'rollup' ? 'ex: Total des commandes' : kind === 'auto' ? 'ex: Créé le' : kind === 'button' ? 'ex: Pousser sur QuickBooks' : 'ex: Priorité interne'}
          />
        </div>

        {/* Mode "data" — texte / nombre / devise / URL éditable */}
        {kind === 'data' && (
          <>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Type</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { v: 'text',          label: 'Texte' },
                  { v: 'long_text',     label: 'Texte long' },
                  { v: 'number',        label: 'Nombre' },
                  { v: 'currency',      label: 'Devise' },
                  { v: 'duration',      label: 'Durée' },
                  { v: 'date',          label: 'Date' },
                  { v: 'url',           label: 'URL' },
                  { v: 'phone',         label: 'Téléphone' },
                  { v: 'checkbox',      label: 'Case à cocher' },
                  { v: 'single_select', label: 'Sélection' },
                  { v: 'multi_select',  label: 'Multi-sélection' },
                ].map(t => {
                  // Un champ existant a normalement son type figé — sauf s'il
                  // adopte une colonne Airtable (source='airtable') : ces
                  // colonnes sont pleinement modifiables, le type peut basculer
                  // vers n'importe quel rendu (le changement est purement
                  // métadonnée — la colonne physique n'est pas ré-altérée).
                  const canRetype = editing?.source === 'airtable' && editing?.kind === 'data'
                  const locked = !!editing && !canRetype
                  return (
                  <label key={t.v} data-testid={`cf-type-${t.v}`} className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border cursor-pointer transition-colors ${type === t.v ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'} ${locked ? 'opacity-60 cursor-not-allowed' : ''}`}>
                    <input
                      type="radio" name="cf-type" value={t.v}
                      checked={type === t.v}
                      onChange={() => {
                        setType(t.v)
                        // Devise : défaut 2 décimales (format monétaire usuel).
                        if (t.v === 'currency') setDecimals(2)
                        if (editing && canRetype && t.v !== editing.type) autosave({ type: t.v })
                      }}
                      disabled={locked}
                      className="sr-only"
                    />
                    {t.label}
                  </label>
                  )
                })}
              </div>
              {type === 'currency' && <p className="text-[11px] text-slate-400 mt-1">Nombre au format monétaire ({currencyCode}, séparateurs). Devise et décimales configurables ci-dessous.</p>}
              {type === 'long_text' && <p className="text-[11px] text-slate-400 mt-1">Texte multiligne, affiché dans une zone de texte extensible.</p>}
              {type === 'date' && <p className="text-[11px] text-slate-400 mt-1">Date sans heure (ex: échéance, date de clôture).</p>}
              {editing && editing.source === 'airtable' && <p className="text-[11px] text-slate-400 mt-1">Colonne Airtable : le type et le rendu sont entièrement modifiables.</p>}
              {type === 'duration' && <p className="text-[11px] text-slate-400 mt-1">Durée saisie « 1:30 » ou « 1:30:00 », stockée en secondes. Utilisable en formule via DURATION_FORMAT / DURATION_PARSE.</p>}
              {type === 'url' && <p className="text-[11px] text-slate-400 mt-1">Texte rendu comme lien cliquable quand l'URL est valide.</p>}
              {type === 'phone' && <p className="text-[11px] text-slate-400 mt-1">Numéro formaté automatiquement à l'affichage — ex: (514) 123-4567 — et cliquable pour composer. Les extensions (« poste 123 ») sont préservées.</p>}
              {type === 'checkbox' && <p className="text-[11px] text-slate-400 mt-1">Case cochée / décochée (oui-non). Filtrable « Est vrai » / « Est faux », agrégeable.</p>}
              {type === 'single_select' && <p className="text-[11px] text-slate-400 mt-1">Un seul choix par enregistrement, affiché en pastille colorée.</p>}
              {type === 'multi_select' && <p className="text-[11px] text-slate-400 mt-1">Plusieurs choix (tags) par enregistrement, affichés en pastilles colorées.</p>}
              {editing && editing.source !== 'airtable' && <p className="text-[11px] text-slate-400 mt-1">Le type ne peut pas être modifié après création.</p>}
            </div>

            {/* Éditeur de choix — single_select / multi_select */}
            {(type === 'single_select' || type === 'multi_select') && (
              <ChoicesEditor
                choices={choices}
                setChoices={setChoices}
                isMulti={type === 'multi_select'}
                defaultId={defaultId}
                setDefaultId={setDefaultId}
                defaultIds={defaultIds}
                setDefaultIds={setDefaultIds}
                alphabetize={alphabetize}
                setAlphabetize={setAlphabetize}
                onPersist={saveOptionsIfEditing}
              />
            )}
            {/* Devise : choix du code ISO 4217 (recherchable — >10 options). */}
            {type === 'currency' && (
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Devise</label>
                <SearchableSelect
                  value={currencyCode}
                  options={CURRENCY_OPTIONS}
                  getOptionValue={o => o.code}
                  getOptionKey={o => o.code}
                  getOptionLabel={o => `${o.code} — ${o.label}`}
                  onChange={v => {
                    const prev = currencyCode
                    setCurrencyCode(v)
                    // En édition : autosave immédiat (pas de blur sur un sélecteur).
                    if (editing && v !== prev) autosave({ options: { currency: v } })
                  }}
                  placeholder="Choisir une devise…"
                  searchPlaceholder="Rechercher une devise…"
                  size="sm"
                  className="input text-sm w-full bg-white"
                  testId="cf-currency-code"
                />
              </div>
            )}
            {(type === 'number' || type === 'currency') && (
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Décimales (0 à 5)</label>
                <input
                  type="number" min={0} max={5}
                  value={decimals}
                  onChange={e => setDecimals(Math.max(0, Math.min(5, parseInt(e.target.value) || 0)))}
                  onBlur={() => {
                    if (editing && decimals !== lastSaved.current.decimals) autosave({ decimals })
                  }}
                  className="input text-sm w-24"
                />
              </div>
            )}
            {type === 'duration' && (
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Format d'affichage</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { v: 'h:mm',    label: 'h:mm',    hint: 'ex: 1:30' },
                    { v: 'h:mm:ss', label: 'h:mm:ss', hint: 'ex: 1:30:00' },
                  ].map(o => (
                    <label key={o.v} data-testid={`cf-duration-format-${o.v}`} className={`flex flex-col items-start gap-0.5 px-3 py-2 text-sm rounded-lg border cursor-pointer transition-colors ${durationFormat === o.v ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'}`}>
                      <input
                        type="radio" name="cf-duration-format" value={o.v}
                        checked={durationFormat === o.v}
                        onChange={() => {
                          setDurationFormat(o.v)
                          // En édition : autosave immédiat du format (seul réglage de la durée).
                          if (editing && o.v !== normalizeDurationFormat(durationFormat)) {
                            autosave({ options: { format: o.v } })
                          }
                        }}
                        className="sr-only"
                      />
                      <span className="font-medium">{o.label}</span>
                      <span className="text-[11px] text-slate-400">{o.hint}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {/* Date : format d'affichage — ISO (date seule, ou + heure 12h/24h)
                ou locale (date seule, ou + heure). Aucune saisie n'est affectée,
                seul le rendu change. */}
            {type === 'date' && (
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Format d'affichage</label>
                <div className="grid grid-cols-2 gap-2">
                  {DATE_DISPLAY_FORMATS.map(o => (
                    <label key={o.value} data-testid={`cf-date-format-${o.value}`} className={`flex flex-col items-start gap-0.5 px-3 py-2 text-sm rounded-lg border cursor-pointer transition-colors ${dateFormat === o.value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'}`}>
                      <input
                        type="radio" name="cf-date-format" value={o.value}
                        checked={dateFormat === o.value}
                        onChange={() => {
                          setDateFormat(o.value)
                          // En édition : autosave immédiat (seul réglage de la date).
                          if (editing && o.value !== normalizeDateFormat(dateFormat)) {
                            autosave({ options: { format: o.value } })
                          }
                        }}
                        className="sr-only"
                      />
                      <span className="font-medium">{o.label}</span>
                      <span className="text-[11px] text-slate-400 tabular-nums">{o.hint}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {/* Téléphone : affichage (ou non) de l'indicatif de pays. Par défaut
                masqué → (514) 123-4567 ; coché → +1 (514) 123-4567 sur les
                numéros nord-américains. Les numéros internationaux (« +33… »)
                gardent toujours leur indicatif. */}
            {type === 'phone' && (
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Indicatif de pays</label>
                <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="cf-phone-country-code"
                    checked={phoneCountryCode === 'show'}
                    onChange={e => {
                      const v = e.target.checked ? 'show' : 'hide'
                      setPhoneCountryCode(v)
                      // En édition : autosave immédiat (pas de blur sur une case).
                      if (editing) autosave({ options: { country_code: v } })
                    }}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  Afficher l'indicatif de pays (ex: +1)
                </label>
                <p className="text-[11px] text-slate-400 mt-1">
                  Décoché : <span className="tabular-nums">(514) 123-4567</span> — coché : <span className="tabular-nums">+1 (514) 123-4567</span>. Les numéros internationaux (« +33… ») gardent toujours leur indicatif.
                </p>
              </div>
            )}
            {/* Checkbox : la valeur par défaut est un état coché / décoché. */}
            {type === 'checkbox' && (
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Valeur par défaut</label>
                <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="cf-checkbox-default"
                    checked={defaultValue === '1'}
                    onChange={e => {
                      const v = e.target.checked ? '1' : ''
                      setDefaultValue(v)
                      // En édition : autosave immédiat (pas de blur sur une case).
                      if (editing) autosave({ default_value: e.target.checked })
                    }}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  Coché par défaut
                </label>
                <p className="text-[11px] text-slate-400 mt-1">Posé automatiquement à la création d'un nouvel enregistrement.</p>
              </div>
            )}
            {/* La valeur par défaut des select est portée par les choix (étoile),
                pas par ce champ texte. */}
            {type !== 'single_select' && type !== 'multi_select' && type !== 'checkbox' && (
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Valeur par défaut (optionnel)</label>
                <input
                  type={(type === 'number' || type === 'currency') ? 'number' : (type === 'url' ? 'url' : (type === 'phone' ? 'tel' : 'text'))}
                  value={defaultValue}
                  onChange={e => setDefaultValue(e.target.value)}
                  onBlur={() => {
                    if (!editing) return
                    if (defaultValue !== (lastSaved.current.default_value ?? '')) autosave({ default_value: defaultValue })
                  }}
                  className="input text-sm w-full"
                  placeholder={type === 'url' ? 'ex: https://…' : type === 'phone' ? 'ex: 514 123-4567' : type === 'duration' ? 'ex: 1:30' : (type === 'number' || type === 'currency') ? 'ex: 0' : 'ex: À traiter'}
                />
                <p className="text-[11px] text-slate-400 mt-1">Posée automatiquement à la création d'un nouvel enregistrement. Laisser vide pour aucune valeur par défaut.</p>
              </div>
            )}
          </>
        )}

        {/* Mode "formula" — expression SQLite avec autocomplete + test live */}
        {kind === 'formula' && (
          <>
            <FormulaEditor
              value={formulaExpr}
              onChange={setFormulaExpr}
              onBlur={() => {
                if (!editing) return
                const v = formulaExpr.trim()
                if (v && v !== lastSaved.current.formula_expr) autosave({ formula_expr: v })
              }}
              erpTable={erpTable}
              sourceColumns={meta?.source_columns || []}
              functions={meta?.formula_functions || []}
            />
            <ResultTypeSelect value={resultType} onChange={setResultType} />
          </>
        )}

        {/* Mode "lookup" — JOIN sur table liée */}
        {kind === 'lookup' && (
          <>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Champ de référence</label>
              <select
                value={lookupFk}
                onChange={e => { setLookupFk(e.target.value); setLookupTargetTable(''); setLookupTargetColumn('') }}
                className="input text-sm w-full"
                data-testid="cf-lookup-fk"
              >
                <option value="">— Choisir une colonne FK —</option>
                {meta?.fk_columns?.map(fk => (
                  <option key={fk.column} value={fk.column}>
                    {fk.column} → {fk.target_table}{fk.inferred ? ' (inféré)' : ''}
                  </option>
                ))}
              </select>
              {/* Aide : les tables ENFANT (qui référencent cette fiche, ex.
                  Paiements → Factures) n'apparaissent pas ici — un Lookup suit
                  un lien direct sortant. On les liste et on propose de basculer
                  en Rollup, seul mode capable d'agréger des enregistrements liés. */}
              {meta && (() => {
                const lookupTables = new Set((meta.fk_columns || []).map(f => f.target_table))
                const rollupOnly = [...new Set((meta.rollup_sources || []).map(s => s.table).filter(t => !lookupTables.has(t)))]
                if (rollupOnly.length === 0) return null
                return (
                  <p className="text-[11px] text-slate-500 mt-1" data-testid="cf-lookup-rollup-hint">
                    Les tables qui référencent cette fiche ({rollupOnly.map(uiTableLabel).join(', ')}) ne sont pas accessibles ici : un Lookup suit un lien direct (ex. la commande d'une facture). Pour récupérer leurs données,{' '}
                    <button type="button" className="text-brand-600 underline hover:text-brand-700" onClick={() => setKind('rollup')}>utilisez un champ Rollup</button>.
                  </p>
                )
              })()}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Table cible</label>
              <SearchableSelect
                value={lookupTargetTable}
                options={meta?.allowed_targets || []}
                getOptionValue={t => t}
                getOptionKey={t => t}
                getOptionLabel={t => uiTableLabel(t)}
                emptyOption="— Choisir une table —"
                onChange={v => { setLookupTargetTable(v); setLookupTargetColumn('') }}
                disabled={!lookupFk}
                placeholder="— Choisir une table —"
                searchPlaceholder="Rechercher une table…"
                size="sm"
                className="input text-sm w-full bg-white"
                testId="cf-lookup-target-table"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Colonne à récupérer</label>
              <SearchableSelect
                value={lookupTargetColumn}
                options={targetColumnOptions}
                getOptionValue={o => o.column}
                getOptionKey={o => o.column}
                getOptionLabel={o => uiColumnLabel(lookupTargetTable, o)}
                emptyOption="— Choisir une colonne —"
                onChange={v => {
                  setLookupTargetColumn(v)
                  // En édition, le lookup n'est valide que lorsque FK + table + colonne
                  // sont présents — autosave dès que la colonne (dernier maillon) est choisie.
                  if (editing && lookupFk && lookupTargetTable && v &&
                      v !== lastSaved.current.lookup_target_column) {
                    autosave({
                      lookup_fk: lookupFk,
                      lookup_target_table: lookupTargetTable,
                      lookup_target_column: v,
                    })
                  }
                }}
                disabled={!lookupTargetTable}
                placeholder="— Choisir une colonne —"
                searchPlaceholder="Rechercher un champ…"
                size="sm"
                className="input text-sm w-full bg-white"
                testId="cf-lookup-target-column"
              />
            </div>
            <ResultTypeSelect value={resultType} onChange={setResultType} />
          </>
        )}

        {/* Mode "rollup" — agrégat d'une table liée (FK inverse) */}
        {kind === 'rollup' && (
          <>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Agrégation</label>
              <div className="grid grid-cols-4 gap-1.5">
                {ROLLUP_AGG_OPTIONS.map(({ value, label }) => (
                  <label key={value} className={`flex items-center justify-center px-2 py-2 text-xs rounded-lg border cursor-pointer transition-colors ${rollupAgg === value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'}`}>
                    <input
                      type="radio" name="cf-rollup-agg" value={value}
                      checked={rollupAgg === value}
                      onChange={() => { setRollupAgg(value); maybeAutosaveRollup({ agg: value }) }}
                      className="sr-only"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                {rollupAgg === 'COUNT'
                  ? 'Compte les enregistrements liés.'
                  : rollupAgg === 'ARRAY'
                    ? 'Liste toutes les valeurs liées, séparées par des virgules.'
                    : rollupAgg === 'ARRAYUNIQUE'
                      ? 'Liste les valeurs distinctes liées, séparées par des virgules.'
                      : 'Agrège la colonne choisie sur les enregistrements liés.'}
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Table liée</label>
              <select
                value={rollupSource}
                onChange={e => {
                  const v = e.target.value
                  setRollupSource(v)
                  setRollupColumn('')
                  const i = v.indexOf('::')
                  const t = i < 0 ? v : v.slice(0, i)
                  const fk = i < 0 ? '' : v.slice(i + 2)
                  maybeAutosaveRollup({ table: t, fk, column: '' })
                }}
                className="input text-sm w-full"
              >
                <option value="">— Choisir une table liée —</option>
                {meta?.rollup_sources?.map(s => (
                  <option key={`${s.table}::${s.fk_column}`} value={`${s.table}::${s.fk_column}`}>
                    {uiTableLabel(s.table)} — via {s.fk_column}{s.inferred ? ' (inféré)' : ''}
                  </option>
                ))}
              </select>
              {meta && (meta.rollup_sources?.length ?? 0) === 0 && (
                <p className="text-[11px] text-amber-600 mt-1">Aucune table ne référence cette table — rollup indisponible.</p>
              )}
            </div>
            {rollupAgg !== 'COUNT' && (
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Colonne à agréger</label>
                <SearchableSelect
                  value={rollupColumn}
                  options={rollupColumnOptions}
                  getOptionValue={o => o.column}
                  getOptionKey={o => o.column}
                  getOptionLabel={o => uiColumnLabel(rollupTable, o)}
                  emptyOption="— Choisir une colonne —"
                  onChange={v => {
                    setRollupColumn(v)
                    maybeAutosaveRollup({ column: v })
                  }}
                  disabled={!rollupTable}
                  placeholder="— Choisir une colonne —"
                  searchPlaceholder="Rechercher un champ…"
                  size="sm"
                  className="input text-sm w-full bg-white"
                  testId="cf-rollup-column"
                />
              </div>
            )}
            <ResultTypeSelect value={resultType} onChange={setResultType} />
          </>
        )}

        {/* Mode "auto" — champ système lecture seule */}
        {kind === 'auto' && (
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Type auto-rempli</label>
            <div className="space-y-2">
              {(editing ? AUTO_TYPE_OPTIONS : autoOptions).map(o => (
                <label
                  key={o.v}
                  className={`flex flex-col gap-0.5 px-3 py-2 text-sm rounded-lg border transition-colors ${autoType === o.v ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'} ${editing ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <input
                    type="radio" name="cf-auto-type" value={o.v}
                    checked={autoType === o.v}
                    onChange={() => setAutoType(o.v)}
                    disabled={!!editing}
                    className="sr-only"
                  />
                  <span className="font-medium">{o.label}</span>
                  <span className="text-[11px] text-slate-400">{o.hint}</span>
                </label>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Champ en lecture seule, calculé automatiquement.
              {editing ? ' Le type ne peut pas être modifié après création.' : ''}
            </p>
          </div>
        )}

        {/* Mode "button" — déclenche une automation (field_rule) sur le record au clic */}
        {kind === 'button' && (
          <>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Libellé du bouton</label>
              <input
                value={buttonLabel}
                data-testid="cf-button-label"
                onChange={e => setButtonLabel(e.target.value)}
                onBlur={() => autosaveButton()}
                className="input text-sm w-full"
                placeholder="ex: Pousser sur QuickBooks"
              />
              <p className="text-[11px] text-slate-400 mt-1">Texte affiché sur le bouton dans chaque ligne.</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Automation à déclencher</label>
              <SearchableSelect
                value={buttonAutomationId}
                options={automations}
                getOptionValue={a => a.id}
                getOptionLabel={a => a.name}
                onChange={v => { setButtonAutomationId(v); autosaveButton({ automation_id: v }) }}
                placeholder="Choisir une règle de champ…"
                searchPlaceholder="Rechercher une automation…"
                className="input text-sm w-full"
                size="sm"
                testId="cf-button-automation"
              />
              {automations.length === 0 && (
                <p className="text-[11px] text-amber-600 mt-1">Aucune règle de champ — créez-en une dans Automations d'abord.</p>
              )}
              <p className="text-[11px] text-slate-400 mt-1">
                Au clic, l'action de cette règle s'exécute sur le record de la ligne (le déclencheur de la règle est ignoré). Historique visible dans Automations → exécutions.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Style</label>
              <div className="grid grid-cols-4 gap-2">
                {BUTTON_STYLE_OPTIONS.map(o => (
                  <label
                    key={o.v}
                    data-testid={`cf-button-style-${o.v}`}
                    className={`flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border cursor-pointer transition-colors ${buttonStyle === o.v ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'}`}
                  >
                    <input
                      type="radio" name="cf-button-style" value={o.v}
                      checked={buttonStyle === o.v}
                      onChange={() => { setButtonStyle(o.v); autosaveButton({ style: o.v }) }}
                      className="sr-only"
                    />
                    <span className={`h-3 w-3 rounded-full ${o.dot}`} />
                    {o.label}
                  </label>
                ))}
              </div>
            </div>
          </>
        )}

        {editing && viewError && (
          <div className="rounded bg-red-50 border border-red-200 p-2 text-xs text-red-700">
            <span className="font-semibold">#ERROR</span> — ce champ ne se calcule plus : {viewError}. Corrigez la référence pour le réparer.
          </div>
        )}

        {error && <div className="rounded bg-red-50 border border-red-200 p-2 text-xs text-red-700">{error}</div>}

        {/* Rapport d'usage avant suppression — quels champs calculés casseraient. */}
        {editing && deleteStep !== 'idle' && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm" data-testid="cf-delete-report">
            {deleteStep === 'loading' ? (
              <p className="text-slate-500">Analyse des dépendances…</p>
            ) : dependents.length > 0 ? (
              <div>
                <p className="font-semibold text-red-700">
                  {dependents.length} dépendance{dependents.length > 1 ? 's' : ''} affectée{dependents.length > 1 ? 's' : ''} par la suppression
                </p>
                {groupDependents(dependents).map(([cat, items]) => (
                  <div key={cat} className="mt-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-red-500">{DEPENDENT_CATEGORY_LABELS[cat]}</p>
                    <ul className="mt-0.5 space-y-1">
                      {items.map(d => (
                        <li key={d.id} className="flex items-baseline gap-2 text-red-700" data-testid="cf-dependent">
                          <span className="font-medium">{d.name}</span>
                          <span className="text-[11px] text-red-400">
                            ({d.relation}{d.table && d.table !== erpTable ? ` — table ${d.table}` : ''})
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                <p className="mt-2 text-[11px] text-red-600">
                  Les champs calculés cesseront de se calculer (#ERROR) ; les automations et vues concernées devront être ajustées. Restaurable depuis la corbeille.
                </p>
              </div>
            ) : (
              <p className="text-slate-600">Aucune dépendance : rien d'autre ne référence ce champ. Restaurable depuis la corbeille.</p>
            )}
            {deleteStep !== 'loading' && (
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => setDeleteStep('idle')} className="btn-secondary text-xs py-1">Annuler</button>
                <button
                  type="button"
                  onClick={confirmDelete}
                  disabled={deleteStep === 'deleting'}
                  data-testid="cf-delete-confirm"
                  className="btn-danger text-xs py-1"
                >
                  {deleteStep === 'deleting' ? 'Suppression…' : (dependents.length > 0 ? 'Supprimer quand même' : 'Supprimer')}
                </button>
              </div>
            )}
          </div>
        )}

        {editing ? (
          // Édition : autosave au blur, pas de bouton « Enregistrer ». On affiche
          // un état de sauvegarde discret, un bouton « Supprimer le champ » (avec
          // rapport de dépendances) et un bouton « Fermer ».
          <div className="flex items-center justify-between gap-3 pt-2">
            <button
              type="button"
              onClick={startDelete}
              disabled={deleteStep !== 'idle'}
              data-testid="cf-delete-start"
              className="text-sm text-red-600 hover:text-red-700 disabled:opacity-40"
            >
              Supprimer le champ
            </button>
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400 min-h-[1rem]">
                {saving ? 'Enregistrement…' : (savedFlash ? 'Enregistré ✓' : '')}
              </span>
              <button type="button" onClick={onClose} className="btn-secondary">Fermer</button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? 'Enregistrement…' : 'Créer'}
            </button>
          </div>
        )}
      </form>
    </Modal>
  )
}

// Ordre d'affichage des catégories de fonctions dans le panneau « Fonctions
// disponibles ». Le catalogue lui-même (parité Airtable) vient du serveur via
// meta.formula_functions (source unique : formulaEngine.js) — plus de liste
// dupliquée côté client qui dériverait du moteur réel.
const FN_CATEGORY_ORDER = ['Texte', 'Nombre', 'Logique', 'Date', 'Durée']

// Éditeur de formule à la Airtable : autocomplete des champs de la table + des
// fonctions (catalogue serveur, parité Airtable), et bouton « Tester » qui
// évalue l'expression sur de vrais records.
function FormulaEditor({ value, onChange, onBlur, erpTable, sourceColumns, functions = [] }) {
  const taRef = useRef(null)
  const pendingCaret = useRef(null)
  const [suggest, setSuggest] = useState({ open: false, items: [], active: 0 })
  const [showFns, setShowFns] = useState(false)
  const [preview, setPreview] = useState({ loading: false, rows: null, error: null })

  // Après une insertion programmatique, replacer le curseur au bon endroit.
  useEffect(() => {
    if (pendingCaret.current != null && taRef.current) {
      const p = pendingCaret.current
      pendingCaret.current = null
      taRef.current.focus()
      taRef.current.setSelectionRange(p, p)
    }
  })

  // Calcule les suggestions pour le token (identifiant) qui précède le curseur.
  function computeSuggest(text, caret) {
    const before = text.slice(0, caret)
    const m = before.match(/[a-zA-Z0-9_]+$/)
    if (!m) return []
    const tok = m[0].toLowerCase()
    const rank = (name) => (name.toLowerCase().startsWith(tok) ? 0 : 1)
    const fields = (sourceColumns || [])
      .filter(c => c.toLowerCase().includes(tok))
      .map(c => ({ type: 'field', name: c, hint: 'Champ' }))
    const fns = (functions || [])
      .filter(f => f.name.toLowerCase().includes(tok))
      .map(f => ({ type: 'function', name: f.name, hint: f.sig }))
    return [...fields, ...fns]
      .sort((a, b) => rank(a.name) - rank(b.name))
      .slice(0, 8)
  }

  function refreshSuggest() {
    const el = taRef.current
    if (!el) return
    const items = computeSuggest(el.value, el.selectionStart)
    setSuggest(s => ({ open: items.length > 0, items, active: items.length ? Math.min(s.active, items.length - 1) : 0 }))
  }

  function applyInsert(item) {
    const el = taRef.current
    if (!el) return
    const caret = el.selectionStart
    const before = value.slice(0, caret)
    const after = value.slice(caret)
    const m = before.match(/[a-zA-Z0-9_]+$/)
    const tokenStart = m ? caret - m[0].length : caret
    const insertText = item.type === 'function' ? `${item.name}()` : item.name
    const caretOffset = item.type === 'function' ? item.name.length + 1 : item.name.length
    onChange(value.slice(0, tokenStart) + insertText + after)
    pendingCaret.current = tokenStart + caretOffset
    setSuggest({ open: false, items: [], active: 0 })
  }

  // Insère un texte au curseur (depuis le panneau de fonctions / chips de champ).
  function insertAtCaret(snippet, caretInsideParens = false) {
    const el = taRef.current
    const caret = el ? el.selectionStart : value.length
    const before = value.slice(0, caret)
    const after = value.slice(caret)
    onChange(before + snippet + after)
    pendingCaret.current = caret + (caretInsideParens ? snippet.indexOf('(') + 1 : snippet.length)
  }

  function onKeyDown(e) {
    if (!suggest.open || suggest.items.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSuggest(s => ({ ...s, active: (s.active + 1) % s.items.length }))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSuggest(s => ({ ...s, active: (s.active - 1 + s.items.length) % s.items.length }))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      applyInsert(suggest.items[suggest.active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setSuggest({ open: false, items: [], active: 0 })
    }
  }

  async function runTest() {
    const expr = value.trim()
    if (!expr) { setPreview({ loading: false, rows: null, error: 'Expression vide' }); return }
    setPreview({ loading: true, rows: null, error: null })
    try {
      const r = await api.customFields.previewFormula(erpTable, { formula_expr: expr, limit: 5 })
      setPreview({ loading: false, rows: r.rows || [], error: null })
    } catch (e) {
      setPreview({ loading: false, rows: null, error: e.message || 'Erreur' })
    }
  }

  const fmtValue = (v) => v === null || v === undefined
    ? <span className="text-slate-300 italic">∅</span>
    : <span className="font-mono">{String(v)}</span>

  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Formule</label>
      <div className="relative">
        <textarea
          ref={taRef}
          value={value}
          onChange={e => { onChange(e.target.value); refreshSuggest() }}
          onClick={refreshSuggest}
          onKeyUp={e => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) refreshSuggest() }}
          onKeyDown={onKeyDown}
          onBlur={() => { setTimeout(() => setSuggest({ open: false, items: [], active: 0 }), 120); onBlur?.() }}
          rows={3}
          className="input text-sm w-full font-mono"
          placeholder="ex: IF(status = 'Gagné', total, 0)  ·  DATETIME_FORMAT(document_date, 'YYYY-MM')"
          spellCheck={false}
        />
        {suggest.open && (
          <ul className="absolute z-20 left-2 right-2 mt-1 max-h-52 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg text-sm">
            {suggest.items.map((it, i) => (
              <li
                key={`${it.type}:${it.name}`}
                // onMouseDown (pas onClick) : se déclenche avant le blur du textarea.
                onMouseDown={e => { e.preventDefault(); applyInsert(it) }}
                onMouseEnter={() => setSuggest(s => ({ ...s, active: i }))}
                className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer ${i === suggest.active ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
              >
                <span className={`text-[10px] font-semibold px-1 rounded ${it.type === 'field' ? 'bg-sky-100 text-sky-700' : 'bg-violet-100 text-violet-700'}`}>
                  {it.type === 'field' ? 'ƒ' : 'fn'}
                </span>
                <span className="font-mono text-slate-700">{it.name}</span>
                <span className="text-[11px] text-slate-400 truncate ml-auto">{it.hint}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2 mt-2">
        <button type="button" onClick={runTest} disabled={preview.loading} className="btn-secondary text-xs py-1">
          {preview.loading ? 'Test…' : 'Tester'}
        </button>
        <button type="button" onClick={() => setShowFns(v => !v)} className="text-[11px] text-brand-600 hover:underline">
          {showFns ? 'Masquer les fonctions' : `Fonctions disponibles${functions.length ? ` (${functions.length})` : ''}`}
        </button>
        <span className="text-[11px] text-slate-400 ml-auto">Tape un nom de champ ou de fonction pour l'autocomplete.</span>
      </div>

      {showFns && (
        <div className="mt-2 rounded-lg border border-slate-100 bg-slate-50 p-2 max-h-64 overflow-y-auto">
          {functions.length === 0 ? (
            <p className="text-[11px] text-slate-400 px-1 py-2">Chargement du catalogue de fonctions…</p>
          ) : (
            // Regroupées par catégorie (Texte, Nombre, Logique, Date, Durée) —
            // même bibliothèque que les formules Airtable. Le catalogue est
            // fourni par le serveur (meta.formula_functions).
            FN_CATEGORY_ORDER
              .map(cat => [cat, functions.filter(f => f.category === cat)])
              // Catégories inconnues (au cas où le serveur en ajoute) : à la fin.
              .concat([['Autres', functions.filter(f => !FN_CATEGORY_ORDER.includes(f.category))]])
              .filter(([, fns]) => fns.length > 0)
              .map(([cat, fns]) => (
                <div key={cat} className="mb-1.5 last:mb-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 px-1 mb-0.5">{cat}</p>
                  <div className="grid grid-cols-2 gap-1">
                    {fns.map(f => (
                      <button
                        type="button"
                        key={f.name}
                        onMouseDown={e => { e.preventDefault(); insertAtCaret(`${f.name}()`, true) }}
                        title={f.sig}
                        className="flex flex-col items-start text-left px-2 py-1 rounded hover:bg-white text-[11px]"
                      >
                        <span className="font-mono text-violet-700">{f.name}</span>
                        <span className="text-slate-400 truncate w-full">{f.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))
          )}
        </div>
      )}

      {preview.error && (
        <div className="mt-2 rounded bg-red-50 border border-red-200 p-2 text-xs text-red-700">{preview.error}</div>
      )}
      {preview.rows && (
        preview.rows.length === 0 ? (
          <p className="mt-2 text-[11px] text-slate-400">Aucun enregistrement à prévisualiser.</p>
        ) : (
          <div className="mt-2 rounded-lg border border-slate-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left font-medium px-2 py-1">Enregistrement</th>
                  <th className="text-left font-medium px-2 py-1">Résultat</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={r.id || i} className="border-t border-slate-100">
                    <td className="px-2 py-1 text-slate-600 truncate max-w-[180px]">{r.label ?? r.id}</td>
                    <td className="px-2 py-1">{fmtValue(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      <p className="text-[11px] text-slate-400 mt-2">
        Référence les colonnes par leur nom. Mêmes fonctions que les formules Airtable (IF, SWITCH, CONCATENATE, DATEADD, ROUND…). Opérateurs <code className="bg-slate-100 px-1 rounded">||</code> <code className="bg-slate-100 px-1 rounded">+</code> <code className="bg-slate-100 px-1 rounded">-</code> <code className="bg-slate-100 px-1 rounded">*</code> <code className="bg-slate-100 px-1 rounded">/</code> autorisés.
      </p>
    </div>
  )
}

function ResultTypeSelect({ value, onChange }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Type d'affichage</label>
      <div className="flex gap-2">
        {[
          { v: 'text',   label: 'Texte' },
          { v: 'number', label: 'Nombre' },
          { v: 'date',   label: 'Date' },
        ].map(o => (
          <label key={o.v} className={`flex-1 flex items-center justify-center px-3 py-2 text-sm rounded-lg border cursor-pointer transition-colors ${value === o.v ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'}`}>
            <input
              type="radio" name="cf-result-type" value={o.v}
              checked={value === o.v}
              onChange={() => onChange(o.v)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </div>
  )
}

// Éditeur de choix pour les champs single_select / multi_select : libellé +
// couleur par choix, choix par défaut (étoile = single / cases = multi), ajout /
// retrait, et alphabétisation. En mode édition, `onPersist({ ch, di, dis, alpha })`
// autosauvegarde la config.
function ChoicesEditor({
  choices, setChoices, isMulti,
  defaultId, setDefaultId, defaultIds, setDefaultIds,
  alphabetize, setAlphabetize, onPersist,
}) {
  const [openColorIdx, setOpenColorIdx] = useState(null)

  // Applique un nouveau tableau de choix (state + autosave). `persist` permet de
  // différer la sauvegarde (ex: pendant la frappe d'un libellé).
  function applyChoices(next, persist = true) {
    setChoices(next)
    if (persist) onPersist?.({ ch: next })
  }

  function addChoice() {
    const color = SELECT_COLORS[choices.length % SELECT_COLORS.length]
    const next = [...choices, { id: tmpChoiceId(), label: '', color }]
    // Pas d'autosave tant que le libellé est vide (buildOptions le filtrerait).
    applyChoices(next, false)
  }

  function removeChoice(idx) {
    const removed = choices[idx]
    const next = choices.filter((_, i) => i !== idx)
    // Nettoie les défauts pointant sur le choix retiré.
    let di = defaultId, dis = defaultIds
    if (removed && defaultId === removed.id) { di = null; setDefaultId(null) }
    if (removed && defaultIds.includes(removed.id)) { dis = defaultIds.filter(x => x !== removed.id); setDefaultIds(dis) }
    setChoices(next)
    onPersist?.({ ch: next, di, dis })
  }

  function setColor(idx, color) {
    const next = choices.map((c, i) => i === idx ? { ...c, color } : c)
    setOpenColorIdx(null)
    applyChoices(next, true)
  }

  function setLabel(idx, label) {
    setChoices(choices.map((c, i) => i === idx ? { ...c, label } : c))
  }

  function toggleDefault(choice) {
    if (isMulti) {
      const dis = defaultIds.includes(choice.id)
        ? defaultIds.filter(x => x !== choice.id)
        : [...defaultIds, choice.id]
      setDefaultIds(dis)
      onPersist?.({ dis })
    } else {
      const di = defaultId === choice.id ? null : choice.id
      setDefaultId(di)
      onPersist?.({ di })
    }
  }

  function isDefault(choice) {
    return isMulti ? defaultIds.includes(choice.id) : defaultId === choice.id
  }

  return (
    <div data-testid="cf-choices-editor">
      <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Choix</label>
      <div className="space-y-1.5">
        {choices.length === 0 && (
          <p className="text-[11px] text-slate-400">Aucun choix — ajoutez-en au moins un.</p>
        )}
        {choices.map((c, idx) => (
          <div key={c.id} className="flex items-center gap-1.5">
            {/* Sélecteur de couleur */}
            <div className="relative">
              <button
                type="button"
                aria-label="Couleur du choix"
                onClick={() => setOpenColorIdx(openColorIdx === idx ? null : idx)}
                className={`h-6 w-6 rounded-full border border-slate-300 ${COLOR_DOT[c.color] || COLOR_DOT.gray}`}
              />
              {openColorIdx === idx && (
                <div className="absolute z-30 mt-1 left-0 grid grid-cols-6 gap-1 p-2 rounded-lg border border-slate-200 bg-white shadow-lg">
                  {SELECT_COLORS.map(col => (
                    <button
                      type="button"
                      key={col}
                      aria-label={col}
                      data-testid={`cf-color-${col}`}
                      onClick={() => setColor(idx, col)}
                      className={`h-5 w-5 rounded-full ${COLOR_DOT[col]} ${c.color === col ? 'ring-2 ring-offset-1 ring-slate-500' : ''}`}
                    />
                  ))}
                </div>
              )}
            </div>
            <input
              value={c.label}
              data-testid={`cf-choice-label-${idx}`}
              onChange={e => setLabel(idx, e.target.value)}
              onBlur={() => onPersist?.({ ch: choices })}
              className="input text-sm flex-1 min-w-0"
              placeholder={`Choix ${idx + 1}`}
            />
            {/* Choix par défaut */}
            <button
              type="button"
              title={isMulti ? 'Inclure par défaut' : 'Choix par défaut'}
              aria-label="Choix par défaut"
              onClick={() => toggleDefault(c)}
              className={`p-1.5 rounded ${isDefault(c) ? 'text-amber-500' : 'text-slate-300 hover:text-slate-400'}`}
            >
              {isMulti
                ? <Check size={15} className={isDefault(c) ? '' : 'opacity-40'} />
                : <Star size={15} fill={isDefault(c) ? 'currentColor' : 'none'} />}
            </button>
            <button
              type="button"
              title="Retirer le choix"
              aria-label="Retirer le choix"
              onClick={() => removeChoice(idx)}
              className="p-1.5 rounded text-slate-300 hover:text-red-500"
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={addChoice}
        data-testid="cf-add-choice"
        className="mt-2 inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700"
      >
        <Plus size={13} /> Ajouter un choix
      </button>
      <label className="flex items-center gap-2 mt-3 text-xs text-slate-600 cursor-pointer">
        <input
          type="checkbox"
          checked={alphabetize}
          onChange={e => { setAlphabetize(e.target.checked); onPersist?.({ alpha: e.target.checked }) }}
          className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        />
        Trier les choix par ordre alphabétique
      </label>
      <p className="text-[11px] text-slate-400 mt-1">
        {isMulti ? "L'icône ✓ marque les choix inclus par défaut." : "L'étoile marque le choix par défaut."}
      </p>
    </div>
  )
}

export default CustomFieldModal
