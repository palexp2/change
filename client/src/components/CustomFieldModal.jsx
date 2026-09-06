import { useState, useEffect, useMemo, useRef } from 'react'
import { Plus, X, Check, Star, AlertTriangle, RotateCcw, GripVertical } from 'lucide-react'
import { Modal } from './Modal.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import api from '../lib/api.js'
import {
  OVERRIDE_TYPES, typeLabel, normalizeFieldType, parseNativeChoices,
  LINK_TYPE_PREFIX, linkTargetOfType, linkTargetLabel,
} from '../lib/fieldOverrides.jsx'
import { FieldTypeIcon } from '../lib/fieldTypeIcons.jsx'
import { formatDurationSeconds, normalizeDurationFormat } from '../lib/duration.js'
import {
  currencyCodeOf, phoneCountryCodeOf, dateFormatOf, isAirtableLinkField,
} from '../lib/customFieldDisplay.jsx'
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

// Libellé du champ de liaison d'une source de rollup : le nom du champ tel que
// l'utilisateur le voit dans la table liée (« Commande »), pas la colonne
// technique (`order_id`). Repli sur le nom technique si la table n'expose pas
// de libellé curé.
function uiFkLabel(table, column) {
  const meta = (TABLE_COLUMN_META[table] || []).find(c => c.field === column)
  return meta?.label || column
}

// En-tête de la modale de champ : « Modifier le champ — Nom du champ ». Sans le
// nom, une fois la modale ouverte rien ne rappelle QUEL champ on modifie (les
// réglages seuls se ressemblent d'un champ à l'autre). Le nom est tronqué pour
// ne pas pousser le bouton de fermeture hors de l'en-tête.
function fieldModalTitle(prefix, fieldName) {
  const n = (fieldName || '').trim()
  if (!n) return prefix
  return `${prefix} — ${n.length > 48 ? `${n.slice(0, 47)}…` : n}`
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

// Choix D'ORIGINE d'un champ natif de type Sélection : la liste `options` que
// tableDefs.js déclare pour la colonne (des valeurs brutes). Chaque valeur naît
// avec elle-même comme libellé et sans couleur choisie — « couleur d'origine »,
// c'est-à-dire le rendu que la page fait déjà d'elle.
function baselineChoices(column) {
  const raw = Array.isArray(column?.options) ? column.options : []
  return raw
    .map(o => {
      const v = (o && typeof o === 'object') ? String(o.value ?? o.label ?? '') : String(o ?? '')
      return { value: v, id: v, label: v, color: null }
    })
    .filter(c => c.value !== '')
}

// État des choix natifs → config persistée. Un choix neuf (sans valeur) prend
// son libellé comme valeur : c'est elle qui sera écrite en base.
function serializeChoices(choices) {
  const out = []
  const seen = new Set()
  for (const c of choices || []) {
    const label = String(c?.label ?? '').trim()
    const value = String(c?.value ?? label).trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push({ value, label: label || value, color: c?.color || null })
  }
  return { choices: out }
}

// Sous-types de champs auto-remplis (lecture seule, calculés à la lecture).
// Le `kind` stocké côté serveur est directement le sous-type ; côté UI on les
// regroupe sous l'onglet « Auto ».
const AUTO_KINDS = ['created_time', 'last_modified_time', 'created_by', 'last_modified_by']

// Entrée de menu réservée aux champs lien Airtable (options.airtable_link_hint).
// Pas un type stocké : en base ces champs restent kind='data' / type='text'.
const AIRTABLE_LINK_TYPE_ID = 'airtable_link'

// Liste UNIQUE des types de champ. La nature du champ (saisi à la main, calculé,
// posé par le système) et le type de sa valeur ne font plus deux sections : un
// seul menu, comme dans Airtable, où « Formule » ou « Créé le » se choisissent
// à côté de « Texte ». Chaque entrée dit ce qu'elle pose en base : `kind`
// (custom_fields.kind), `type` pour un champ de donnée, `autoType` pour un champ
// système (dont le kind stocké EST le sous-type).
const FIELD_TYPE_OPTIONS = [
  { id: 'text',               label: 'Texte',           kind: 'data', type: 'text' },
  { id: 'long_text',          label: 'Texte long',      kind: 'data', type: 'long_text', hint: 'Texte multiligne, zone extensible' },
  { id: 'number',             label: 'Nombre',          kind: 'data', type: 'number' },
  { id: 'currency',           label: 'Devise',          kind: 'data', type: 'currency', hint: 'Nombre au format monétaire' },
  { id: 'duration',           label: 'Durée',           kind: 'data', type: 'duration', hint: '« 1:30 », stockée en secondes' },
  { id: 'date',               label: 'Date',            kind: 'data', type: 'date', hint: 'Date sans heure' },
  { id: 'url',                label: 'URL',             kind: 'data', type: 'url', hint: 'Lien cliquable' },
  { id: 'phone',              label: 'Téléphone',       kind: 'data', type: 'phone', hint: 'Formaté et cliquable' },
  { id: 'checkbox',           label: 'Case à cocher',   kind: 'data', type: 'checkbox', hint: 'Oui / non' },
  { id: 'single_select',      label: 'Sélection',       kind: 'data', type: 'single_select', hint: 'Un choix, en pastille colorée' },
  { id: 'multi_select',       label: 'Multi-sélection', kind: 'data', type: 'multi_select', hint: 'Plusieurs choix, en pastilles' },
  { id: 'attachment',         label: 'Attachement',     kind: 'data', type: 'attachment', hint: 'Fichiers déposés : PDF, images…' },
  { id: 'formula',            label: 'Formule',         kind: 'formula', hint: 'Calcul à partir d\'autres colonnes' },
  { id: 'lookup',             label: 'Lookup',          kind: 'lookup', hint: 'Valeur d\'une table liée' },
  { id: 'rollup',             label: 'Rollup',          kind: 'rollup', hint: 'Agrégat d\'une table liée' },
  { id: 'button',             label: 'Bouton',          kind: 'button', hint: 'Déclenche une automation' },
  { id: 'created_time',       label: 'Créé le',         kind: 'auto', autoType: 'created_time', hint: 'Quand l\'enregistrement a été créé' },
  { id: 'last_modified_time', label: 'Modifié le',      kind: 'auto', autoType: 'last_modified_time', hint: 'Dernière modification' },
  { id: 'created_by',         label: 'Créé par',        kind: 'auto', autoType: 'created_by', hint: 'Utilisateur créateur' },
  { id: 'last_modified_by',   label: 'Modifié par',     kind: 'auto', autoType: 'last_modified_by', hint: 'Dernier utilisateur' },
  // Une liaison ne se crée ni ne se convertit ici (le serveur refuse) : cette
  // entrée ne sert qu'à NOMMER le type d'un champ de liaison existant.
  { id: 'link',               label: 'Liaison',         kind: 'link', hint: 'Relation entre deux tables' },
  // Champ lien importé d'Airtable : stocké en `data`/`text` (la colonne porte
  // l'id du record lié), mais ce n'est pas un champ texte — le tableau des
  // champs l'annonce « Lien », la modale disait « Texte ». Comme « Liaison »,
  // cette entrée ne sert qu'à NOMMER le type d'un champ existant.
  { id: AIRTABLE_LINK_TYPE_ID, label: 'Lien',           kind: 'data', type: 'text', hint: 'Champ lié d\'Airtable : la colonne porte l\'id du record lié' },
]
const FIELD_TYPE_BY_ID = new Map(FIELD_TYPE_OPTIONS.map(o => [o.id, o]))

// Synonymes de recherche du menu de type. Les types portent ici un nom français
// (« Sélection », « Attachement ») alors qu'on les cherche souvent avec le
// vocabulaire d'Airtable ou l'anglais : chercher « single select » ne trouvait
// rien, donc le type paraissait absent. Ces mots-clés ne s'affichent jamais.
const FIELD_TYPE_SYNONYMS = {
  text: 'text string chaine',
  long_text: 'long text paragraphe multiligne',
  number: 'number numerique integer entier decimal',
  currency: 'currency montant argent prix dollar',
  duration: 'duration temps heure minute',
  date: 'date jour calendrier',
  url: 'url lien link web',
  phone: 'phone numero tel',
  checkbox: 'checkbox booleen bool oui non toggle',
  single_select: 'single select selection simple liste choix pastille dropdown',
  multi_select: 'multi select multiple etiquettes tags liste choix',
  attachment: 'attachment file fichier piece jointe pdf image',
  formula: 'formula calcul expression',
  lookup: 'lookup valeur liee table liee',
  rollup: 'rollup agregat somme total moyenne',
  button: 'button action automation declencher',
  created_time: 'created time date de creation',
  last_modified_time: 'last modified time date de modification',
  created_by: 'created by auteur utilisateur',
  last_modified_by: 'last modified by utilisateur',
  link: 'link liaison relation',
  [AIRTABLE_LINK_TYPE_ID]: 'lien link airtable record lie',
}

// Filtre du menu de type : libellé, explication et synonymes, sans accents et
// mot à mot (« select single » trouve autant que « single select »). Les
// explications ne s'affichent plus dans les lignes du menu — elles restent
// cherchables, et celle du type choisi se lit sous le sélecteur.
function matchFieldType(o, q) {
  const hay = normalizeSearch(`${o.label} ${o.hint || ''} ${FIELD_TYPE_SYNONYMS[o.id] || ''}`)
  return normalizeSearch(q).split(/\s+/).filter(Boolean).every(w => hay.includes(w))
}

// Sélecteur de TYPE d'un champ — UN SEUL composant pour toute l'app. Champ
// perso ou champ natif, le type se choisit dans le même dropdown recherchable
// (icône + libellé, rien de plus) : la grille de tuiles qui servait aux champs natifs
// donnait deux modales « Modifier le champ » d'aspect différent selon le champ
// cliqué, et elle ne tenait plus dès qu'il y avait plus d'une poignée de types.
//
// `options` : [{ id, label, hint? }] — `id` est la valeur rendue par onChange,
// `hint` sert seulement à la recherche. `hint` (prop) : explication sous le sélecteur. `children` : ce que l'appelant glisse
// juste en dessous (avertissement de conversion, choix de la table visée…).
function FieldTypeSelect({ value, options, onChange, hint, disabled = false, testId, children }) {
  return (
    <div>
      <label className="label">Type</label>
      <SearchableSelect
        testId={testId}
        size="sm"
        className="input text-sm w-full bg-white"
        value={value}
        options={options}
        getOptionValue={o => o.id}
        getOptionKey={o => o.id}
        getOptionLabel={o => o.label}
        renderOption={o => (
          <span className="flex items-center gap-2 min-w-0">
            <FieldTypeIcon type={o.id} className="text-slate-400 flex-shrink-0" />
            <span className="truncate">{o.label}</span>
          </span>
        )}
        renderValue={o => (
          <span className="flex items-center gap-2 min-w-0">
            <FieldTypeIcon type={o.id} className="text-slate-400 flex-shrink-0" />
            <span className="truncate">{o.label}</span>
          </span>
        )}
        onChange={onChange}
        filterOption={matchFieldType}
        searchPlaceholder="Rechercher un type…"
        disabled={disabled}
      />
      {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
      {children}
    </div>
  )
}

const AUTO_TYPE_OPTIONS = [
  { v: 'created_time',       label: 'Date de création',       hint: 'Quand l\'enregistrement a été créé' },
  { v: 'last_modified_time', label: 'Date de modification',   hint: 'Quand l\'enregistrement a été modifié pour la dernière fois' },
  { v: 'created_by',         label: 'Créé par',               hint: 'Utilisateur ayant créé l\'enregistrement' },
  { v: 'last_modified_by',   label: 'Modifié par',            hint: 'Dernier utilisateur ayant modifié' },
]

// Bloc « Champ Airtable » de la modale : la cellule de mapping fournie par la
// page appelante, sous le même libellé que les autres réglages du champ.
// Un champ calculé n'a rien à importer : le bloc ne s'affiche pas du tout
// plutôt que d'expliquer son absence.
// Exporté : l'appelant enveloppe LUI-MÊME sa cellule (voir `mappingSlot`), ce
// qui lui laisse le droit de ne rien afficher — un bloc vide au libellé
// « Champ Airtable » serait pire que pas de bloc.
export function MappingBlock({ children }) {
  return (
    <div data-testid="cf-airtable-mapping" data-mappable="1">
      <label className="label">
        Champ Airtable
      </label>
      {children}
    </div>
  )
}

// Zone « Description » d'un champ (natif ou perso). Le texte s'affiche en
// infobulle derrière un petit « ? » gris à côté du titre de la colonne dans
// tous les DataTables ; vide = pas de « ? ». Autosave au blur.
function FieldDescriptionInput({ value, onChange, onBlur, testId }) {
  return (
    <div>
      <label className="label">Description</label>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={onBlur}
        rows={2}
        maxLength={500}
        className="input text-sm w-full resize-y min-h-[2.5rem]"
        data-testid={testId}
      />
    </div>
  )
}

// Modale UNIQUE de modification de champ, commune à tous les champs de toutes
// les tables :
//   - champs custom (création + édition) → CustomFieldModalInner ci-dessous ;
//   - champs natifs (colonnes de tableDefs.js) → NativeFieldModal : renommage +
//     changement de type d'affichage via un override cosmétique persisté dans
//     field_overrides (la colonne SQL et les syncs ne bougent pas).
// Passer `native={{ column, override }}` pour éditer un champ natif ; sinon la
// modale se comporte comme avant (champ custom).
//
// `mappingSlot` : bloc « Champ Airtable » de la colonne, rendu TEL QUEL dans la
// modale — changer le champ Airtable qui alimente un champ ne demande plus de
// refermer la modale et d'aller chercher la colonne « Champ Airtable » dans le
// tableau de /champs/:table. L'appelant l'enveloppe dans `MappingBlock` (exporté
// ci-dessus) et décide de ne rien passer quand il n'y a rien à mapper :
//   - la page /champs a déjà les données du module → elle construit la cellule ;
//   - un tableau ordinaire passe `<FieldAirtableMapping>`, qui les charge seul.
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
//
// Valeur de la tuile de type « Lien vers… » tant qu'aucune table cible n'est
// choisie : une FAMILLE de types, pas un type — le type réellement enregistré
// est `link:<table>` (cf. linkTargetOfType).
const LINK_FAMILY = 'link'

function NativeFieldModal({ isOpen, onClose, erpTable, native, onSaved, mappingSlot }) {
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
  // Choix d'un champ natif de type Sélection : [{ value, label, color|null }].
  // `value` est la valeur stockée en base (figée) ; le reste est de l'affichage.
  const [choices, setChoices] = useState([])
  // Override actif côté serveur — suivi localement pour que les autosaves
  // successifs (et le bouton Réinitialiser) restent cohérents sans attendre le
  // rafraîchissement de la prop `override` par le parent.
  const [hasOverride, setHasOverride] = useState(false)
  // Description libre du champ (infobulle « ? » de l'en-tête de colonne).
  const [description, setDescription] = useState('')
  const lastSavedDescription = useRef('')
  // Tables qu'on peut désigner comme cible d'un affichage « Lien vers … »
  // (celles qui ont une fiche à ouvrir — servies par le serveur pour éviter
  // qu'une liste figée ici ne dérive de la sienne).
  const [linkTables, setLinkTables] = useState([])
  // Dernières valeurs persistées — évite de re-PATCH un champ inchangé au blur.
  const lastSaved = useRef({ label: '', type: 'text', decimals: 2, countryCode: 'hide' })
  // Dernière config de choix persistée (JSON) — évite un PATCH au blur d'un
  // libellé qui n'a pas changé.
  const lastSavedChoicesJson = useRef('')

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
    const desc = override?.description || ''
    setDescription(desc)
    lastSavedDescription.current = desc
    // Sélection : les choix configurés, sinon la liste d'origine de tableDefs.js
    // (chaque valeur avec elle-même comme libellé et sa couleur d'origine).
    const conf = parseNativeChoices(override)
    setChoices(conf.length ? conf : baselineChoices(column))
    lastSavedChoicesJson.current = conf.length ? JSON.stringify(serializeChoices(conf)) : ''
    setError(null)
    // `override` volontairement hors deps : après un autosave, le parent
    // recharge les overrides et la prop change — sans ce garde, l'effet
    // écraserait la saisie en cours avec les valeurs re-fetchées.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, column?.id])

  useEffect(() => {
    if (!isOpen || linkTables.length) return
    let alive = true
    api.recordLinks.tables()
      .then(r => { if (alive) setLinkTables(r?.data || []) })
      .catch(() => { /* liste optionnelle : sans elle, pas de cible à proposer */ })
    return () => { alive = false }
  }, [isOpen, linkTables.length])

  if (!column) return null

  // Table cible quand le champ est déjà affiché en lien ; `LINK_FAMILY` est la
  // tuile de type « Lien vers… » tant qu'aucune cible n'est choisie — elle n'est
  // jamais enregistrée telle quelle.
  const linkTarget = linkTargetOfType(type)
  const linkPicking = type === LINK_FAMILY || !!linkTarget
  const typeChanged = type !== originalType && (!linkPicking || !!linkTarget)
  // Types proposés : le type d'origine d'abord (= pas d'override), puis les
  // types d'affichage supportés.
  //
  // Une colonne dotée d'un rendu sur-mesure (lien cliquable vers une fiche,
  // badge…) annonce ce rendu comme un TYPE À PART ENTIÈRE — « Lien vers
  // Entreprise » plutôt que « Texte ». Sans ce nom, choisir « Texte » faisait
  // perdre le lien sans que rien ne l'annonce, et rien n'indiquait comment le
  // retrouver ; le re-sélectionner rétablit le rendu d'origine.
  const originLabel = column?.renderTypeLabel || typeLabel(originalType)
  const typeOptions = [
    { id: originalType, label: originLabel, hint: 'type d\'origine' },
    ...OVERRIDE_TYPES.filter(t => t.value !== originalType).map(t => ({ id: t.value, label: t.label })),
    // …et le lien vers la fiche d'une autre table : la cible se choisit juste
    // en dessous, une fois le type retenu.
    { id: LINK_FAMILY, label: 'Lien vers…', hint: 'ouvre la fiche d\'une autre table' },
  ]

  const isSelect = originalType === 'single_select' || originalType === 'multi_select'
  // Une config de choix est-elle enregistrée côté serveur ? Lu dans la ref au
  // moment de l'appel : le retour automatique à l'original (libellé et type
  // revenus à leur valeur d'origine) ne doit pas l'effacer au passage — seul le
  // bouton « Réinitialiser » le fait.
  const hasChoicesConfig = () => lastSavedChoicesJson.current !== ''
  const hasDescription = () => lastSavedDescription.current !== ''

  // Autosave de la description. Une description effacée alors que plus rien
  // d'autre n'est personnalisé retire l'override entier (retour à l'original).
  async function persistDescription() {
    const v = description.trim()
    if (v === lastSavedDescription.current) return
    setError(null)
    setSaving(true)
    try {
      const ls = lastSaved.current
      const nothingElse = ls.label === originalLabel && ls.type === originalType
        && !(ls.type === 'phone' && ls.countryCode === 'show') && !hasChoicesConfig()
      if (!v && nothingElse) {
        if (hasOverride) await api.fieldOverrides.reset(table, column.id)
        setHasOverride(false)
      } else {
        await api.fieldOverrides.save(table, column.id, { description: v || null })
        setHasOverride(true)
      }
      lastSavedDescription.current = v
      onSaved?.()
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    } catch (e) {
      setError(e.message || 'Erreur')
    } finally {
      setSaving(false)
    }
  }

  // Autosave des choix. La liste vaut pour l'ORDRE ; chaque choix garde sa
  // valeur en base, ne changent que le libellé affiché et la couleur.
  async function persistChoices(nextChoices) {
    const payload = serializeChoices(nextChoices)
    const json = JSON.stringify(payload)
    if (json === lastSavedChoicesJson.current) return
    setError(null)
    setSaving(true)
    try {
      await api.fieldOverrides.save(table, column.id, { options: payload })
      lastSavedChoicesJson.current = json
      setHasOverride(true)
      onSaved?.()
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    } catch (e) {
      setError(e.message || 'Erreur')
    } finally {
      setSaving(false)
    }
  }

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
    // Tuile « Lien vers… » sélectionnée sans cible : ce n'est pas encore un
    // type. Un autre autosave (le nom, la description) ne doit pas l'enregistrer
    // ni effacer le type en place.
    if (cur.type === LINK_FAMILY) cur.type = ls.type
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
      if (!labelChanged && !typeIsOverridden && !ccIsOverridden && !hasChoicesConfig() && !hasDescription()) {
        // Tout est revenu aux valeurs d'origine → on retire l'override.
        if (hasOverride) {
          await api.fieldOverrides.reset(table, column.id)
          setHasOverride(false)
        }
      } else if (!labelChanged && !typeIsOverridden && !ccIsOverridden) {
        // Plus rien de personnalisé SAUF les choix de la Sélection et/ou la
        // description : on efface les autres aspects sans toucher à ceux-là.
        await api.fieldOverrides.save(table, column.id, {
          label: null, type: null, decimals: null, country_code: null,
          ...(hasChoicesConfig() ? { options: JSON.parse(lastSavedChoicesJson.current) } : {}),
          description: lastSavedDescription.current || null,
        })
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
      setChoices(baselineChoices(column))
      lastSavedChoicesJson.current = ''
      setDescription('')
      lastSavedDescription.current = ''
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
    <Modal isOpen={isOpen} onClose={onClose} title={fieldModalTitle('Modifier le champ', label || originalLabel)} size="md">
      <form onSubmit={e => { e.preventDefault(); persist() }} className="space-y-4">
        {mappingSlot}

        <div>
          <label className="label">Nom</label>
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

        <FieldTypeSelect
          testId="field-override-type"
          value={linkPicking ? LINK_FAMILY : type}
          options={typeOptions}
          hint={typeChanged ? `Type d'origine : ${originLabel}.` : null}
          onChange={id => {
            // Déjà en lien vers une table : garder la cible affichée plutôt que
            // de la faire disparaître en re-choisissant la même famille.
            if (id === LINK_FAMILY && linkTarget) return
            setType(id)
            // « Lien vers… » n'enregistre rien : c'est le choix de la table
            // cible, juste en dessous, qui le fait.
            if (id !== LINK_FAMILY) persist({ type: id })
          }}
        >
          {/* Table visée par le lien. La valeur de la colonne est reconnue par
              son identifiant OU par son nom : « Ferme du Nord » mène à la fiche
              de l'entreprise aussi bien qu'un id. */}
          {linkPicking && (
            <div className="mt-2">
              <SearchableSelect
                value={linkTarget || ''}
                options={linkTables.map(t => ({ value: t, label: linkTargetLabel(t) }))}
                onChange={v => {
                  if (!v) return
                  const next = `${LINK_TYPE_PREFIX}${v}`
                  setType(next)
                  persist({ type: next })
                }}
                size="sm"
                className="input text-sm w-full"
                testId="field-override-link-target"
              />
            </div>
          )}
        </FieldTypeSelect>

        {/* Sélection native : les choix possibles, tels qu'ils s'affichent et
            dans l'ordre où ils se présentent. Masqué si le champ est affiché
            sous un autre type (la config reste enregistrée). */}
        {isSelect && !typeChanged && (
          <ChoicesEditor
            native
            choices={choices}
            setChoices={setChoices}
            isMulti={originalType === 'multi_select'}
            defaultId={null}
            setDefaultId={() => {}}
            defaultIds={[]}
            setDefaultIds={() => {}}
            alphabetize={false}
            setAlphabetize={() => {}}
            onPersist={({ ch }) => persistChoices(ch || choices)}
          />
        )}

        {typeChanged && (type === 'number' || type === 'currency') && (
          <div>
            <label className="label">Décimales (0 à 5)</label>
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
            <label className="label">Indicatif de pays</label>
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

        {/* Description en dernier : c'est une note d'infobulle, pas un réglage
            du champ — elle passe après le nom, le type et la config. */}
        <FieldDescriptionInput
          value={description}
          onChange={setDescription}
          onBlur={persistDescription}
          testId="field-override-description"
        />

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
function CustomFieldModalInner({ isOpen, onClose, erpTable, editing, onSaved, onDeleted, mappingSlot }) {
  const { addToast } = useToast()
  const [kind, setKind] = useState('data')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('') // infobulle « ? » de l'en-tête (tous kinds)
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
  // Avertissement de conversion de type. Le serveur refuse un premier coup
  // (409) en listant ce qui ne se convertit pas ; on l'affiche tel quel avec un
  // bouton pour passer outre. Rien n'est écrit tant que personne n'a tranché.
  const [retypeWarn, setRetypeWarn] = useState(null)
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
        type: editing.type || 'text',
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
        result_type: editing.result_type || 'text',
        description: editing.description || '',
      }
      // Les sous-types auto sont stockés directement comme `kind` côté serveur ;
      // on les ramène à l'onglet « auto » + sous-type pour l'affichage.
      const k = editing.kind || 'data'
      const isAuto = AUTO_KINDS.includes(k)
      setKind(isAuto ? 'auto' : k)
      setAutoType(isAuto ? k : 'created_time')
      setName(editing.name || '')
      setDescription(editing.description || '')
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
      setDescription('')
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

  // ── Conversion de kind (édition) ──────────────────────────────────────────
  // Le serveur (PUT /:id) sait convertir tout kind sauf 'link'. Choisir un
  // autre onglet que le kind actuel bascule la modale en mode conversion : la
  // config du kind visé s'édite localement puis part en UN SEUL PUT via
  // handleConvert(). Transactionnel, pas d'autosave partiel — la conversion
  // change la nature du champ (exception admise à « autosave partout »).
  const editingKind = editing ? (AUTO_KINDS.includes(editing.kind) ? 'auto' : (editing.kind || 'data')) : null
  const converting = !!editing && kind !== editingKind
  // Champ lien Airtable : sa colonne porte l'id du record lié, c'est le sync qui
  // l'écrit. Pas plus convertible qu'une liaison — et surtout pas « Texte ».
  const atLink = !!editing && isAirtableLinkField(editing)
  const canConvert = !!editing && editing.kind !== 'link' && !atLink

  // Entrée du menu de type actuellement sélectionnée.
  const typeOptionId = atLink
    ? AIRTABLE_LINK_TYPE_ID
    : (kind === 'data' ? type : (kind === 'auto' ? autoType : kind))
  // Le menu ne propose que ce qui est réellement posable sur CE champ : pas de
  // sous-type auto que la table n'expose pas, et « Liaison » seulement sur un
  // champ de liaison. Le type de DONNÉE, lui, n'est plus figé après création :
  // le serveur convertit les valeurs (services/fieldTypeConvert.js) et prévient
  // quand certaines ne passent pas.
  const typeOptions = useMemo(() => {
    const autoAvailable = new Set([
      ...(autoOptions || []).map(o => o.v),
      ...(editingKind === 'auto' ? [editing.kind] : []),
    ])
    return FIELD_TYPE_OPTIONS.filter(o => {
      // « Lien » (Airtable) ne se choisit pas : elle nomme le champ ouvert, et
      // elle est alors le SEUL choix — comme « Liaison ».
      if (atLink || o.id === AIRTABLE_LINK_TYPE_ID) return atLink && o.id === AIRTABLE_LINK_TYPE_ID
      if (editingKind === 'link' || o.kind === 'link') return editingKind === 'link' && o.kind === 'link'
      if (o.kind === 'auto') return autoAvailable.has(o.autoType)
      return true
    })
  }, [autoOptions, editingKind, editing, atLink])

  // Explication du type choisi — remplace les paragraphes qui vivaient sous
  // l'ancienne grille de types, et dit ce qui est modifiable ou figé.
  const typeHint = useMemo(() => {
    const o = FIELD_TYPE_BY_ID.get(typeOptionId)
    const parts = []
    if (typeOptionId === 'currency') {
      parts.push(`Nombre au format monétaire (${currencyCode}, séparateurs). Devise et décimales configurables ci-dessous.`)
    } else if (o?.hint) parts.push(`${o.hint}.`)
    if (kind === 'auto') parts.push('Champ en lecture seule, calculé automatiquement.')
    if (atLink) {
      parts.push('Type fixé par la synchronisation Airtable.')
    } else if (editing && editingKind === 'link') {
      parts.push('Une liaison ne se convertit pas : créez le champ voulu et supprimez celui-ci.')
    } else if (editing && editingKind === 'data') {
      parts.push('Changer le type convertit les valeurs déjà saisies.')
    }
    return parts.join(' ')
  }, [typeOptionId, currencyCode, kind, editing, editingKind, atLink])

  // Choix d'un type dans le menu unique : pose le kind ET sa déclinaison.
  // Un kind différent de l'actuel bascule la modale en conversion (bouton
  // « Convertir ») ; rester dans le même kind autosauvegarde comme avant.
  function pickFieldType(id) {
    const o = FIELD_TYPE_BY_ID.get(id)
    if (!o || o.kind === 'link' || o.id === AIRTABLE_LINK_TYPE_ID) return
    setKind(o.kind)
    if (o.kind === 'rollup') setResultType('number')
    if (o.kind === 'auto') setAutoType(o.autoType)
    if (o.kind === 'data') {
      setType(o.type)
      // Devise : défaut 2 décimales (format monétaire usuel).
      if (o.type === 'currency') setDecimals(2)
      if (editing && editingKind === 'data' && o.type !== lastSaved.current.type) {
        retypeTo(o.type)
      }
    }
  }

  // Changement de type d'un champ de donnée EXISTANT. Les valeurs sont
  // converties côté serveur ; un 409 signifie « certaines ne se convertissent
  // pas » — on l'affiche et on attend, plutôt que de vider des cellules que
  // personne n'a demandé de vider. `force` = l'utilisateur a tranché.
  async function retypeTo(nextType, { force = false } = {}) {
    if (!editing) return
    setRetypeWarn(null)
    setError(null)
    setSaving(true)
    try {
      const result = await api.customFields.update(editing.id,
        force ? { type: nextType, force_convert: true } : { type: nextType })
      lastSaved.current.type = nextType
      // Les choix d'une sélection peuvent avoir été DÉRIVÉS des données : les
      // remonter dans l'éditeur, sinon la liste paraîtrait vide alors que le
      // serveur vient de la construire.
      const os = parseOptionsState(result?.options)
      setChoices(os.choices)
      setDefaultId(os.default_id)
      setDefaultIds(os.default_ids)
      setAlphabetize(os.alphabetize)
      lastSavedOptionsJson.current = ''
      setDecimals(result?.decimals ?? 2)
      setViewError(result?.view_error || null)
      onSaved?.(result)
      const r = result?.retype
      if (r?.cleared) {
        addToast({ message: `${r.cleared} valeur${r.cleared > 1 ? 's' : ''} vidée${r.cleared > 1 ? 's' : ''}`, type: 'success' })
      } else if (r?.derived_choices) {
        addToast({ message: `${r.derived_choices} choix créés depuis les données`, type: 'success' })
      }
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    } catch (e) {
      if (e?.status === 409 && e.details?.retype) {
        setRetypeWarn(e.details.retype)
      } else {
        // Le type n'a pas pris : ne pas laisser l'écran prétendre le contraire.
        setType(lastSaved.current.type || editing.type)
        setError(e.message || 'Erreur')
      }
    } finally {
      setSaving(false)
    }
  }

  // Abandon de l'avertissement : le champ retrouve son type d'origine.
  function cancelRetype() {
    setRetypeWarn(null)
    setType(lastSaved.current.type || editing?.type || 'text')
  }

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
  async function autosave(payload, { ignoreConverting = false } = {}) {
    if (!editing) return
    // Pendant une conversion, rien ne se persiste champ par champ : tout part
    // en un seul PUT au clic « Convertir » (handleConvert). Exception :
    // `ignoreConverting`, pour le retour au kind d'origine dans le même geste
    // (menu de type unique) — `converting` vaut encore l'état du rendu précédent.
    if (converting && !ignoreConverting) return
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

  // Applique la conversion de kind en un seul PUT. La validation fine est côté
  // serveur (rejouée par le builder du kind visé) ; on ne vérifie ici que la
  // complétude de la config, pour un message immédiat.
  async function handleConvert() {
    if (!editing) return
    setError(null)
    // Les sous-types auto sont stockés directement comme kind côté serveur.
    const payload = { kind: kind === 'auto' ? autoType : kind, name: name.trim() || editing.name }
    // La description saisie pendant la conversion part dans le même PUT
    // (l'autosave champ par champ est suspendu en mode conversion).
    if (description.trim() !== (lastSaved.current.description || '')) payload.description = description.trim() || null
    if (kind === 'data') {
      payload.type = type
      if (type === 'number' || type === 'currency') payload.decimals = decimals
      if (type === 'single_select' || type === 'multi_select') {
        const options = buildOptions()
        if (!options.choices.length) { setError('Ajouter au moins un choix avec un libellé'); return }
        payload.options = options
      }
      if (type === 'currency') payload.options = { currency: currencyCode }
      if (type === 'duration') payload.options = { format: durationFormat }
      if (type === 'date') payload.options = { format: dateFormat }
      if (type === 'phone') payload.options = { country_code: phoneCountryCode }
    } else if (kind === 'formula') {
      const expr = formulaExpr.trim()
      if (!expr) { setError('Expression requise'); return }
      payload.formula_expr = expr
      payload.result_type = resultType
    } else if (kind === 'lookup') {
      if (!lookupFk || !lookupTargetTable || !lookupTargetColumn) {
        setError('Choisir un champ de référence, une table cible et une colonne'); return
      }
      Object.assign(payload, {
        lookup_fk: lookupFk,
        lookup_target_table: lookupTargetTable,
        lookup_target_column: lookupTargetColumn,
        result_type: resultType,
      })
    } else if (kind === 'rollup') {
      if (!rollupTable || !rollupFk) { setError('Choisir une table liée'); return }
      if (rollupAgg !== 'COUNT' && !rollupColumn) { setError('Choisir une colonne à agréger'); return }
      Object.assign(payload, {
        rollup_target_table: rollupTable,
        rollup_target_fk: rollupFk,
        rollup_target_column: rollupAgg === 'COUNT' ? null : rollupColumn,
        rollup_agg: rollupAgg,
        result_type: isArrayAgg(rollupAgg) ? 'text' : resultType,
      })
    } else if (kind === 'button') {
      const lab = buttonLabel.trim()
      if (!lab) { setError('Libellé du bouton requis'); return }
      if (!buttonAutomationId) { setError('Choisir une automation à déclencher'); return }
      payload.options = { label: lab, automation_id: buttonAutomationId, style: buttonStyle }
    }
    setSaving(true)
    try {
      const result = await api.customFields.update(editing.id, payload)
      addToast({ message: 'Champ converti', type: 'success' })
      onSaved?.(result)
      onClose?.()
    } catch (e) {
      setError(e.message || 'Erreur')
    } finally {
      setSaving(false)
    }
  }

  // Type d'affichage d'un champ calculé (formule / lookup / rollup). En édition,
  // le changement se persiste immédiatement (règle « autosave partout ») : avant,
  // il ne partait qu'avec un autre autosave, donc choisir « URL » ou « Date » sur
  // un champ existant semblait ne rien faire. Un rollup ARRAY/ARRAYUNIQUE reste
  // en texte (liste de valeurs) — même règle que maybeAutosaveRollup.
  function changeResultType(v) {
    setResultType(v)
    if (!editing || converting) return
    const rt = kind === 'rollup' && isArrayAgg(rollupAgg) ? 'text' : v
    if (rt === lastSaved.current.result_type) return
    autosave({ result_type: rt })
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
      // En conversion, Enter applique la conversion ; sinon pas de submit
      // global — autosave au blur, Enter sauvegarde le nom.
      if (converting) { handleConvert(); return }
      const v = name.trim()
      if (v && v !== lastSaved.current.name) autosave({ name: v })
      return
    }
    if (!name.trim()) { setError('Nom requis'); return }
    setSaving(true)
    // Description facultative, commune à tous les kinds.
    const descPayload = description.trim() ? { description: description.trim() } : {}
    try {
      let result
      if (kind === 'data') {
        if (type === 'single_select' || type === 'multi_select') {
          const options = buildOptions()
          if (!options.choices.length) { setError('Ajouter au moins un choix avec un libellé'); setSaving(false); return }
          result = await api.customFields.create(erpTable, { name: name.trim(), type, options, ...descPayload })
        } else {
          result = await api.customFields.create(erpTable, {
            name: name.trim(),
            type,
            ...descPayload,
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
          ...descPayload,
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
          ...descPayload,
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
          ...descPayload,
        })
      } else if (kind === 'auto') {
        result = await api.customFields.createAuto(erpTable, {
          name: name.trim(),
          auto_type: autoType,
          ...descPayload,
        })
      } else if (kind === 'button') {
        const lab = buttonLabel.trim()
        if (!lab) { setError('Libellé du bouton requis'); setSaving(false); return }
        if (!buttonAutomationId) { setError('Choisir une automation à déclencher'); setSaving(false); return }
        result = await api.customFields.createButton(erpTable, {
          name: name.trim(),
          options: { label: lab, automation_id: buttonAutomationId, style: buttonStyle },
          ...descPayload,
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

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? fieldModalTitle('Modifier le champ', name || editing.name) : 'Nouveau champ'} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Champ Airtable qui alimente la colonne — même cellule que dans le
            tableau de la page de configuration (mapping posé/retiré tout de suite).
            Un champ calculé n'a rien à importer : pas de bloc du tout. */}
        {editing && mappingSlot}
        {/* Le nom d'abord : c'est ce qu'on vient changer le plus souvent, et
            c'est aussi ce qui identifie le champ qu'on est en train d'éditer. */}
        <div>
          <label className="label">Nom</label>
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
          />
        </div>

        {/* Type du champ — UN SEUL menu. « Formule », « Lookup », « Créé le »…
            se choisissent à côté de « Texte » et « Nombre » : la nature du champ
            et le type de sa valeur ne sont plus deux réglages séparés à l'écran.
            Le format d'affichage d'un champ calculé reste un sous-réglage. */}
        <FieldTypeSelect
          testId="cf-type"
          value={typeOptionId}
          options={typeOptions}
          hint={typeHint}
          onChange={pickFieldType}
          disabled={!!editing && !canConvert}
        >
          {/* Conversion refusée : on dit ce qui serait perdu, et on laisse
              passer outre. Même palette que l'avertissement de sync ci-dessus. */}
          {retypeWarn && (
            <div
              className="mt-2 flex gap-2 items-start rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-800"
              data-testid="cf-retype-warning"
            >
              <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-500" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {retypeWarn.unconvertible} valeur{retypeWarn.unconvertible > 1 ? 's' : ''} sur {retypeWarn.filled} illisible{retypeWarn.unconvertible > 1 ? 's' : ''} en « {FIELD_TYPE_BY_ID.get(retypeWarn.to)?.label || retypeWarn.to} » — elle{retypeWarn.unconvertible > 1 ? 's' : ''} sera{retypeWarn.unconvertible > 1 ? 'ont' : ''} vidée{retypeWarn.unconvertible > 1 ? 's' : ''}.
                </p>
                {retypeWarn.samples?.length > 0 && (
                  <p className="mt-0.5 text-amber-700 break-words">
                    {retypeWarn.samples.map(sp => sp.count > 1 ? `${sp.value} ×${sp.count}` : sp.value).join(' · ')}
                  </p>
                )}
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => retypeTo(retypeWarn.to, { force: true })}
                    disabled={saving}
                    data-testid="cf-retype-force"
                    className="px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                  >
                    {saving ? '…' : 'Convertir quand même'}
                  </button>
                  <button
                    type="button"
                    onClick={cancelRetype}
                    className="px-2 py-0.5 rounded text-amber-800 hover:bg-amber-100"
                  >
                    Annuler
                  </button>
                </div>
              </div>
            </div>
          )}
        </FieldTypeSelect>

        {/* Mode "data" — texte / nombre / devise / URL éditable. Le TYPE se
            choisit dans le menu unique en haut de la modale ; il ne reste ici
            que la configuration propre au type retenu. */}
        {/* Champ lien Airtable : rien à régler ici — sa valeur est l'id du
            record lié, posé par le sync (une « valeur par défaut » n'aurait
            aucun sens). */}
        {kind === 'data' && !atLink && (
          <>
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
                <label className="label">Devise</label>
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
                  searchPlaceholder="Rechercher une devise…"
                  size="sm"
                  className="input text-sm w-full bg-white"
                  testId="cf-currency-code"
                />
              </div>
            )}
            {(type === 'number' || type === 'currency') && (
              <div>
                <label className="label">Décimales (0 à 5)</label>
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
                <label className="label">Format d'affichage</label>
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
                <label className="label">Format d'affichage</label>
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
                <label className="label">Indicatif de pays</label>
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
                <label className="label">Valeur par défaut</label>
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
                pas par ce champ texte. Un Attachement n'a pas de valeur par
                défaut : on ne pré-remplit pas un enregistrement avec un fichier. */}
            {type !== 'single_select' && type !== 'multi_select' && type !== 'checkbox' && type !== 'attachment' && (
              <div>
                <label className="label">Valeur par défaut</label>
                <input
                  type={(type === 'number' || type === 'currency') ? 'number' : (type === 'url' ? 'url' : (type === 'phone' ? 'tel' : 'text'))}
                  value={defaultValue}
                  onChange={e => setDefaultValue(e.target.value)}
                  onBlur={() => {
                    if (!editing) return
                    if (defaultValue !== (lastSaved.current.default_value ?? '')) autosave({ default_value: defaultValue })
                  }}
                  className="input text-sm w-full"
                />
              </div>
            )}
          </>
        )}

        {/* Mode "formula" — expression SQLite avec autocomplete */}
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
              sourceColumns={meta?.source_columns || []}
              functions={meta?.formula_functions || []}
            />
            <ResultTypeSelect value={resultType} onChange={changeResultType} />
          </>
        )}

        {/* Mode "lookup" — JOIN sur table liée */}
        {kind === 'lookup' && (
          <>
            <div>
              <label className="label">Champ de référence</label>
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
              <label className="label">Colonne à récupérer</label>
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
                searchPlaceholder="Rechercher un champ…"
                size="sm"
                className="input text-sm w-full bg-white"
                testId="cf-lookup-target-column"
              />
            </div>
            <ResultTypeSelect value={resultType} onChange={changeResultType} />
          </>
        )}

        {/* Mode "rollup" — agrégat d'une table liée (FK inverse) */}
        {kind === 'rollup' && (
          <>
            <div>
              <label className="label">Agrégation</label>
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
              <label className="label">Table liée</label>
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
                    {uiTableLabel(s.table)} — via {uiFkLabel(s.table, s.fk_column)}{s.inferred ? ' (inféré)' : ''}
                  </option>
                ))}
              </select>
              {meta && (meta.rollup_sources?.length ?? 0) === 0 && (
                <p className="text-[11px] text-amber-600 mt-1">Aucune table ne référence cette table — rollup indisponible.</p>
              )}
            </div>
            {rollupAgg !== 'COUNT' && (
              <div>
                <label className="label">Colonne à agréger</label>
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
                  searchPlaceholder="Rechercher un champ…"
                  size="sm"
                  className="input text-sm w-full bg-white"
                  testId="cf-rollup-column"
                />
              </div>
            )}
            <ResultTypeSelect value={resultType} onChange={changeResultType} />
          </>
        )}

        {/* Mode "auto" — champ système lecture seule. Le sous-type (créé le,
            modifié par…) est une entrée du menu de type : plus de seconde liste
            ici, seule la config éventuelle resterait. */}

        {/* Mode "button" — déclenche une automation (field_rule) sur le record au clic */}
        {kind === 'button' && (
          <>
            <div>
              <label className="label">Libellé du bouton</label>
              <input
                value={buttonLabel}
                data-testid="cf-button-label"
                onChange={e => setButtonLabel(e.target.value)}
                onBlur={() => autosaveButton()}
                className="input text-sm w-full"
              />
              <p className="text-[11px] text-slate-400 mt-1">Texte affiché sur le bouton dans chaque ligne.</p>
            </div>
            <div>
              <label className="label">Automation à déclencher</label>
              <SearchableSelect
                value={buttonAutomationId}
                options={automations}
                getOptionValue={a => a.id}
                getOptionLabel={a => a.name}
                onChange={v => { setButtonAutomationId(v); autosaveButton({ automation_id: v }) }}
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
              <label className="label">Style</label>
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

        {/* Description en dernier : c'est une note d'infobulle, pas un réglage
            du champ — elle passe après le nom, le type et la config. */}
        <FieldDescriptionInput
          value={description}
          onChange={setDescription}
          onBlur={() => {
            if (!editing) return
            const v = description.trim()
            if (v !== (lastSaved.current.description || '')) autosave({ description: v || null })
          }}
          testId="cf-description"
        />

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

        {editing && converting ? (
          // Conversion en cours : action transactionnelle, un seul PUT au clic
          // « Convertir » (exception documentée à la règle autosave — changer la
          // nature d'un champ ne doit pas s'appliquer à moitié).
          <div className="flex items-center justify-between gap-3 pt-2" data-testid="cf-convert-bar">
            <p className="text-xs text-slate-500">
              Les valeurs actuelles sont conservées et récupérables en reconvertissant.
              {editing.source === 'airtable' ? " L'import Airtable de cette colonne sera coupé." : ''}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button type="button" onClick={() => { setKind(editingKind); setError(null) }} className="btn-secondary">Annuler</button>
              <button type="button" onClick={handleConvert} disabled={saving} data-testid="cf-convert-apply" className="btn-primary">
                {saving ? 'Conversion…' : 'Convertir'}
              </button>
            </div>
          </div>
        ) : editing ? (
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

// Un niveau d'indentation dans l'éditeur de formule.
const FORMULA_INDENT = '  '

// Normalise pour la recherche : minuscules, sans accents. Permet de trouver un
// champ par son libellé tel qu'il s'affiche dans l'app (« Numéro de suivi »)
// autant que par son nom technique (`tracking_number`).
const normalizeSearch = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

// Token « en cours de frappe » sous le curseur : lettres accentuées comprises,
// pour qu'un libellé comme « Numéro » déclenche l'autocomplete.
const TOKEN_RE = /[\p{L}\p{N}_]+$/u

// Fin d'un littéral de chaîne SQL ouvert en `start` (guillemet doublé = échappé).
function endOfString(s, start) {
  const q = s[start]
  let j = start + 1
  while (j < s.length) {
    if (s[j] !== q) { j++; continue }
    if (s[j + 1] === q) { j += 2; continue }
    return j + 1
  }
  return s.length
}

// Expression SQL → texte affiché : chaque nom de colonne connu devient
// {Nom du champ}. Les littéraux de chaîne sont recopiés tels quels (un mot
// entre guillemets est un texte, pas un champ), et un identifiant suivi d'une
// parenthèse est un appel de fonction, pas une colonne.
function exprToDisplay(expr, byColumn) {
  let out = ''
  let i = 0
  while (i < expr.length) {
    const ch = expr[i]
    if (ch === "'" || ch === '"') {
      const j = endOfString(expr, i)
      out += expr.slice(i, j)
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j++
      const id = expr.slice(i, j)
      const f = /^\s*\(/.test(expr.slice(j)) ? null : byColumn.get(id)
      out += f ? `{${f.token}}` : id
      i = j
      continue
    }
    out += ch
    i++
  }
  return out
}

// Texte affiché → expression SQL : {Nom du champ} redevient le nom de colonne.
// Symétrique de exprToDisplay — même précédence chaîne/accolade, de sorte
// qu'une apostrophe dans un libellé ({# d'envoi}) n'ouvre pas une chaîne et
// qu'une accolade dans un texte ('{') ne soit pas prise pour un champ.
function displayToExpr(text, byToken) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"') {
      const j = endOfString(text, i)
      out += text.slice(i, j)
      i = j
      continue
    }
    if (ch === '{') {
      const close = text.indexOf('}', i + 1)
      if (close !== -1) {
        const inner = text.slice(i + 1, close)
        const f = byToken.get(normalizeSearch(inner))
        // Jeton inconnu : on garde les accolades telles quelles — la formule
        // sera refusée à l'enregistrement plutôt que de viser une autre colonne.
        out += f ? f.column : `{${inner}}`
        i = close + 1
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

// Éditeur de formule à la Airtable : les champs s'écrivent sous leur nom
// d'interface entre accolades et s'affichent en mauve, l'autocomplete propose
// champs et fonctions. La formule STOCKÉE reste en noms de colonnes SQL (seuls
// compris par la VUE) : la traduction se fait aux frontières de l'éditeur.
function FormulaEditor({ value, onChange, onBlur, sourceColumns, functions = [] }) {
  const taRef = useRef(null)
  const mirrorRef = useRef(null)
  const pendingCaret = useRef(null)
  const [suggest, setSuggest] = useState({ open: false, items: [], active: 0 })
  const [showFns, setShowFns] = useState(false)
  const [showFields, setShowFields] = useState(false)

  // Le serveur envoie [{ column, label }] ; on tolère l'ancien format (string).
  // `token` = ce qui s'affiche entre accolades : le libellé UI, sauf s'il est
  // absent, contient une accolade, ou est déjà pris par un autre champ — le nom
  // technique (unique) sert alors de repli, sinon la relecture serait ambiguë.
  const fields = useMemo(() => {
    const taken = new Set()
    return (sourceColumns || [])
      .map(c => (typeof c === 'string' ? { column: c, label: null } : c))
      .map(f => {
        const wanted = f.label && !/[{}]/.test(f.label) ? f.label : f.column
        const token = taken.has(normalizeSearch(wanted)) ? f.column : wanted
        taken.add(normalizeSearch(token))
        return { ...f, token }
      })
  }, [sourceColumns])
  const byColumn = useMemo(() => new Map(fields.map(f => [f.column, f])), [fields])
  const byToken = useMemo(() => {
    const m = new Map()
    for (const f of fields) m.set(normalizeSearch(f.token), f)
    // Le nom technique reste accepté en saisie ({cf_at_recordid} fonctionne).
    for (const f of fields) if (!m.has(normalizeSearch(f.column))) m.set(normalizeSearch(f.column), f)
    return m
  }, [fields])
  const fieldsKey = useMemo(() => fields.map(f => `${f.column} ${f.token}`).join('|'), [fields])

  // Le textarea travaille sur le texte AFFICHÉ ; le parent, lui, ne voit que
  // l'expression SQL.
  const [text, setText] = useState(() => exprToDisplay(value || '', byColumn))
  const textRef = useRef(text)
  textRef.current = text

  function update(next) {
    setText(next)
    onChange(displayToExpr(next, byToken))
  }

  // Régénère l'affichage quand la formule change hors de l'éditeur (ouverture
  // d'un champ existant) ou quand la liste des champs arrive du serveur après
  // coup — mais jamais pendant la frappe, sinon le curseur sauterait.
  const shownFor = useRef({ value: null, key: null })
  useEffect(() => {
    if (shownFor.current.value === value && shownFor.current.key === fieldsKey) return
    const external = displayToExpr(textRef.current, byToken) !== (value || '')
    const keyChanged = shownFor.current.key !== fieldsKey
    shownFor.current = { value, key: fieldsKey }
    if (external || keyChanged) setText(exprToDisplay(value || '', byColumn))
  }, [value, fieldsKey, byColumn, byToken])

  // Après une insertion programmatique, replacer le curseur au bon endroit.
  // pendingCaret accepte une position simple ou une paire [début, fin].
  useEffect(() => {
    if (pendingCaret.current != null && taRef.current) {
      const p = pendingCaret.current
      pendingCaret.current = null
      taRef.current.focus()
      const [a, b] = Array.isArray(p) ? p : [p, p]
      taRef.current.setSelectionRange(a, b)
    }
  })

  // Le fragment en cours de frappe sous le curseur. Dans une accolade ouverte,
  // il court jusqu'au `{` (espaces compris : « {Numéro de » cherche bien) ;
  // sinon c'est le mot courant.
  function tokenAt(t, caret) {
    const before = t.slice(0, caret)
    const open = before.lastIndexOf('{')
    if (open !== -1) {
      const inside = before.slice(open + 1)
      if (!/[}\n]/.test(inside)) return { start: open, tok: inside, brace: true }
    }
    const m = before.match(TOKEN_RE)
    if (!m) return null
    return { start: caret - m[0].length, tok: m[0], brace: false }
  }

  // Suggestions pour le fragment qui précède le curseur.
  function computeSuggest(t, caret) {
    const at = tokenAt(t, caret)
    if (!at) return []
    const tok = normalizeSearch(at.tok)
    const rank = (keys) => (keys.some(k => k.startsWith(tok)) ? 0 : 1)
    // Un champ se cherche par son nom d'interface OU par son nom technique.
    const fieldItems = fields
      .map(f => ({ f, keys: [normalizeSearch(f.token), normalizeSearch(f.column)] }))
      .filter(({ keys }) => keys.some(k => k.includes(tok)))
      .map(({ f, keys }) => ({ type: 'field', name: f.column, display: f.token, hint: 'Champ', keys }))
    // Dans une accolade, on ne propose que des champs.
    const fns = at.brace ? [] : (functions || [])
      .filter(f => normalizeSearch(f.name).includes(tok))
      .map(f => ({ type: 'function', name: f.name, display: f.name, hint: f.sig, keys: [normalizeSearch(f.name)] }))
    return [...fieldItems, ...fns]
      .sort((a, b) => rank(a.keys) - rank(b.keys))
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
    const at = tokenAt(text, caret) || { start: caret, tok: '', brace: false }
    // Une accolade fermante déjà présente juste après le curseur est absorbée
    // (on vient de la remplacer), sinon on la doublerait.
    const end = at.brace && text[caret] === '}' ? caret + 1 : caret
    const insertText = item.type === 'function' ? `${item.name}()` : `{${item.display}}`
    const caretOffset = item.type === 'function' ? item.name.length + 1 : insertText.length
    update(text.slice(0, at.start) + insertText + text.slice(end))
    pendingCaret.current = at.start + caretOffset
    setSuggest({ open: false, items: [], active: 0 })
  }

  // Insère un texte au curseur (depuis les panneaux champs / fonctions).
  function insertAtCaret(snippet, caretInsideParens = false) {
    const el = taRef.current
    const caret = el ? el.selectionStart : text.length
    update(text.slice(0, caret) + snippet + text.slice(caret))
    pendingCaret.current = caret + (caretInsideParens ? snippet.indexOf('(') + 1 : snippet.length)
  }

  // Retour de ligne : la nouvelle ligne reprend l'indentation de la ligne
  // courante et y ajoute un niveau — les formules sont surtout des appels
  // imbriqués, on descend donc naturellement d'un cran à chaque ligne.
  function insertNewlineIndented() {
    const el = taRef.current
    const start = el ? el.selectionStart : text.length
    const end = el ? el.selectionEnd : text.length
    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    const curIndent = text.slice(lineStart, start).match(/^[ \t]*/)[0]
    const indent = curIndent + FORMULA_INDENT
    update(text.slice(0, start) + '\n' + indent + text.slice(end))
    pendingCaret.current = start + 1 + indent.length
  }

  // Tab / Maj+Tab : indente ou désindente les lignes touchées par la sélection
  // (indispensable puisque chaque retour de ligne ajoute un niveau).
  function shiftIndent(dir) {
    const el = taRef.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    if (dir > 0 && start === end) { insertAtCaret(FORMULA_INDENT); return }
    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    const nextNl = text.indexOf('\n', end)
    const lineEnd = nextNl === -1 ? text.length : nextNl
    let firstDelta = 0
    let totalDelta = 0
    const lines = text.slice(lineStart, lineEnd).split('\n').map((ln, i) => {
      let delta = 0
      let out = ln
      if (dir > 0) {
        out = FORMULA_INDENT + ln
        delta = FORMULA_INDENT.length
      } else {
        const m = ln.match(new RegExp(`^( {1,${FORMULA_INDENT.length}}|\\t)`))
        if (m) { out = ln.slice(m[0].length); delta = -m[0].length }
      }
      if (i === 0) firstDelta = delta
      totalDelta += delta
      return out
    })
    update(text.slice(0, lineStart) + lines.join('\n') + text.slice(lineEnd))
    pendingCaret.current = [Math.max(lineStart, start + firstDelta), Math.max(lineStart, end + totalDelta)]
  }

  function onKeyDown(e) {
    if (!suggest.open || suggest.items.length === 0) {
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        insertNewlineIndented()
      } else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        shiftIndent(e.shiftKey ? -1 : 1)
      }
      return
    }
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

  // Calque de coloration : le textarea est transparent et laisse voir ce miroir,
  // qui peint les {champs} en mauve (en rouge s'ils ne correspondent à aucun
  // champ de la table). Mêmes police, taille et marges que le textarea, sinon
  // le texte peint et le texte saisi se décaleraient.
  const highlighted = useMemo(() => {
    const out = []
    const re = /\{[^{}\n]*\}/g
    let last = 0
    let m
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index))
      const known = byToken.has(normalizeSearch(m[0].slice(1, -1)))
      out.push(<span key={m.index} className={known ? 'text-violet-600' : 'text-rose-500'}>{m[0]}</span>)
      last = m.index + m[0].length
    }
    // Le saut de ligne final garde la dernière ligne vide à la bonne hauteur.
    out.push(`${text.slice(last)}\n`)
    return out
  }, [text, byToken])

  return (
    <div>
      <label className="label">Formule</label>
      <div className="relative">
        <div
          ref={mirrorRef}
          aria-hidden="true"
          className="input text-sm font-mono absolute inset-0 overflow-hidden whitespace-pre-wrap break-words pointer-events-none border-transparent"
        >
          {highlighted}
        </div>
        <textarea
          ref={taRef}
          value={text}
          onChange={e => { update(e.target.value); refreshSuggest() }}
          onClick={refreshSuggest}
          onKeyUp={e => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) refreshSuggest() }}
          onKeyDown={onKeyDown}
          onScroll={e => { if (mirrorRef.current) mirrorRef.current.scrollTop = e.target.scrollTop }}
          onBlur={() => { setTimeout(() => setSuggest({ open: false, items: [], active: 0 }), 120); onBlur?.() }}
          rows={Math.min(14, Math.max(3, text.split('\n').length))}
          className="input text-sm w-full font-mono formula-input relative bg-transparent text-transparent"
          style={{ caretColor: '#0f172a' }}
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
                <span className={`text-[10px] font-semibold px-1 rounded ${it.type === 'field' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}>
                  {it.type === 'field' ? 'ƒ' : 'fn'}
                </span>
                <span className={it.type === 'field' ? 'text-violet-700' : 'font-mono text-slate-700'}>{it.display}</span>
                <span className="text-[11px] text-slate-400 truncate ml-auto">{it.hint}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2 mt-2">
        <button type="button" onClick={() => { setShowFields(v => !v); setShowFns(false) }} className="text-[11px] text-brand-600 hover:underline">
          {showFields ? 'Masquer les champs' : `Champs disponibles${fields.length ? ` (${fields.length})` : ''}`}
        </button>
        <button type="button" onClick={() => { setShowFns(v => !v); setShowFields(false) }} className="text-[11px] text-brand-600 hover:underline">
          {showFns ? 'Masquer les fonctions' : `Fonctions disponibles${functions.length ? ` (${functions.length})` : ''}`}
        </button>
        <span className="text-[11px] text-slate-400 ml-auto">Tape <code className="font-mono">{'{'}</code> ou un nom de champ pour l&apos;autocomplete.</span>
      </div>
      <p className="text-[11px] text-slate-400 mt-1">
        Un champ s&apos;écrit entre accolades, sous le nom qu&apos;il porte dans l&apos;app : <code className="font-mono text-violet-600">{'{Numéro de suivi}'}</code>. Un texte fixe se met entre guillemets : <code className="font-mono text-slate-500">&quot;https://exemple.com/&quot;</code> ou <code className="font-mono text-slate-500">&apos;Gagné&apos;</code>.
      </p>

      {showFields && (
        // Liste complète des champs de la table, sous leur nom d'interface :
        // un champ dont le libellé ne ressemble pas à la colonne (« AT recordId »
        // → cf_at_recordid) resterait sinon introuvable.
        <div className="mt-2 rounded-lg border border-slate-100 bg-slate-50 p-2 max-h-64 overflow-y-auto">
          {fields.length === 0 ? (
            <p className="text-[11px] text-slate-400 px-1 py-2">Aucun champ.</p>
          ) : (
            <div className="grid grid-cols-2 gap-1">
              {[...fields]
                .sort((a, b) => a.token.localeCompare(b.token, 'fr'))
                .map(f => (
                  <button
                    type="button"
                    key={f.column}
                    onMouseDown={e => { e.preventDefault(); insertAtCaret(`{${f.token}}`) }}
                    className="text-left px-2 py-1 rounded hover:bg-white text-[11px] text-violet-700 truncate"
                  >
                    {f.token}
                  </button>
                ))}
            </div>
          )}
        </div>
      )}

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
                        <span className="font-mono text-sky-700">{f.name}</span>
                        <span className="text-slate-400 truncate w-full">{f.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))
          )}
        </div>
      )}

      <p className="text-[11px] text-slate-400 mt-2">
        <kbd className="bg-slate-100 px-1 rounded">Entrée</kbd> passe à la ligne en ajoutant une indentation · <kbd className="bg-slate-100 px-1 rounded">Tab</kbd> / <kbd className="bg-slate-100 px-1 rounded">Maj+Tab</kbd> indente ou désindente · <kbd className="bg-slate-100 px-1 rounded">Maj+Entrée</kbd> passe à la ligne sans indenter.
      </p>
    </div>
  )
}

function ResultTypeSelect({ value, onChange }) {
  // Format d'affichage d'un champ calculé — sous-réglage du type, pas un second
  // « type de champ » : la formule reste une formule, on choisit seulement
  // comment sa valeur se présente.
  const options = [
    { v: 'text',   label: 'Texte' },
    { v: 'number', label: 'Nombre' },
    { v: 'date',   label: 'Date' },
    { v: 'url',    label: 'URL' },
  ]
  return (
    <div>
      <label className="label">Format</label>
      <SearchableSelect
        testId="cf-result-type"
        size="sm"
        className="input text-sm w-full bg-white"
        value={value}
        options={options}
        getOptionValue={o => o.v}
        getOptionKey={o => o.v}
        getOptionLabel={o => o.label}
        renderOption={o => (
          <span className="flex items-center gap-2 min-w-0">
            <FieldTypeIcon type={o.v} className="text-slate-400 flex-shrink-0" />
            <span className="truncate">{o.label}</span>
          </span>
        )}
        onChange={onChange}
        searchPlaceholder="Rechercher…"
      />
    </div>
  )
}

// Éditeur de choix pour les champs single_select / multi_select : libellé +
// couleur par choix, choix par défaut (étoile = single / cases = multi), ajout /
// retrait, et alphabétisation. En mode édition, `onPersist({ ch, di, dis, alpha })`
// autosauvegarde la config.
// `native` : champ NATIF de type Sélection. Les valeurs sont figées (les syncs
// et le code serveur les écrivent et les comparent) — renommer un choix ne
// change que son affichage, et la couleur peut rester « d'origine » (le rendu
// que la page fait déjà). Pas de valeur par défaut ni d'alphabétisation : ces
// réglages appartiennent aux champs perso.
function ChoicesEditor({
  choices, setChoices, isMulti,
  defaultId, setDefaultId, defaultIds, setDefaultIds,
  alphabetize, setAlphabetize, onPersist, native = false,
}) {
  const [openColorIdx, setOpenColorIdx] = useState(null)
  // Réordonnancement par glisser-déposer : index de la ligne saisie et index
  // survolé (trait d'insertion). L'ordre du tableau EST l'ordre d'affichage.
  const [dragIdx, setDragIdx] = useState(null)
  const [overIdx, setOverIdx] = useState(null)
  // L'alphabétisation impose l'ordre côté serveur : glisser n'aurait aucun effet.
  const canReorder = native || !alphabetize

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

  function moveChoice(from, to) {
    if (from == null || to == null || from === to) return
    const next = [...choices]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    applyChoices(next, true)
  }

  function endDrag() { setDragIdx(null); setOverIdx(null) }

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
      <label className="label">Choix</label>
      <div className="space-y-1.5">
        {choices.length === 0 && (
          <p className="text-[11px] text-slate-400">Aucun choix — ajoutez-en au moins un.</p>
        )}
        {choices.map((c, idx) => (
          <div
            key={c.id || c.value || idx}
            data-testid={`cf-choice-row-${idx}`}
            onDragOver={canReorder ? (e => { e.preventDefault(); if (overIdx !== idx) setOverIdx(idx) }) : undefined}
            onDrop={canReorder ? (e => { e.preventDefault(); moveChoice(dragIdx, idx); endDrag() }) : undefined}
            className={`flex items-center gap-1.5 rounded ${dragIdx === idx ? 'opacity-40' : ''} ${overIdx === idx && dragIdx !== null && dragIdx !== idx ? 'ring-1 ring-brand-400' : ''}`}
          >
            {/* Poignée de réordonnancement */}
            <span
              draggable={canReorder}
              onDragStart={canReorder ? (e => { setDragIdx(idx); e.dataTransfer.effectAllowed = 'move' }) : undefined}
              onDragEnd={endDrag}
              title={canReorder ? 'Glisser pour réordonner' : 'Ordre imposé par le tri alphabétique'}
              aria-label="Réordonner le choix"
              data-testid={`cf-choice-grip-${idx}`}
              className={`shrink-0 text-slate-300 ${canReorder ? 'cursor-grab hover:text-slate-500' : 'opacity-30'}`}
            >
              <GripVertical size={14} />
            </span>
            {/* Sélecteur de couleur */}
            <div className="relative">
              <button
                type="button"
                aria-label="Couleur du choix"
                onClick={() => setOpenColorIdx(openColorIdx === idx ? null : idx)}
                title={native && !c.color ? "Couleur d'origine" : undefined}
                className={`h-6 w-6 rounded-full border border-slate-300 ${c.color ? (COLOR_DOT[c.color] || COLOR_DOT.gray) : (native ? 'border-dashed bg-white' : COLOR_DOT.gray)}`}
              />
              {/* Palette. Largeur explicite : un absolu dans un parent
                  `relative` de 24px se réduirait à cette largeur et les
                  pastilles se chevaucheraient (une seule cliquable par rangée). */}
              {openColorIdx === idx && (
                <div className="absolute z-30 mt-1 left-0 w-44 grid grid-cols-6 gap-1 p-2 rounded-lg border border-slate-200 bg-white shadow-lg">
                  {/* Champ natif : revenir à la couleur que la page rend déjà. */}
                  {native && (
                    <button
                      type="button"
                      aria-label="Couleur d'origine"
                      title="Couleur d'origine"
                      data-testid="cf-color-origin"
                      onClick={() => setColor(idx, null)}
                      className={`h-5 w-5 rounded-full border border-dashed border-slate-400 bg-white ${!c.color ? 'ring-2 ring-offset-1 ring-slate-500' : ''}`}
                    />
                  )}
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
            <div className="flex-1 min-w-0">
              <input
                value={c.label}
                data-testid={`cf-choice-label-${idx}`}
                onChange={e => setLabel(idx, e.target.value)}
                onBlur={() => onPersist?.({ ch: choices })}
                className="input text-sm w-full"
              />
              {/* Natif renommé : la valeur stockée en base ne bouge pas — la
                  dire évite de croire que le renommage a touché la donnée. */}
              {native && c.value && c.label !== c.value && (
                <p className="text-[11px] text-slate-400 mt-0.5 truncate">Valeur en base : {c.value}</p>
              )}
            </div>
            {/* Choix par défaut */}
            {!native && (
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
            )}
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
      {!native && (
        <label className="flex items-center gap-2 mt-3 text-xs text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            checked={alphabetize}
            onChange={e => { setAlphabetize(e.target.checked); onPersist?.({ alpha: e.target.checked }) }}
            className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          Trier les choix par ordre alphabétique
        </label>
      )}
      <p className="text-[11px] text-slate-400 mt-1">
        {native
          ? "Renommer un choix ne change que son affichage : la valeur enregistrée reste la même. Retirer un choix le sort des sélecteurs, sans toucher aux lignes qui le portent."
          : (isMulti ? "L'icône ✓ marque les choix inclus par défaut." : "L'étoile marque le choix par défaut.")}
      </p>
    </div>
  )
}

export default CustomFieldModal
