import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useNavigate, useLocation } from 'react-router-dom'
import { ChevronRight, ChevronDown, Trash2, Plus, Edit2, Layers, Filter, ArrowUp, ArrowDown, EyeOff, RotateCcw, Inbox, Sigma, Check, HelpCircle, GripVertical, Copy, ArrowLeftToLine, ArrowRightToLine } from 'lucide-react'
import EmptyState from './EmptyState.jsx'
import { useTableView } from '../lib/useTableView.js'
import { applyFilter, applyFilterGroup, countFilterRules } from '../lib/tableFilters.js'
import { ViewToolbar, ROW_COLOR_STYLES } from './ViewToolbar.jsx'
import { defaultOpForType } from './FilterRow.jsx'
import api from '../lib/api.js'
import { fmtDate } from '../lib/formatDate.js'
import { useRealtimeChannel, diffFields } from '../lib/useRealtimeChannel.js'
import { getRecord } from '../lib/dataStore.js'
import { getUser } from '../lib/auth.jsx'
import { useConfirm } from './ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { CustomFieldModal } from './CustomFieldModal.jsx'
import { useCustomFields } from '../lib/useCustomFields.js'
import { customFieldToColumn, CUSTOM_FIELD_TABLES, isImageUrl, ImageValue } from '../lib/customFieldDisplay.jsx'
import { LINKED_RECORD_TYPE_LABELS } from '../lib/tableDefs.js'
import { summarizeDependents } from '../lib/customFieldDeps.js'
import { useFieldOverrides, applyFieldOverrides, applyFieldOrder } from '../lib/fieldOverrides.jsx'
import RecordPeekDrawer from './RecordPeekDrawer.jsx'
import { ResizeHandle } from './ResizeHandle.jsx'
import { useDecimalPrefs, formatDecimals } from '../lib/decimalPrefs.jsx'
import { parseDurationToSeconds, formatDurationSeconds } from '../lib/duration.js'

// Durée du surlignage « modifié en direct » — doit matcher la keyframe
// dtCellFlash / dtEditorBadge dans index.css.
const FLASH_MS = 3600

export function fmtPhone(val) {
  if (!val) return ''
  const digits = String(val).replace(/\D/g, '')
  const d = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  return val
}

// ── Édition « tableur » (copier/coller, fill-down) ─────────────────────────
// Coercition d'une valeur texte (saisie ou collée) vers le type de la colonne.
// Retourne `null` pour vider, une valeur typée, ou `undefined` si invalide
// (ex. nombre non-parsable) → le changement est alors ignoré silencieusement.
function coerceCellValue(col, str) {
  const s = String(str ?? '').trim()
  const t = col?.type
  if (t === 'number' || t === 'currency') {
    if (s === '') return null
    let cleaned = s.replace(/[\s$]/g, '')
    // « 1 234,56 » (fr-CA) → on traite la virgule comme séparateur décimal
    // quand il n'y a pas de point.
    if (cleaned.includes(',') && !cleaned.includes('.')) cleaned = cleaned.replace(',', '.')
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : undefined
  }
  if (t === 'duration') {
    // Durée stockée en secondes. « 1:30 » → 5400 ; saisie invalide → undefined
    // (rejetée, la cellule garde sa valeur).
    if (s === '') return null
    const sec = parseDurationToSeconds(s)
    return sec == null ? undefined : sec
  }
  if (t === 'boolean') {
    // Checkbox stockée en 0/1. Tolère les formes textuelles courantes au
    // collage / fill-down ; saisie non reconnue → undefined (ignorée).
    if (s === '') return null
    const low = s.toLowerCase()
    if (['1', 'true', 'vrai', 'oui', 'yes', 'x', '✓', '✔', 'coché'].includes(low)) return 1
    if (['0', 'false', 'faux', 'non', 'no'].includes(low)) return 0
    return undefined
  }
  return s === '' ? null : s
}

// Parse un presse-papier TSV (format Excel/Sheets/Airtable) en matrice de
// chaînes : lignes séparées par \n, colonnes par \t.
function parseClipboard(text) {
  const norm = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const body = norm.endsWith('\n') ? norm.slice(0, -1) : norm
  if (body === '') return []
  return body.split('\n').map(line => line.split('\t'))
}

function DynamicCell({ value, col, decimals }) {
  if (value === null || value === undefined || value === '') return <span className="text-slate-300">—</span>
  const type = col.type

  if (type === 'single_select') {
    return <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">{value}</span>
  }
  if (type === 'multi_select') {
    let items = value
    try { items = JSON.parse(value) } catch {}
    if (!Array.isArray(items)) items = [items]
    // Même règle que `renderCustomFieldValue` : hauteur de ligne fixe → pas de
    // retour à la ligne, sinon les pastilles débordent sur les lignes voisines.
    return (
      <div className="flex items-center gap-1 overflow-hidden" title={items.join(', ')}>
        {items.map((v, i) => <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 shrink-0 whitespace-nowrap">{v}</span>)}
      </div>
    )
  }
  if (type === 'checkbox' || type === 'boolean') {
    // Tolère les multiples formes héritées : 1/true (sync récente),
    // '1' (cast SQLite TEXT), '1.0' (ancien parseFloat de la sync legacy).
    const truthy = value === 1 || value === true || value === '1' || value === '1.0' || Number(value) === 1
    return <span>{truthy ? '✓' : '—'}</span>
  }
  if (type === 'date') {
    let formatted
    try { formatted = fmtDate(value) } catch { formatted = null }
    return formatted
      ? <span className="text-slate-500 text-sm">{formatted}</span>
      : <span>{value}</span>
  }
  if (type === 'number') {
    // Décimales : préférence utilisateur (passée par DataTable) sinon col.decimals
    // (custom fields Airtable). Si aucune, rendu brut.
    const d = decimals != null ? decimals : (Number.isInteger(col.decimals) ? col.decimals : null)
    const formatted = formatDecimals(value, d)
    return <span className="tabular-nums">{formatted != null ? formatted : value}</span>
  }
  if (type === 'duration') {
    const n = Number(value)
    if (!Number.isFinite(n)) return <span>{value}</span>
    return <span className="tabular-nums">{formatDurationSeconds(n, col.durationFormat)}</span>
  }
  if (type === 'phone') {
    return <span className="font-mono text-sm">{fmtPhone(value)}</span>
  }
  // Une valeur qui EST une image (URL ou chemin servi par l'app) s'affiche en
  // vignette, jamais en URL brute — même règle que `renderCustomFieldValue`
  // (customFieldDisplay.jsx), pour que ça vaille dans TOUS les tableaux quelle
  // que soit l'origine de la colonne.
  if ((!type || type === 'text' || type === 'long_text' || type === 'url') && isImageUrl(value)) {
    return <ImageValue value={value} />
  }
  // text, long_text, link, etc.
  const str = String(value)
  return <span className="truncate">{str.length > 100 ? str.slice(0, 100) + '…' : str}</span>
}

// Pastilles de couleur pour l'éditeur inline de select (mêmes fonds que Badge).
const SELECT_DOT = {
  gray: 'bg-slate-300', slate: 'bg-slate-400', blue: 'bg-blue-400', indigo: 'bg-brand-400',
  green: 'bg-green-400', yellow: 'bg-yellow-400', orange: 'bg-orange-400', red: 'bg-red-400',
  purple: 'bg-purple-400', pink: 'bg-pink-400', teal: 'bg-teal-400',
}

// Éditeur inline (mode tableur) pour une cellule single_select / multi_select.
// `col.selectChoices` = [{ id, label, color }]. Single : un clic commit le label
// (ou vide). Multi : cases à cocher → commit un tableau JSON au « Terminé » ou au
// clic en dehors.
function SelectCellEditor({ col, value, onCommit, onCancel }) {
  const multi = col.type === 'multi_select'
  const choices = Array.isArray(col.selectChoices) ? col.selectChoices : []
  const initial = useMemo(() => {
    if (!multi) return value == null ? [] : [String(value)]
    if (Array.isArray(value)) return value.map(String)
    if (typeof value === 'string' && value.startsWith('[')) {
      try { const a = JSON.parse(value); return Array.isArray(a) ? a.map(String) : [] } catch { return [] }
    }
    return value ? [String(value)] : []
  }, [value, multi])
  const [sel, setSel] = useState(initial)
  const rootRef = useRef(null)

  useEffect(() => { rootRef.current?.focus() }, [])

  function commitMulti(next) { onCommit(JSON.stringify(next)) }
  function toggle(label) {
    if (multi) {
      setSel(prev => prev.includes(label) ? prev.filter(x => x !== label) : [...prev, label])
    } else {
      onCommit(sel[0] === label ? '' : label)
    }
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="datatable-select-editor"
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        else if (e.key === 'Enter' && multi) { e.preventDefault(); commitMulti(sel) }
      }}
      onBlur={e => {
        // Commit (multi) / annule (single) quand le focus quitte le panneau.
        if (!e.currentTarget.contains(e.relatedTarget)) {
          if (multi) commitMulti(sel); else onCancel()
        }
      }}
      className="absolute z-30 left-0 top-full min-w-[180px] max-h-56 overflow-y-auto rounded-lg border border-brand-500 bg-white shadow-lg py-1"
    >
      {!multi && (
        <button
          type="button"
          onClick={() => onCommit('')}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-50"
        >
          — Aucun —
        </button>
      )}
      {choices.length === 0 && (
        <div className="px-3 py-1.5 text-xs text-slate-400">Aucun choix configuré</div>
      )}
      {choices.map(c => {
        const active = sel.includes(c.label)
        return (
          <button
            type="button"
            key={c.id || c.label}
            data-testid={`datatable-select-opt-${c.label}`}
            onClick={() => toggle(c.label)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50 ${active ? 'bg-brand-50' : ''}`}
          >
            <span className={`h-3 w-3 rounded-full ${SELECT_DOT[c.color] || SELECT_DOT.gray}`} />
            <span className="flex-1 text-left truncate text-slate-700">{c.label}</span>
            {active && <Check size={14} className="text-brand-600" />}
          </button>
        )
      })}
      {multi && (
        <div className="border-t border-slate-100 mt-1 pt-1 px-2">
          <button
            type="button"
            onClick={() => commitMulti(sel)}
            className="w-full text-xs text-brand-600 hover:text-brand-700 py-1"
          >
            Terminé
          </button>
        </div>
      )}
    </div>
  )
}

// Rendu d'une cellule. Priorité au render() custom de la colonne. Sinon, pour
// les colonnes dynamiques (Airtable) on délègue à DynamicCell, et pour les
// colonnes standard type:'number' on applique le formatage décimal préféré de
// l'utilisateur (`decimals`). Toute autre colonne : valeur brute.
function renderCell(col, item, decimals) {
  if (col.render) return col.render(item)
  const value = item[col.field]
  // Colonne date sans render() de page : formatage unifié via DynamicCell
  // (YYYY-MM-DD, cf. fmtDate) plutôt que l'ISO brut « 2025-11-14T00:00:00.000Z ».
  // Sans ça, toute colonne type:'date' dont la page n'a pas câblé de render
  // (ex. « Créé le » / « Modifié le » du Pipeline) affichait le timestamp brut.
  if (col.dynamic || col.type === 'date') return <DynamicCell value={value} col={col} decimals={decimals} />
  if (col.type === 'number' && decimals != null) {
    const formatted = formatDecimals(value, decimals)
    if (formatted != null) return <span className="tabular-nums">{formatted}</span>
  }
  return value ?? '—'
}

// ── Barre de totaux en pied (summary bar à la Airtable) ────────────────────
// Agrégations disponibles par colonne. `numeric` = nécessite des valeurs
// numériques (sum/avg/min/max) ; les autres (count/empty) marchent partout.
const AGG_LABELS = {
  sum: 'Somme',
  avg: 'Moyenne',
  min: 'Min',
  max: 'Max',
  count: 'Rempli',
  empty: 'Vides',
}
const NUMERIC_AGGS = ['sum', 'avg', 'min', 'max', 'count', 'empty']
const TEXT_AGGS = ['count', 'empty']

function isNumericCol(col) {
  return col?.type === 'number' || col?.type === 'currency'
}

// Agrégations proposées dans le menu pour une colonne donnée.
function aggOptionsFor(col) {
  return isNumericCol(col) ? NUMERIC_AGGS : TEXT_AGGS
}

// Calcule la valeur d'agrégation d'une colonne sur les lignes filtrées.
// Retourne { label, value, isCount } ou null si type === 'none'.
function computeAggregation(type, rows, field) {
  if (!type || type === 'none') return null
  if (type === 'count' || type === 'empty') {
    let n = 0
    for (const r of rows) {
      const v = r[field]
      const blank = v === null || v === undefined || v === ''
      if (type === 'count' ? !blank : blank) n++
    }
    return { label: AGG_LABELS[type], value: n, isCount: true }
  }
  let sum = 0, count = 0, min = Infinity, max = -Infinity
  for (const r of rows) {
    const v = parseFloat(r[field])
    if (Number.isNaN(v)) continue
    sum += v; count++
    if (v < min) min = v
    if (v > max) max = v
  }
  if (count === 0) return { label: AGG_LABELS[type], value: null, isCount: false }
  let value
  if (type === 'sum') value = sum
  else if (type === 'avg') value = sum / count
  else if (type === 'min') value = min
  else if (type === 'max') value = max
  return { label: AGG_LABELS[type], value, isCount: false }
}

// Formate une valeur d'agrégation. Les counts restent entiers ; les valeurs
// numériques suivent les décimales préférées de l'utilisateur (sinon max 2).
function formatAggValue(agg, decimals) {
  if (!agg) return ''
  if (agg.value == null) return '—'
  if (agg.isCount) return agg.value.toLocaleString('fr-CA')
  if (decimals != null) {
    const f = formatDecimals(agg.value, decimals)
    if (f != null) return f
  }
  return agg.value.toLocaleString('fr-CA', { maximumFractionDigits: 2 })
}

// Normalise groupBy en tableau de field names. Accepte legacy string / null
// / array. Filtre les valeurs vides pour éviter les niveaux fantômes.
function normalizeGroupBy(g) {
  if (g == null) return []
  if (Array.isArray(g)) return g.filter(Boolean)
  return g ? [g] : []
}

// Petit « ? » survolable dans l'en-tête de colonne. Affiche la `description`
// (provenance/unité/calcul) en infobulle. Positionnée en `fixed` à partir du
// getBoundingClientRect de l'icône pour ne pas être clippée par l'en-tête
// sticky/overflow. Esprit Airtable : discret au repos, contrasté au survol.
function ColumnHelp({ description }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null) // { x, y } ou null = caché

  function show() {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ x: r.left + r.width / 2, y: r.bottom + 6 })
  }
  function hide() { setPos(null) }

  return (
    <span
      ref={ref}
      // Empêche le drag de colonne / le tri quand on interagit avec l'icône.
      draggable={false}
      onDragStart={e => { e.preventDefault(); e.stopPropagation() }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={e => e.stopPropagation()}
      onContextMenu={e => e.stopPropagation()}
      tabIndex={0}
      aria-label={description}
      data-testid="datatable-col-help"
      className="inline-flex items-center align-middle text-slate-300 hover:text-brand-500 focus:text-brand-500 focus:outline-none cursor-help transition-colors"
    >
      <HelpCircle size={12} strokeWidth={2.25} />
      {pos && (
        <div
          role="tooltip"
          className="fixed z-50 max-w-xs px-2.5 py-1.5 rounded-md bg-slate-800 text-white text-[11px] font-normal normal-case tracking-normal leading-snug shadow-lg pointer-events-none"
          style={{ top: pos.y, left: pos.x, transform: 'translateX(-50%)' }}
        >
          {description}
        </div>
      )}
    </span>
  )
}

export function DataTable({
  table,
  columns,
  data,
  loading,
  onRowClick,
  searchFields = [],
  height = 'calc(100vh - 260px)',
  initialGroupBy = null,
  initialGroupOrder = null, // 'asc' | 'desc' | 'default' | array (aligné sur initialGroupBy)
  forceAllView = false,
  onBulkDelete,
  bulkActions = [],         // actions groupées custom : [{ key, label, icon, className, busyLabel, show?(rows), onClick(ids) }]
  bulkDeleteAlways = false, // affiche les cases de sélection sans dépendre du toggle admin de config
  manageViews = false,      // affiche le crayon « Gérer les vues » (admin) en bout de barre des vues
  disabledColumns = null, // Map<column_name, { airtable_field_name }> | null
  onAddCustomField,       // () => void — affiche le bouton "+" en bout de header
  customFieldsByColumn,   // Map<column_name, { id, name, type, decimals }> — pour right-click menu
  customFieldsLoaded,     // bool — les champs custom fournis ont-ils fini de charger ? (voir cfLoaded / auto-affichage). À fournir dès que customFieldsByColumn l'est.
  onEditCustomField,      // (field) => void
  onDeleteCustomField,    // (field) => void
  onFilteredDataChange,   // (rows) => void — notifie le parent à chaque update de la vue filtrée
  realtimeEntity,         // string | undefined — préfixe du canal WS (`${realtimeEntity}:list`). Active l'indicateur live « modifié par X » (halo vert + badge) quand un AUTRE utilisateur édite une ligne affichée.
  emptyState,             // { icon, title, description, cta } | undefined — état vide contextuel quand la table n'a aucun enregistrement (voir EmptyState.jsx). L'état « filtré, aucun résultat » est géré automatiquement.
  renderExpanded,         // (item) => JSX | null — si fourni, chaque ligne devient expandable : une colonne chevron est ajoutée en tête et le contenu retourné s'affiche sous la ligne dépliée (hauteur mesurée dynamiquement).
  rowKey = 'id',          // champ servant d'identifiant unique de ligne pour le suivi d'expansion (ex. 'employee_id' quand les lignes n'ont pas d'`id`).
  onToggleExpand,         // (item, willExpand) => void — notifié à chaque (dé)pliage, utile pour charger les détails à la demande.
  onCellEdit,             // (row, col, value) => void|Promise — si fourni, active le mode « tableur » : navigation cellule, sélection multi-cellules, copier/coller (Ctrl+C/V), remplissage vers le bas (Ctrl+D) et édition inline. Les colonnes éditables doivent porter `editable: true`. La navigation de ligne (`onRowClick`) passe alors au double-clic.
  peek,                   // { title, subtitle?, to?, width?, render } — si fourni, un clic sur une ligne ouvre un drawer latéral (side-peek à la Airtable) au lieu de naviguer. Chaque champ est soit une valeur, soit une fonction (item) => valeur ; `render(item, { close })` retourne le corps du drawer (typiquement une page *Detail.jsx en mode `embedded`). `to(item)` active le bouton « ouvrir en grand ». Prend le pas sur `onRowClick` pour le clic simple.
  onRowReorder,           // (orderedIds) => void — active une poignée de drag & drop en tête de chaque ligne pour réordonner manuellement (ordre custom persisté par le parent, ex. sort_order). Actif seulement quand l'ordre affiché == l'ordre réel des données : sans tri, groupage, recherche ni filtre.
  rowClassName,           // (item) => string — classes CSS additionnelles par ligne (ex. font-semibold pour un reçu non lu).
  onFieldsChanged,        // () => void — les pages qui gèrent elles-mêmes leurs champs (Pipeline, Factures) passent leur reload : le menu d'en-tête (duplication, masquage global) doit pouvoir rafraîchir leur liste.
}) {
  const [visibleCols, setVisibleCols] = useState([])
  // groupBy : tableau de field names. Hérité du legacy : accepte aussi null /
  // string (single-level) et normalise vers array. Tableau vide = pas de
  // groupage. Plusieurs niveaux = groupage imbriqué.
  const [groupBy, setGroupByRaw] = useState(() => normalizeGroupBy(initialGroupBy))
  // groupOrder : tableau de ('asc' | 'desc' | 'default' | null) par niveau.
  // Aligné sur groupBy. Niveau manquant = 'default'.
  const [groupOrder, setGroupOrderRaw] = useState(() => {
    if (initialGroupOrder == null) return []
    return Array.isArray(initialGroupOrder) ? initialGroupOrder : [initialGroupOrder]
  })
  const [collapsedGroups, setCollapsedGroups] = useState(new Set())
  // Formatage conditionnel par vue : [{ id, color, filters }] — première règle
  // qui matche colore la ligne. Chargé depuis la pill active, persisté par
  // l'autosave de ViewToolbar (color_rules).
  const [colorRules, setColorRules] = useState([])
  const [colWidths, setColWidths] = useState({})
  // Barre de totaux en pied : { [colId]: 'sum'|'avg'|'count'|'empty'|'min'|'max' }
  const [footerAggs, setFooterAggs] = useState({})
  const [footerMenu, setFooterMenu] = useState(null) // { col, x, y } pour le picker d'agrégation
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [deleting, setDeleting] = useState(false)
  const [busyAction, setBusyAction] = useState(null) // key de l'action groupée custom en cours
  const [colMenu, setColMenu] = useState(null) // { x, y, source: 'native'|'airtable', field } pour right-click menu
  const [expandedKeys, setExpandedKeys] = useState(() => new Set()) // rowKey des lignes dépliées (si renderExpanded)
  const expandable = typeof renderExpanded === 'function'
  const [peekItem, setPeekItem] = useState(null) // ligne ouverte dans le side-peek (si `peek` fourni)
  const peekEnabled = peek && typeof peek.render === 'function'
  // Ouverture programmée du side-peek : `peek.openId` demande l'ouverture du
  // drawer sur la ligne correspondante dès qu'elle apparaît dans `data` (ex.:
  // bouton « revenir au panneau latéral » d'une fiche plein écran, qui navigue
  // vers la liste avec l'id en state). `peek.onOpenConsumed` est appelé une
  // fois la demande honorée pour que le parent l'efface (sinon rouvrirait).
  const peekOpenId = peekEnabled ? peek.openId : undefined
  const peekOnOpenConsumed = peekEnabled ? peek.onOpenConsumed : undefined
  useEffect(() => {
    if (peekOpenId == null) return
    const item = (data || []).find(d => String(d?.[rowKey]) === String(peekOpenId))
    if (!item) return
    setPeekItem(item)
    peekOnOpenConsumed?.()
  }, [peekOpenId, data, rowKey, peekOnOpenConsumed])
  // Résout un champ de config `peek` qui peut être une valeur littérale ou une
  // fonction (item) => valeur.
  const resolvePeek = useCallback((key, item) => {
    if (!peek || item == null) return undefined
    const v = peek[key]
    return typeof v === 'function' ? v(item) : v
  }, [peek])

  // ── Mode « tableur » : sélection de cellules, copier/coller, fill-down ────
  // Activé uniquement quand le parent fournit `onCellEdit`. Voir le bloc
  // d'opérations plus bas (géométrie de sélection, clavier, édition inline).
  const gridMode = typeof onCellEdit === 'function'
  const [sel, setSel] = useState(null) // { anchor:{rowId,colId}, focus:{rowId,colId} } | null
  const [editingCell, setEditingCell] = useState(null) // { rowId, colId } | null
  const [editValue, setEditValue] = useState('')
  const [gridSaving, setGridSaving] = useState(false)
  const internalClipRef = useRef('') // fallback presse-papier intra-app (si readText refusé)
  const keyHandlerRef = useRef(null)
  const isColEditable = useCallback((col) => gridMode && !!col?.editable, [gridMode])
  // Tracks previously seen custom-field column ids so we can auto-show newly
  // created fields in the active view (the user vient de créer le champ, on
  // suppose qu'ils veulent le voir tout de suite).
  const prevCustomFieldKeys = useRef(null)
  const confirm = useConfirm()
  const { addToast } = useToast()
  const { getDecimals } = useDecimalPrefs()
  const navigate = useNavigate()
  const routeLocation = useLocation()

  // ── Champs custom auto-gérés ──────────────────────────────────────────────
  // Quand la table supporte les champs custom (miroir client de ALLOWED_TABLES
  // serveur) et que la page n'a pas branché son propre câblage
  // (onAddCustomField), DataTable devient autonome : bouton « + » en bout
  // d'en-tête, CustomFieldModal interne, colonnes custom fusionnées et menu
  // contextuel Modifier / Supprimer. Les pages déjà câblées (Factures,
  // Pipeline) gardent leur comportement — leurs props ont priorité.
  const selfManagedCF = !onAddCustomField && CUSTOM_FIELD_TABLES.has(table)
  const { fields: ownCustomFields, loaded: ownCfLoaded, reload: reloadOwnCustomFields } = useCustomFields(selfManagedCF ? table : null)
  const [ownCfModal, setOwnCfModal] = useState(null) // { editing: field|null }
  const columnsWithOwnCf = useMemo(() => {
    if (!selfManagedCF || ownCustomFields.length === 0) return columns
    // Une colonne fournie par la page (via `columns`) portant le même id/field
    // qu'un champ custom auto-géré REMPLACE ce dernier : la page peut ainsi
    // donner un render sur-mesure à un champ custom (ex. le champ Airtable
    // « # de série » d'order_items, rendu en liens vers les fiches série plutôt
    // qu'en recordID bruts). Sans cet override, on aurait une colonne dupliquée.
    const pageColIds = new Set(columns.map(c => c.id ?? c.field))
    // editable: false — l'édition inline exige un onCellEdit page + une route
    // PATCH qui whiteliste les colonnes cf_ (branché seulement sur projects).
    const autoCfCols = ownCustomFields
      .filter(f => !pageColIds.has(f.column_name))
      .map(f => ({ ...customFieldToColumn(f), editable: false }))
    return [...columns, ...autoCfCols]
  }, [selfManagedCF, columns, ownCustomFields])
  const ownCfByColumn = useMemo(() => {
    if (!selfManagedCF) return null
    const m = new Map()
    for (const f of ownCustomFields) m.set(f.column_name, f)
    return m
  }, [selfManagedCF, ownCustomFields])
  // Versions effectives (prop page > interne auto-géré) utilisées partout plus bas.
  const cfByColumn = customFieldsByColumn || ownCfByColumn
  // Les champs custom ont-ils fini de charger ? Load-bearing pour l'auto-affichage
  // ci-dessous : quand la page fournit customFieldsByColumn (Map dérivée d'un
  // useCustomFields asynchrone), elle doit AUSSI fournir customFieldsLoaded, sinon
  // la Map vide initiale serait prise pour la baseline et ré-afficherait tous les
  // champs masqués au (re)chargement. Chemin auto-géré : on connaît le flag en interne.
  const cfLoaded = customFieldsByColumn
    ? customFieldsLoaded === true
    : (selfManagedCF ? ownCfLoaded : true)
  // useMemo : identité stable exigée par le memo de gridTemplate plus bas.
  const addCustomField = useMemo(
    () => onAddCustomField || (selfManagedCF ? () => setOwnCfModal({ editing: null }) : null),
    [onAddCustomField, selfManagedCF]
  )
  const editCustomField = onEditCustomField || (selfManagedCF ? (f) => setOwnCfModal({ editing: f }) : null)
  const deleteCustomField = onDeleteCustomField || (!selfManagedCF ? null : async (field) => {
    // Rapport d'usage : liste les dépendances (champs calculés, automations,
    // vues, règles de visibilité) que la suppression va affecter, avant de les
    // casser en silence (#ERROR). Même logique que Factures/Pipeline.
    //
    // Pas de confirmation quand le champ n'est utilisé nulle part : la
    // suppression est réversible (soft delete + corbeille) et l'app ne
    // re-confirme pas le réversible — on la remplace par « Annuler » pendant
    // 10 s. La boîte de dialogue ne réapparaît que s'il y a des dépendances :
    // casser une formule ou une automation, ça, ça ne s'annule pas d'un clic
    // dans la tête de l'utilisateur.
    let dependents = []
    try { dependents = (await api.customFields.dependents(field.id))?.dependents || [] } catch {}
    if (dependents.length) {
      const depMsg = summarizeDependents(dependents)
      if (!(await confirm({
        title: 'Supprimer le champ',
        message: `Supprimer le champ "${field.name}" ? Restaurable depuis la corbeille.${depMsg}`,
        confirmLabel: 'Supprimer quand même',
      }))) return
    }
    try {
      await api.customFields.delete(field.id)
      await refreshFields()
      addToast({
        type: 'undo',
        message: `Champ « ${field.name} » supprimé`,
        duration: 10000,
        action: {
          label: 'Annuler',
          onClick: async () => {
            try {
              await api.admin.restoreTrash('custom_fields', field.id)
              await refreshFields()
              addToast({ message: 'Champ restauré', type: 'success', duration: 2000 })
            } catch (e) {
              addToast({ message: 'Restauration échouée : ' + (e.message || 'erreur'), type: 'error' })
            }
          },
        },
      })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  })

  // ── Actions du menu d'en-tête communes à TOUS les champs ─────────────────
  // Un champ natif et un champ perso s'y comportent pareil ; seule la mécanique
  // diffère (masquage global d'un côté, soft delete de l'autre).
  // useFieldOverrides est instancié plus bas dans le composant ; la ref permet
  // aux actions définies ici de déclencher son rechargement sans réordonner le
  // fichier.
  const reloadFieldOverridesRef = useRef(null)
  const refreshFields = useCallback(async () => {
    await Promise.all([
      reloadOwnCustomFields?.(),
      reloadFieldOverridesRef.current?.(),
      onFieldsChanged?.(),
    ].filter(Boolean).map(p => Promise.resolve(p)))
  }, [reloadOwnCustomFields, onFieldsChanged])

  // Supprimer un champ NATIF = le masquer partout, réversible. Sa colonne SQL
  // est lue par des routes serveur, des syncs et les fiches détail : la
  // détruire casserait l'app. L'utilisateur, lui, voit bien le champ disparaître.
  const hideNativeField = useCallback(async (col) => {
    try {
      await api.customFields.setNativeHidden(table, col.id, true)
      await refreshFields()
      addToast({
        type: 'undo',
        message: `Champ « ${col.label} » supprimé`,
        duration: 10000,
        action: {
          label: 'Annuler',
          onClick: async () => {
            try {
              await api.customFields.setNativeHidden(table, col.id, false)
              await refreshFields()
              addToast({ message: 'Champ restauré', type: 'success', duration: 2000 })
            } catch (e) {
              addToast({ message: 'Restauration échouée : ' + (e.message || 'erreur'), type: 'error' })
            }
          },
        },
      })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }, [table, refreshFields, addToast])

  // Armé quand une création de champ part de CE tableau (bouton « + », insertion
  // depuis le menu d'un champ, duplication). Consommé par l'effet d'affichage
  // ci-dessous : sans lui, aucune colonne ne s'ajoute d'elle-même à la vue.
  const creationIntent = useRef(false)
  const pendingInsert = useRef(null)
  const duplicateField = useCallback(async (col) => {
    try {
      // La copie se pose juste à droite de l'original, comme dans Airtable. Le
      // placement passe par la même ancre que « Insérer à droite » : c'est
      // l'effet d'auto-affichage qui positionne la colonne, sinon il la
      // remettrait en bout de tableau juste après.
      creationIntent.current = true
      pendingInsert.current = { anchorId: col.id, side: 'after' }
      const created = await api.customFields.duplicate(table, { field_id: col.field ?? col.id, label: col.label })
      await refreshFields()
      addToast({ message: `Champ « ${created.name} » créé`, type: 'success', duration: 3000 })
    } catch (e) {
      creationIntent.current = false
      pendingInsert.current = null
      addToast({ message: e.message, type: 'error' })
    }
  }, [table, refreshFields, addToast])

  // Insérer à gauche / à droite : la position est une propriété de la VUE, donc
  // on mémorise l'ancre et le côté ; le champ créé s'y glisse (voir l'effet
  // d'auto-affichage, qui autrement l'ajouterait en fin de liste).
  // Renommage EN LIGNE dans l'en-tête (double-clic), façon Airtable : pas de
  // modale pour l'acte le plus fréquent. Autosave au blur / Entrée, Échap annule.
  const [renamingCol, setRenamingCol] = useState(null) // { id, value } | null
  const commitRename = useCallback(async (col, value) => {
    const next = String(value || '').trim()
    setRenamingCol(null)
    if (!next || next === col.label) return
    const field = cfByColumn?.get(col.field) || cfByColumn?.get(col.id)
    try {
      if (field) await api.customFields.update(field.id, { name: next })
      else await api.fieldOverrides.save(table, col.id, { label: next })
      await refreshFields()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }, [cfByColumn, table, refreshFields, addToast])

  const insertFieldAt = useCallback((col, side) => {
    creationIntent.current = true
    pendingInsert.current = { anchorId: col.id, side }
    addCustomField?.()
  }, [addCustomField])

  // ── Overrides de champs natifs (renommage / changement de type) ──────────
  // Les colonnes définies en dur dans tableDefs.js deviennent éditables via le
  // menu contextuel d'en-tête (« Modifier le champ ») → CustomFieldModal (mode natif).
  // L'override (persisté serveur, table field_overrides) remplace le label
  // et/ou le type d'affichage/tri/filtre — les colonnes SQL et syncs ne
  // bougent pas. Appliqué AVANT useTableView pour que les panneaux Champs /
  // Filtres / Grouper voient les libellés et types overridés.
  const { overrides: fieldOverrides, reload: reloadFieldOverrides } = useFieldOverrides(table)
  reloadFieldOverridesRef.current = reloadFieldOverrides
  const [fieldOverrideModal, setFieldOverrideModal] = useState(null) // { col } | null — col = définition d'origine
  const columnsWithOverrides = useMemo(
    () => applyFieldOverrides(columnsWithOwnCf, fieldOverrides),
    [columnsWithOwnCf, fieldOverrides]
  )

  const view = useTableView({ table, columns: columnsWithOverrides, data, searchFields, forceAllView })
  const { filteredData, configReady, allColumns, bulkDeleteEnabled, search, setSearch, filters, setFilters } = view

  useEffect(() => {
    if (typeof onFilteredDataChange === 'function') onFilteredDataChange(filteredData)
  }, [filteredData, onFilteredDataChange])
  const hasBulkActions = Array.isArray(bulkActions) && bulkActions.length > 0
  const selectionActive = (bulkDeleteEnabled || bulkDeleteAlways) && (typeof onBulkDelete === 'function' || hasBulkActions)
  // Use allColumns (hardcoded + dynamic Airtable fields) everywhere.
  // applyFieldOrder : ordre d'affichage choisi par l'utilisateur dans la modale
  // de configuration des champs (field_overrides.sort_order) — pilote le panneau
  // « Champs » et la position par défaut des colonnes.
  // Champs masqués globalement (« Supprimer » sur un champ natif) : ils sortent
  // de TOUTES les colonnes — tableau, panneau Champs, filtres, tris, groupes —
  // sans que leur colonne SQL ni leurs données ne soient touchées. À ne pas
  // confondre avec la visibilité par vue (visibleCols), qui est un choix local.
  const mergedColumns = useMemo(
    () => applyFieldOrder(allColumns || columnsWithOverrides, fieldOverrides)
      .filter(c => !fieldOverrides.get(c.id)?.hidden),
    [allColumns, columnsWithOverrides, fieldOverrides]
  )
  // Helper passé aux consumers pour savoir si une colonne est désactivée
  // (import Airtable coupé via la modale de sync). Comparaison sur field OU id.
  const isDisabled = useCallback((c) => {
    if (!disabledColumns || disabledColumns.size === 0 || !c) return false
    return disabledColumns.has(c.field) || disabledColumns.has(c.id)
  }, [disabledColumns])

  // Page pleine page « Configuration des champs » (/champs/:table). On passe en
  // state de navigation les définitions D'ORIGINE des colonnes affichées
  // (sérialisables : pas de render()), dans l'ordre courant — la page applique
  // ensuite overrides et ordre elle-même, comme le fait la DataTable.
  const openFieldConfig = useCallback(() => {
    const columnsMeta = mergedColumns
      .filter(c => !c.alwaysVisible)
      .map(c => {
        const orig = columnsWithOwnCf.find(x => x.id === c.id)
          || (view.dynamicFields || []).find(d => d.id === c.id)
          || c
        // renderTypeLabel : nom du type d'origine quand la colonne porte un
        // rendu sur-mesure nommé (lien vers une fiche). Calculé ici parce que la
        // page de configuration ne reçoit pas les fonctions render() — le state
        // de navigation doit rester sérialisable.
        return {
          id: c.id, field: c.field, label: orig.label, type: orig.type ?? null,
          ...(orig.render && LINKED_RECORD_TYPE_LABELS[c.id]
            ? { renderTypeLabel: LINKED_RECORD_TYPE_LABELS[c.id] }
            : {}),
        }
      })
    navigate(`/champs/${table}`, {
      state: { columns: columnsMeta, fromPath: routeLocation.pathname + routeLocation.search },
    })
  }, [mergedColumns, columnsWithOwnCf, view.dynamicFields, navigate, table, routeLocation])

  const parentRef = useRef(null)
  const saveWidthsTimer = useRef(null)
  const saveFooterTimer = useRef(null)

  // ── Indicateur live « modifié par un autre utilisateur » ────────────────
  // Quand `realtimeEntity` est fourni, on s'abonne au canal `${entity}:list`.
  // À chaque event `updated` venant d'un AUTRE utilisateur, on diffe le payload
  // contre la ligne actuellement affichée pour repérer les champs changés, on
  // résout l'auteur (actorUserId → users), et on déclenche un halo vert + un
  // badge éditeur sur la ligne, qui s'estompe après FLASH_MS.
  // flashes : Map<rowId, { fields:Set<field>, values:Record<field,val>, actorName, ts }>
  const [flashes, setFlashes] = useState(() => new Map())
  const rowsByIdRef = useRef(new Map())
  const flashTimers = useRef(new Map())
  const currentUserId = useMemo(() => getUser()?.id ?? null, [])

  // Garde une vue id→ligne du `data` courant, lue dans le handler WS (qui n'est
  // pas dans le render path) pour differ le payload contre l'état affiché.
  useEffect(() => {
    const m = new Map()
    for (const r of (data || [])) if (r && r.id != null) m.set(r.id, r)
    rowsByIdRef.current = m
  }, [data])

  useEffect(() => () => {
    for (const t of flashTimers.current.values()) clearTimeout(t)
    flashTimers.current.clear()
  }, [])

  useRealtimeChannel(realtimeEntity ? `${realtimeEntity}:list` : null, (msg) => {
    const verb = msg.type?.split(':').slice(1).join(':')
    if (verb !== 'updated') return
    // Seules les modifs d'AUTRES utilisateurs sont signalées.
    if (msg.actorUserId && currentUserId && String(msg.actorUserId) === String(currentUserId)) return
    const payload = msg.payload
    if (!payload || payload.id == null) return
    const prevRow = rowsByIdRef.current.get(payload.id)
    if (!prevRow) return // ligne pas dans cette vue → rien à surligner
    const changed = diffFields(prevRow, payload)
    if (changed.length === 0) return

    const values = {}
    for (const f of changed) values[f] = payload[f]
    const actorName = (msg.actorUserId && getRecord('users', msg.actorUserId)?.name) || 'Quelqu’un'
    const ts = msg.ts || Date.now()

    setFlashes(prev => {
      const next = new Map(prev)
      next.set(payload.id, { fields: new Set(changed), values, actorName, ts })
      return next
    })

    const existing = flashTimers.current.get(payload.id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      flashTimers.current.delete(payload.id)
      setFlashes(prev => {
        const cur = prev.get(payload.id)
        if (!cur || cur.ts !== ts) return prev // un flash plus récent a pris la place
        const next = new Map(prev)
        next.delete(payload.id)
        return next
      })
    }, FLASH_MS)
    flashTimers.current.set(payload.id, timer)
  })

  // Charge les largeurs persistées. Désormais par vue : on ré-applique à chaque
  // changement de vue active (et plus seulement à l'init) pour que chaque vue
  // garde sa propre mise en page. Reset à {} quand la vue n'a pas de largeurs
  // (view.columnWidths inclut déjà le fallback legacy table-level).
  useEffect(() => {
    if (!view.configReady) return
    setColWidths(view.columnWidths || {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.configReady, view.activeViewId])

  function handleColResize(colId, width) {
    setColWidths(prev => {
      const next = { ...prev, [colId]: width }
      clearTimeout(saveWidthsTimer.current)
      // Persiste sur la vue active (pill) ; fallback table-level uniquement quand
      // aucune vue n'est sélectionnée (vue « Tous »/forceAllView).
      const viewId = view.activeViewId
      saveWidthsTimer.current = setTimeout(() => {
        if (viewId) {
          api.views.savePillColumnWidths(table, viewId, next).catch(() => {})
          view.patchLocalView?.(viewId, { column_widths: next })
        } else {
          api.views.saveColumnWidths(table, next).catch(() => {})
        }
      }, 500)
      return next
    })
  }

  // Charge la config de la barre de totaux persistée (par table).
  useEffect(() => {
    if (!view.configReady) return
    if (view.footerAggregations && Object.keys(view.footerAggregations).length > 0) {
      setFooterAggs(view.footerAggregations)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.configReady])

  // Définit (ou retire avec type 'none') l'agrégation d'une colonne et persiste.
  function setColAggregation(colId, type) {
    setFooterAggs(prev => {
      const next = { ...prev }
      if (!type || type === 'none') delete next[colId]
      else next[colId] = type
      clearTimeout(saveFooterTimer.current)
      saveFooterTimer.current = setTimeout(() => {
        api.views.saveFooterAggregations(table, next).catch(() => {})
      }, 400)
      return next
    })
  }

  // Wrappers : autorisent l'appelant à passer string|array|null (ergonomie
  // legacy), normalisent vers array en interne.
  const setGroupBy = useCallback(v => setGroupByRaw(normalizeGroupBy(v)), [])
  const setGroupOrder = useCallback(v => {
    if (v == null) setGroupOrderRaw([])
    else if (Array.isArray(v)) setGroupOrderRaw(v)
    else setGroupOrderRaw([v])
  }, [])

  // Colonnes `alwaysVisible: true` (colonnes d'ACTION, pas de données) : elles
  // sont réinjectées dans toute liste de colonnes restaurée. Sans ça, une liste
  // mémorisée AVANT l'ajout de la colonne (localStorage `erp_allView_cols_*`,
  // pill, ou config admin) la masque définitivement pour cet utilisateur —
  // le bouton n'apparaît jamais alors qu'il est bien dans le code.
  const withAlwaysVisible = useCallback(cols => {
    const forced = mergedColumns.filter(c => c.alwaysVisible).map(c => c.id)
    if (!forced.length) return cols
    const missing = forced.filter(id => !cols.includes(id))
    if (!missing.length) return cols
    // Insérée juste après sa voisine de gauche déclarée dans le meta, pour ne
    // pas casser l'ordre de colonnes que l'utilisateur a pu réorganiser.
    const order = mergedColumns.map(c => c.id)
    const next = [...cols]
    for (const id of missing) {
      const metaIdx = order.indexOf(id)
      let at = 0
      for (let i = metaIdx - 1; i >= 0; i--) {
        const pos = next.indexOf(order[i])
        if (pos !== -1) { at = pos + 1; break }
      }
      next.splice(at, 0, id)
    }
    return next
  }, [mergedColumns])

  // Apply view config when active view changes
  useEffect(() => {
    if (!view.configReady) return
    setVisibleCols(withAlwaysVisible(view.viewVisibleColumns))
    const rules = view.activeView?.color_rules
    setColorRules(Array.isArray(rules) ? rules : [])
    if (!forceAllView) {
      const newGroupBy = normalizeGroupBy(view.viewGroupBy)
      setGroupByRaw(newGroupBy)
      const o = view.viewGroupOrder
      setGroupOrderRaw(o == null ? [] : Array.isArray(o) ? o : [o])
      // Sync prevGroupByRef avec la nouvelle signature pour éviter que le
      // useEffect [groupBySig] détecte un changement et reset les groupes
      // collapsés qu'on est en train de restaurer depuis le serveur.
      prevGroupByRef.current = newGroupBy.join('|')
      // Restore collapsed groups : priorité au state sauvé sur la pill (sync
      // cross-device), fallback localStorage pour le legacy. Quand aucun des
      // deux n'est dispo on part déplié.
      let initial = null
      const persisted = view.activeView?.collapsed_groups
      if (Array.isArray(persisted)) {
        initial = persisted
      } else {
        try {
          const key = `erp_collapsed_${table}_${view.activeViewId || '__all__'}`
          initial = JSON.parse(localStorage.getItem(key) || '[]')
        } catch { initial = [] }
      }
      setCollapsedGroups(new Set(initial || []))
    } else {
      // forceAllView : pas de pill server-side, localStorage uniquement.
      try {
        const key = `erp_collapsed_${table}_forceAll`
        const stored = JSON.parse(localStorage.getItem(key) || '[]')
        setCollapsedGroups(new Set(stored))
      } catch { setCollapsedGroups(new Set()) }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.activeViewId, view.configReady])

  // Un champ nouvellement créé n'apparaît QUE dans la vue où il a été créé.
  //
  // La visibilité et l'ordre des colonnes appartiennent à la VUE, pas au champ :
  // une vue composée à la main ne doit pas se faire polluer parce que quelqu'un
  // a créé un champ ailleurs. On n'ajoute donc une colonne que si la création
  // vient de CE tableau — le « + », « Insérer à gauche/droite » ou « Dupliquer »
  // arment `creationIntent`, et rien d'autre ne déclenche d'affichage.
  //
  // C'est aussi ce qui fait disparaître, par construction, le bug de
  // ré-affichage : auparavant toute clé « nouvelle » entre deux renders était
  // ajoutée, si bien qu'un simple rechargement (ou une création faite par
  // quelqu'un d'autre) pouvait remettre des colonnes que l'utilisateur venait de
  // masquer. La garde `cfLoaded` reste nécessaire pour que la baseline ne soit
  // jamais la Map vide transitoire d'avant chargement.
  useEffect(() => {
    if (!view.configReady) return
    if (!cfByColumn) return
    if (!cfLoaded) return
    const currentKeys = new Set(cfByColumn.keys())
    const prev = prevCustomFieldKeys.current
    if (prev) {
      const intent = creationIntent.current
      const newOnes = intent ? [...currentKeys].filter(k => !prev.has(k)) : []
      if (newOnes.length > 0) {
        creationIntent.current = false
        // « Insérer à gauche / à droite » : le champ vient d'être créé depuis le
        // menu d'un champ précis — il se pose à cet endroit plutôt qu'en bout de
        // tableau. L'ancre est consommée une seule fois.
        const insert = pendingInsert.current
        pendingInsert.current = null
        setVisibleCols(cols => {
          const next = cols.filter(id => !newOnes.includes(id))
          const at = insert ? next.indexOf(insert.anchorId) : -1
          if (at === -1) return [...next, ...newOnes]
          next.splice(insert.side === 'before' ? at : at + 1, 0, ...newOnes)
          return next
        })
      }
    }
    prevCustomFieldKeys.current = currentKeys
  }, [cfByColumn, cfLoaded, view.configReady])

  const visibleColumns = useMemo(
    () => visibleCols
      .map(id => mergedColumns.find(c => c.id === id))
      .filter(Boolean)
      .filter(c => !isDisabled(c)), // colonnes dont l'import Airtable est désactivé : on les retire du rendu
    [mergedColumns, visibleCols, isDisabled]
  )

  const [dragOverCol, setDragOverCol] = useState(null)
  const [dragOverSide, setDragOverSide] = useState(null) // 'before' | 'after'
  const dragColRef = useRef(null)

  // Multi-sélection d'en-têtes de colonnes (⌘/Ctrl+clic pour ajouter/retirer,
  // Maj+clic pour une plage) → masquage en lot en un seul setVisibleCols, donc
  // un seul autosave de la vue. Les ids qui ne sont plus visibles sont ignorés
  // à la lecture (pas de nettoyage impératif nécessaire).
  const [selectedColIds, setSelectedColIds] = useState(() => new Set())
  const lastColClickRef = useRef(null)

  const clearColSelection = useCallback(() => {
    setSelectedColIds(prev => (prev.size ? new Set() : prev))
    lastColClickRef.current = null
  }, [])

  function handleColHeaderClick(e, colId) {
    const additive = e.metaKey || e.ctrlKey
    const range = e.shiftKey
    if (!additive && !range) {
      clearColSelection()
      return
    }
    e.preventDefault()
    const ids = visibleColumns.map(c => c.id)
    const anchor = lastColClickRef.current
    if (range && anchor && ids.includes(anchor) && anchor !== colId) {
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(colId)
      const [from, to] = a < b ? [a, b] : [b, a]
      setSelectedColIds(prev => {
        const next = new Set(prev)
        for (let i = from; i <= to; i++) next.add(ids[i])
        return next
      })
    } else {
      setSelectedColIds(prev => {
        const next = new Set(prev)
        if (next.has(colId)) next.delete(colId)
        else next.add(colId)
        return next
      })
      lastColClickRef.current = colId
    }
  }

  function handleColDragStart(e, colId) {
    dragColRef.current = colId
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', colId) } catch {}
  }
  function handleColDragOver(e, colId) {
    if (!dragColRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const side = (e.clientX - rect.left) < rect.width / 2 ? 'before' : 'after'
    if (dragOverCol !== colId) setDragOverCol(colId)
    if (dragOverSide !== side) setDragOverSide(side)
  }
  function handleColDrop(e) {
    e.preventDefault()
    const sourceId = dragColRef.current
    const targetId = dragOverCol
    const side = dragOverSide
    dragColRef.current = null
    setDragOverCol(null)
    setDragOverSide(null)
    if (!sourceId || !targetId || sourceId === targetId) return
    const next = visibleCols.filter(id => id !== sourceId)
    let idx = next.indexOf(targetId)
    if (idx === -1) return
    if (side === 'after') idx += 1
    next.splice(idx, 0, sourceId)
    setVisibleCols(next)
  }
  function handleColDragEnd() {
    dragColRef.current = null
    setDragOverCol(null)
    setDragOverSide(null)
  }

  // Colonnes sélectionnées réellement masquables : on ignore les ids devenus
  // invisibles et les colonnes d'action (`alwaysVisible`).
  const hideableSelectedColIds = useMemo(
    () => visibleColumns.filter(c => selectedColIds.has(c.id) && !c.alwaysVisible).map(c => c.id),
    [visibleColumns, selectedColIds]
  )

  const hideSelectedColumns = useCallback(() => {
    if (hideableSelectedColIds.length === 0) return
    const toHide = new Set(hideableSelectedColIds)
    setVisibleCols(prev => prev.filter(id => !toHide.has(id)))
    setSelectedColIds(new Set())
    lastColClickRef.current = null
  }, [hideableSelectedColIds])

  // ── Réordonnancement manuel de lignes (drag & drop, opt-in) ───────────────
  // Actif seulement quand l'ordre affiché correspond à l'ordre réel des données
  // (aucun tri, groupage, recherche ni filtre) — sinon la position cible serait
  // ambiguë pour les lignes masquées/re-triées.
  const reorderFiltersActive = Array.isArray(filters) ? filters.length > 0 : !!(filters?.rules?.length)
  const reorderActive = typeof onRowReorder === 'function' && groupBy.length === 0
    && (view.sorts?.length || 0) === 0 && !search && !reorderFiltersActive
  const [dragRowId, setDragRowId] = useState(null)
  const [dragOverRowId, setDragOverRowId] = useState(null)
  function handleRowDrop(targetId) {
    const src = dragRowId
    setDragRowId(null); setDragOverRowId(null)
    if (!src || src === targetId) return
    const ids = filteredData.map(r => r.id)
    const from = ids.indexOf(src), to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    ids.splice(from, 1); ids.splice(to, 0, src)
    onRowReorder(ids)
  }

  const gridTemplate = useMemo(() => {
    const cols = visibleColumns.map(c => colWidths[c.id] ? `${colWidths[c.id]}px` : 'minmax(120px, 1fr)').join(' ')
    // Si on a un bouton d'ajout de champ, on réserve une colonne `auto` à la
    // fin pour le "+" — les rows de données auront simplement une cellule vide.
    const withAdd = addCustomField ? `${cols} 36px` : cols
    // Colonne chevron d'expansion en tête (après la case de sélection si présente).
    const withExpand = expandable ? `34px ${withAdd}` : withAdd
    const withSelect = selectionActive ? `40px ${withExpand}` : withExpand
    // Poignée de réordonnancement tout à gauche.
    return reorderActive ? `28px ${withSelect}` : withSelect
  }, [visibleColumns, colWidths, selectionActive, addCustomField, expandable, reorderActive])

  // Reset selection when data changes (e.g., after delete, filter)
  const visibleIds = useMemo(() => filteredData.map(r => r.id).filter(Boolean), [filteredData])
  const allVisibleSelected = selectionActive && visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id))
  const someVisibleSelected = selectionActive && !allVisibleSelected && visibleIds.some(id => selectedIds.has(id))

  useEffect(() => {
    // Purge stale IDs when data shrinks (after delete or filter)
    if (!selectionActive) return
    setSelectedIds(prev => {
      if (prev.size === 0) return prev
      const dataIds = new Set(data.map(r => r.id))
      const next = new Set([...prev].filter(id => dataIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [data, selectionActive])

  function toggleRow(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleExpand = useCallback((item) => {
    const k = item?.[rowKey]
    if (k == null) return
    const willExpand = !expandedKeys.has(k)
    setExpandedKeys(prev => {
      const next = new Set(prev)
      next.has(k) ? next.delete(k) : next.add(k)
      return next
    })
    onToggleExpand?.(item, willExpand)
  }, [rowKey, expandedKeys, onToggleExpand])

  function toggleAllVisible() {
    setSelectedIds(prev => {
      if (allVisibleSelected) {
        const next = new Set(prev)
        for (const id of visibleIds) next.delete(id)
        return next
      }
      const next = new Set(prev)
      for (const id of visibleIds) next.add(id)
      return next
    })
  }

  async function handleBulkDelete() {
    const ids = [...selectedIds]
    if (!ids.length) return
    if (!(await confirm(`Supprimer ${ids.length} enregistrement${ids.length > 1 ? 's' : ''} ? Cette action est irréversible.`))) return
    setDeleting(true)
    try {
      await onBulkDelete(ids)
      setSelectedIds(new Set())
    } catch (err) {
      addToast({ message: 'Erreur lors de la suppression : ' + (err?.message || 'inconnue'), type: 'error' })
    } finally {
      setDeleting(false)
    }
  }

  async function runBulkAction(action) {
    const ids = [...selectedIds]
    if (!ids.length) return
    setBusyAction(action.key)
    try {
      await action.onClick(ids)
      setSelectedIds(new Set())
    } catch (err) {
      addToast({ message: 'Erreur : ' + (err?.message || 'inconnue'), type: 'error' })
    } finally {
      setBusyAction(null)
    }
  }

  // Lignes actuellement sélectionnées (objets data) — sert aux prédicats show() des actions custom.
  const selectedRows = useMemo(
    () => (hasBulkActions ? data.filter(r => selectedIds.has(r.id)) : []),
    [data, selectedIds, hasBulkActions]
  )
  const visibleBulkActions = useMemo(
    () => bulkActions.filter(a => typeof a.show !== 'function' || a.show(selectedRows)),
    [bulkActions, selectedRows]
  )

  // Clé localStorage : conserve la persistence locale comme fallback (utile
  // pour forceAllView, ou comme cache rapide avant la réponse serveur).
  const collapsedStorageKey = forceAllView
    ? `erp_collapsed_${table}_forceAll`
    : `erp_collapsed_${table}_${view.activeViewId || '__all__'}`
  const storageKeyRef = useRef(collapsedStorageKey)
  storageKeyRef.current = collapsedStorageKey

  // Debounce le save serveur des collapsed_groups : l'utilisateur peut
  // cliquer rapidement plusieurs groupes d'affilée, on bundle les writes.
  const saveCollapsedTimer = useRef(null)
  const activeViewIdRef = useRef(view.activeViewId)
  activeViewIdRef.current = view.activeViewId

  function saveCollapsed(set) {
    try { localStorage.setItem(storageKeyRef.current, JSON.stringify([...set])) } catch {}
    // Persiste côté serveur si une pill est active (sinon : pas de pill =
    // pas de stockage server, fallback localStorage seulement).
    if (!forceAllView && activeViewIdRef.current) {
      clearTimeout(saveCollapsedTimer.current)
      const viewId = activeViewIdRef.current
      const arr = [...set]
      saveCollapsedTimer.current = setTimeout(() => {
        api.views.updatePill(table, viewId, { collapsed_groups: arr }).catch(() => {})
      }, 400)
    }
  }

  const toggleGroup = useCallback(key => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      saveCollapsed(next)
      return next
    })
  }, [])

  // groupBy changeant (identité du tableau OU son contenu) → on reset les
  // groupes collapsés pour repartir d'un état déplié propre.
  const groupBySig = groupBy.join('|')
  const prevGroupByRef = useRef(groupBySig)
  useEffect(() => {
    if (prevGroupByRef.current !== groupBySig) {
      setCollapsedGroups(new Set())
      prevGroupByRef.current = groupBySig
    }
  }, [groupBySig])

  const numberColumns = useMemo(
    () => mergedColumns.filter(c => c.type === 'number' || c.type === 'currency'),
    [mergedColumns]
  )

  // Valeurs de la barre de totaux : agrégation calculée sur les lignes filtrées
  // (le total « courant » reflète la recherche + les filtres actifs).
  const hasFooter = useMemo(
    () => visibleColumns.some(c => footerAggs[c.id]),
    [visibleColumns, footerAggs]
  )
  const footerValues = useMemo(() => {
    const m = new Map()
    if (!hasFooter) return m
    for (const col of visibleColumns) {
      const type = footerAggs[col.id]
      if (!type) continue
      m.set(col.id, computeAggregation(type, filteredData, col.field))
    }
    return m
  }, [hasFooter, visibleColumns, footerAggs, filteredData])

  // Formatage conditionnel : résout la couleur de chaque ligne visible. Les
  // règles sont évaluées dans l'ordre — la première qui matche gagne (sémantique
  // Airtable). Réutilise le moteur de filtres des vues (applyFilterGroup), donc
  // mêmes opérateurs, y compris is_me/is_not_me via le contexte utilisateur.
  const currentUserName = useMemo(() => getUser()?.name || null, [])
  const rowColorById = useMemo(() => {
    const m = new Map()
    if (!Array.isArray(colorRules) || colorRules.length === 0) return m
    const active = colorRules.filter(r => r && ROW_COLOR_STYLES[r.color] && countFilterRules(r.filters) > 0)
    if (active.length === 0) return m
    const ctx = { userName: currentUserName }
    for (const row of filteredData) {
      if (row?.id == null) continue
      for (const rule of active) {
        const f = rule.filters
        const match = Array.isArray(f)
          ? f.every(x => applyFilter(row, x, ctx))
          : applyFilterGroup(row, f, ctx)
        if (match) { m.set(row.id, rule.color); break }
      }
    }
    return m
  }, [filteredData, colorRules, currentUserName])

  const virtualItems = useMemo(() => {
    if (!groupBy.length) return filteredData

    const cmpAlpha = (a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true })

    // Construction récursive : pour chaque niveau, on regroupe les rows par
    // la valeur du champ courant, on ordonne les clés, on émet le header
    // puis (si déplié) les enfants — soit le niveau suivant, soit les rows.
    // pathKey = clés du niveau 0 jusqu'à ce niveau, jointes par '||' ; sert
    // d'identifiant unique pour le set `collapsedGroups`.
    function buildLevel(rows, levelIdx, parentPath) {
      if (levelIdx >= groupBy.length) return rows
      const field = groupBy[levelIdx]
      const order = groupOrder[levelIdx] || null

      const groups = new Map()
      for (const row of rows) {
        const k = String(row[field] ?? '(vide)')
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(row)
      }

      const groupCol = mergedColumns.find(c => c.field === field)
      const hasOptions = Array.isArray(groupCol?.options) && groupCol.options.length > 0
      let keys = [...groups.keys()]
      if (order === 'asc') {
        keys.sort(cmpAlpha)
      } else if (order === 'desc') {
        keys.sort(cmpAlpha).reverse()
      } else if (hasOptions) {
        const orderIdx = new Map(groupCol.options.map((o, i) => [String(o), i]))
        keys.sort((a, b) => {
          const ia = orderIdx.has(a) ? orderIdx.get(a) : Number.MAX_SAFE_INTEGER
          const ib = orderIdx.has(b) ? orderIdx.get(b) : Number.MAX_SAFE_INTEGER
          if (ia !== ib) return ia - ib
          return cmpAlpha(a, b)
        })
      } else {
        keys.sort(cmpAlpha)
      }

      const flat = []
      for (const key of keys) {
        const groupRows = groups.get(key)
        const path = parentPath ? `${parentPath}||${key}` : key
        const collapsed = collapsedGroups.has(path)

        const sums = {}
        if (numberColumns.length > 0) {
          for (const col of numberColumns) {
            let total = 0
            for (const row of groupRows) {
              const v = parseFloat(row[col.field])
              if (!isNaN(v)) total += v
            }
            if (total !== 0) sums[col.field] = total
          }
        }

        flat.push({
          __isGroup: true,
          __key: key,
          __pathKey: path,
          __level: levelIdx,
          __count: groupRows.length,
          __collapsed: collapsed,
          __sums: sums,
        })
        if (!collapsed) {
          flat.push(...buildLevel(groupRows, levelIdx + 1, path))
        }
      }
      return flat
    }

    return buildLevel(filteredData, 0, null)
  }, [filteredData, groupBy, groupOrder, collapsedGroups, numberColumns, mergedColumns])

  // Insère, après chaque ligne dépliée, un pseudo-item d'expansion dont la
  // hauteur est mesurée dynamiquement par le virtualizer (renderExpanded).
  const displayItems = useMemo(() => {
    if (!expandable || expandedKeys.size === 0) return virtualItems
    const out = []
    for (const it of virtualItems) {
      out.push(it)
      if (!it.__isGroup) {
        const k = it[rowKey]
        if (k != null && expandedKeys.has(k)) {
          out.push({ __isExpansion: true, __expandKey: k, __row: it })
        }
      }
    }
    return out
  }, [virtualItems, expandedKeys, expandable, rowKey])

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: displayItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: i => displayItems[i]?.__isExpansion ? 220 : displayItems[i]?.__isGroup ? 26 : 32,
    overscan: 12,
  })

  // ── Mode tableur — géométrie & opérations ────────────────────────────────
  // Les lignes de données (hors groupes/expansions) en ordre d'affichage, plus
  // les index id→position pour résoudre la sélection (stockée par id, robuste
  // aux re-tris/realtime). displayIndexById sert au scroll-into-view.
  const { gridRows, rowIndexById, displayIndexById } = useMemo(() => {
    const rows = [], rIdx = new Map(), dIdx = new Map()
    if (gridMode) {
      displayItems.forEach((it, i) => {
        if (it && !it.__isGroup && !it.__isExpansion && it.id != null) {
          rIdx.set(it.id, rows.length)
          dIdx.set(it.id, i)
          rows.push(it)
        }
      })
    }
    return { gridRows: rows, rowIndexById: rIdx, displayIndexById: dIdx }
  }, [displayItems, gridMode])

  const colIndexById = useMemo(() => {
    const m = new Map()
    visibleColumns.forEach((c, i) => m.set(c.id, i))
    return m
  }, [visibleColumns])

  // Rectangle de sélection courant en indices { minR, maxR, minC, maxC } | null.
  const selBounds = useCallback(() => {
    if (!sel) return null
    const aR = rowIndexById.get(sel.anchor.rowId), aC = colIndexById.get(sel.anchor.colId)
    const fR = rowIndexById.get(sel.focus.rowId), fC = colIndexById.get(sel.focus.colId)
    if (aR == null || aC == null || fR == null || fC == null) return null
    return { minR: Math.min(aR, fR), maxR: Math.max(aR, fR), minC: Math.min(aC, fC), maxC: Math.max(aC, fC) }
  }, [sel, rowIndexById, colIndexById])
  const gridBounds = useMemo(() => (gridMode ? selBounds() : null), [gridMode, selBounds])

  const cellAt = useCallback((r, c) => {
    const row = gridRows[r], col = visibleColumns[c]
    if (!row || !col) return null
    return { rowId: row.id, colId: col.id }
  }, [gridRows, visibleColumns])

  const focusGrid = useCallback(() => { try { parentRef.current?.focus({ preventScroll: true }) } catch {} }, [])

  const moveCursor = useCallback((r, c, extend) => {
    const rr = Math.max(0, Math.min(gridRows.length - 1, r))
    const cc = Math.max(0, Math.min(visibleColumns.length - 1, c))
    const cell = cellAt(rr, cc)
    if (!cell) return
    if (extend) setSel(s => ({ anchor: s?.anchor || cell, focus: cell }))
    else setSel({ anchor: cell, focus: cell })
    const di = displayIndexById.get(cell.rowId)
    if (di != null) { try { virtualizer.scrollToIndex(di, { align: 'auto' }) } catch {} }
  }, [gridRows, visibleColumns, cellAt, displayIndexById, virtualizer])

  // Applique une liste de { row, col, value } via onCellEdit (un appel par
  // cellule). Les valeurs `undefined` (collage invalide) sont écartées.
  const applyCellChanges = useCallback(async (changes) => {
    const valid = changes.filter(c => c && c.value !== undefined)
    if (!valid.length) return
    setGridSaving(true)
    try { await Promise.all(valid.map(c => Promise.resolve(onCellEdit(c.row, c.col, c.value)))) }
    catch { /* le parent gère ses propres toasts d'erreur */ }
    finally { setGridSaving(false) }
  }, [onCellEdit])

  const startEdit = useCallback((rowId, colId, seed) => {
    const col = visibleColumns[colIndexById.get(colId)]
    const row = gridRows[rowIndexById.get(rowId)]
    if (!row || !isColEditable(col)) return
    const raw = row[col.field]
    // Checkbox : pas de mode édition texte — un double-clic / Enter / frappe
    // bascule directement la valeur (0 ⇄ 1) et persiste.
    if (col.type === 'boolean') {
      setSel({ anchor: { rowId, colId }, focus: { rowId, colId } })
      const truthy = raw === 1 || raw === true || raw === '1' || raw === '1.0' || Number(raw) === 1
      applyCellChanges([{ row, col, value: truthy ? 0 : 1 }])
      focusGrid()
      return
    }
    setSel({ anchor: { rowId, colId }, focus: { rowId, colId } })
    setEditingCell({ rowId, colId })
    // Durée : on amorce l'édition avec la valeur formatée (h:mm ou h:mm:ss selon
    // la précision) plutôt que les secondes brutes — sans perte de précision.
    let initial = raw == null ? '' : String(raw)
    if (col.type === 'duration' && raw != null && raw !== '' && Number.isFinite(Number(raw))) {
      const n = Number(raw)
      initial = formatDurationSeconds(n, n % 60 === 0 ? 'h:mm' : 'h:mm:ss')
    }
    setEditValue(seed != null ? seed : initial)
  }, [visibleColumns, gridRows, colIndexById, rowIndexById, isColEditable, applyCellChanges, focusGrid])

  const cancelEdit = useCallback(() => { setEditingCell(null); focusGrid() }, [focusGrid])

  const commitEdit = useCallback((move) => {
    const ec = editingCell
    if (ec) {
      const col = visibleColumns[colIndexById.get(ec.colId)]
      const row = gridRows[rowIndexById.get(ec.rowId)]
      if (col && row) {
        const value = coerceCellValue(col, editValue)
        if (value !== undefined) {
          const cur = row[col.field]
          const curNorm = cur == null ? null : (col.type === 'number' || col.type === 'currency' || col.type === 'duration' ? Number(cur) : String(cur))
          if (value !== curNorm) applyCellChanges([{ row, col, value }])
        }
        if (move) {
          const r = rowIndexById.get(ec.rowId), c = colIndexById.get(ec.colId)
          if (move === 'down') moveCursor(r + 1, c, false)
          else if (move === 'right') moveCursor(r, c + 1, false)
          else if (move === 'left') moveCursor(r, c - 1, false)
        }
      }
    }
    setEditingCell(null)
    focusGrid()
  }, [editingCell, visibleColumns, gridRows, colIndexById, rowIndexById, editValue, applyCellChanges, moveCursor, focusGrid])

  const copyCells = useCallback((b) => {
    const lines = []
    for (let r = b.minR; r <= b.maxR; r++) {
      const parts = []
      for (let c = b.minC; c <= b.maxC; c++) {
        const v = gridRows[r]?.[visibleColumns[c]?.field]
        parts.push(v == null ? '' : String(v))
      }
      lines.push(parts.join('\t'))
    }
    const text = lines.join('\n')
    internalClipRef.current = text
    try { navigator.clipboard?.writeText(text) } catch {}
    const n = (b.maxR - b.minR + 1) * (b.maxC - b.minC + 1)
    addToast({ message: `${n} cellule${n > 1 ? 's' : ''} copiée${n > 1 ? 's' : ''}`, type: 'success' })
  }, [gridRows, visibleColumns, addToast])

  const fillDown = useCallback((b) => {
    if (b.maxR <= b.minR) return
    const changes = []
    for (let c = b.minC; c <= b.maxC; c++) {
      const col = visibleColumns[c]
      if (!isColEditable(col)) continue
      const src = gridRows[b.minR]?.[col.field]
      const value = coerceCellValue(col, src == null ? '' : String(src))
      if (value === undefined) continue
      for (let r = b.minR + 1; r <= b.maxR; r++) changes.push({ row: gridRows[r], col, value })
    }
    applyCellChanges(changes)
  }, [gridRows, visibleColumns, isColEditable, applyCellChanges])

  const pasteCells = useCallback(async (b) => {
    let text = internalClipRef.current || ''
    try { const t = await navigator.clipboard.readText(); if (t) text = t } catch {}
    if (!text) return
    const grid = parseClipboard(text)
    if (!grid.length) return
    const changes = []
    const single = grid.length === 1 && grid[0].length === 1
    if (single && (b.maxR > b.minR || b.maxC > b.minC)) {
      // Une seule valeur collée sur une plage → on remplit toute la plage.
      for (let r = b.minR; r <= b.maxR; r++) for (let c = b.minC; c <= b.maxC; c++) {
        const col = visibleColumns[c]; if (!isColEditable(col)) continue
        const value = coerceCellValue(col, grid[0][0]); if (value === undefined) continue
        changes.push({ row: gridRows[r], col, value })
      }
    } else {
      for (let i = 0; i < grid.length; i++) for (let j = 0; j < grid[i].length; j++) {
        const r = b.minR + i, c = b.minC + j
        const row = gridRows[r], col = visibleColumns[c]
        if (!row || !col || !isColEditable(col)) continue
        const value = coerceCellValue(col, grid[i][j]); if (value === undefined) continue
        changes.push({ row, col, value })
      }
      const er = Math.min(gridRows.length - 1, b.minR + grid.length - 1)
      const ec = Math.min(visibleColumns.length - 1, b.minC + (grid[0]?.length || 1) - 1)
      const a = cellAt(b.minR, b.minC), f = cellAt(er, ec)
      if (a && f) setSel({ anchor: a, focus: f })
    }
    applyCellChanges(changes)
  }, [gridRows, visibleColumns, isColEditable, applyCellChanges, cellAt])

  const clearCells = useCallback((b) => {
    const changes = []
    for (let r = b.minR; r <= b.maxR; r++) for (let c = b.minC; c <= b.maxC; c++) {
      const col = visibleColumns[c]; if (!isColEditable(col)) continue
      changes.push({ row: gridRows[r], col, value: null })
    }
    applyCellChanges(changes)
  }, [gridRows, visibleColumns, isColEditable, applyCellChanges])

  // Raccourcis clavier globaux quand une cellule est sélectionnée. On ignore
  // les frappes si un champ (recherche, filtre, input inline) a le focus.
  const onGridKeyDown = useCallback((e) => {
    if (!gridMode || editingCell) return
    const ae = document.activeElement
    const tag = ae?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae?.isContentEditable) return
    if (!sel) return
    const b = selBounds(); if (!b) return
    const mod = e.metaKey || e.ctrlKey
    const k = e.key
    if (mod && (k === 'c' || k === 'C')) { e.preventDefault(); copyCells(b); return }
    if (mod && (k === 'v' || k === 'V')) { e.preventDefault(); pasteCells(b); return }
    if (mod && (k === 'd' || k === 'D')) { e.preventDefault(); fillDown(b); return }
    const fR = rowIndexById.get(sel.focus.rowId), fC = colIndexById.get(sel.focus.colId)
    if (fR == null || fC == null) return
    if (k === 'ArrowUp') { e.preventDefault(); moveCursor(fR - 1, fC, e.shiftKey) }
    else if (k === 'ArrowDown') { e.preventDefault(); moveCursor(fR + 1, fC, e.shiftKey) }
    else if (k === 'ArrowLeft') { e.preventDefault(); moveCursor(fR, fC - 1, e.shiftKey) }
    else if (k === 'ArrowRight') { e.preventDefault(); moveCursor(fR, fC + 1, e.shiftKey) }
    else if (k === 'Escape') { e.preventDefault(); setSel(null) }
    else if (k === 'Enter' || k === 'F2') { e.preventDefault(); startEdit(sel.focus.rowId, sel.focus.colId) }
    else if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); clearCells(b) }
    else if (k.length === 1 && !mod && !e.altKey) {
      if (isColEditable(visibleColumns[fC])) { e.preventDefault(); startEdit(sel.focus.rowId, sel.focus.colId, k) }
    }
  }, [gridMode, editingCell, sel, selBounds, copyCells, pasteCells, fillDown, moveCursor, startEdit, clearCells, rowIndexById, colIndexById, visibleColumns, isColEditable])

  // Échap abandonne la multi-sélection d'en-têtes de colonnes.
  useEffect(() => {
    if (selectedColIds.size === 0) return
    const h = (e) => { if (e.key === 'Escape') clearColSelection() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [selectedColIds, clearColSelection])

  keyHandlerRef.current = onGridKeyDown
  useEffect(() => {
    if (!gridMode) return
    const h = (e) => keyHandlerRef.current?.(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [gridMode])

  // Tous les pathKeys actuellement matérialisés (utile pour "Tout fermer").
  // Note : avec le nested grouping, ne contient que les groupes des niveaux
  // dépliés — un groupe parent fermé masque ses enfants donc ils n'apparaissent
  // pas ici. "Tout fermer" sur les niveaux visibles est suffisant ; un second
  // appel après que l'utilisateur ait déplié des niveaux fermera ceux-là.
  const groupKeys = useMemo(
    () => virtualItems.filter(i => i.__isGroup).map(i => i.__pathKey),
    [virtualItems]
  )

  const collapseAll = useCallback(() => {
    const s = new Set(groupKeys)
    setCollapsedGroups(s)
    saveCollapsed(s)
  }, [groupKeys])
  const expandAll = useCallback(() => {
    const s = new Set()
    setCollapsedGroups(s)
    saveCollapsed(s)
  }, [])

  if (!configReady) return null

  return (
    <div className="card overflow-hidden flex flex-col">

      <ViewToolbar
        table={table}
        columns={mergedColumns}
        sorts={view.sorts} setSorts={view.setSorts}
        filters={view.filters} setFilters={view.setFilters}
        search={view.search} setSearch={view.setSearch}
        searchFields={searchFields}
        views={view.views}
        onReorderViews={view.reorderViews}
        activeViewId={view.activeViewId}
        setActiveViewId={view.setActiveViewId}
        patchLocalView={view.patchLocalView}
        processedCount={filteredData.length}
        visibleCols={visibleCols} setVisibleCols={setVisibleCols}
        groupBy={groupBy} setGroupBy={setGroupBy}
        groupOrder={groupOrder} setGroupOrder={setGroupOrder}
        colorRules={colorRules} setColorRules={setColorRules}
        onCollapseAll={collapseAll} onExpandAll={expandAll}
        data={data}
        disabledColumns={disabledColumns}
        manageViews={manageViews}
        manageViewsBulkDelete={typeof onBulkDelete === 'function' && !bulkDeleteAlways}
        onOpenFieldConfig={openFieldConfig}
      />

      {selectionActive && selectedIds.size > 0 && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-brand-50 border-b border-brand-100">
          <span className="text-sm text-brand-900">
            {selectedIds.size} sélectionné{selectedIds.size > 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1"
            >
              Désélectionner
            </button>
            {visibleBulkActions.map(action => {
              const Icon = action.icon
              const busy = busyAction === action.key
              return (
                <button
                  key={action.key}
                  onClick={() => runBulkAction(action)}
                  disabled={busy || busyAction !== null}
                  className={action.className || 'inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 px-3 py-1.5 rounded transition-colors'}
                >
                  {Icon && <Icon size={13} />}
                  {busy ? (action.busyLabel || 'En cours...') : action.label}
                </button>
              )
            })}
            {typeof onBulkDelete === 'function' && (
              <button
                onClick={handleBulkDelete}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 px-3 py-1.5 rounded transition-colors"
              >
                <Trash2 size={13} />
                {deleting ? 'Suppression...' : 'Supprimer'}
              </button>
            )}
          </div>
        </div>
      )}

      {hideableSelectedColIds.length > 0 && (
        <div
          data-testid="datatable-colsel-bar"
          className="flex items-center gap-3 px-4 py-2 bg-brand-50 border-b border-brand-100"
        >
          <span className="text-sm text-brand-900">
            {hideableSelectedColIds.length} colonne{hideableSelectedColIds.length > 1 ? 's' : ''} sélectionnée{hideableSelectedColIds.length > 1 ? 's' : ''}
          </span>
          <span className="hidden sm:inline text-xs text-brand-700/70">
            ⌘/Ctrl+clic pour ajouter · Maj+clic pour une plage
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={clearColSelection}
              className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1"
            >
              Désélectionner
            </button>
            <button
              onClick={hideSelectedColumns}
              data-testid="colsel-hide"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 px-3 py-1.5 rounded transition-colors"
            >
              <EyeOff size={13} />
              Cacher {hideableSelectedColIds.length > 1 ? 'ces colonnes' : 'cette colonne'}
            </button>
          </div>
        </div>
      )}

      {gridMode && sel && gridBounds && (
        <div data-testid="datatable-grid-bar" className="flex items-center gap-3 px-4 py-1.5 bg-slate-50 border-b border-slate-100 text-xs text-slate-500">
          <span className="font-medium text-slate-600">
            {(gridBounds.maxR - gridBounds.minR + 1) * (gridBounds.maxC - gridBounds.minC + 1)} cellule(s)
          </span>
          <span className="text-slate-300">·</span>
          <span className="hidden sm:inline">⌘/Ctrl+C copier · ⌘/Ctrl+V coller · ⌘/Ctrl+D remplir vers le bas · double-clic pour ouvrir</span>
          {gridSaving && (
            <span className="ml-auto flex items-center gap-1.5 text-slate-400">
              <span className="inline-block w-3 h-3 border border-slate-300 border-t-transparent rounded-full animate-spin" />
              Enregistrement…
            </span>
          )}
        </div>
      )}

      <div ref={parentRef} tabIndex={gridMode ? -1 : undefined} className="overflow-auto outline-none" style={{ height }}>
        <div style={{ minWidth: 'max-content' }}>
          <div
            className="group/header grid border-b border-slate-200 bg-slate-50 sticky top-0 z-10"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {reorderActive && <div aria-hidden />}
            {selectionActive && (
              <div className="flex items-center justify-center px-2">
                <input
                  type="checkbox"
                  aria-label="Tout sélectionner"
                  checked={allVisibleSelected}
                  ref={el => { if (el) el.indeterminate = someVisibleSelected }}
                  onChange={toggleAllVisible}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                />
              </div>
            )}
            {expandable && <div aria-hidden />}
            {visibleColumns.map(col => {
              const customField = cfByColumn?.get(col.field) || cfByColumn?.get(col.id)
              const colSelected = selectedColIds.has(col.id)
              return (
                <div
                  key={col.id}
                  data-testid={`col-header-${col.id}`}
                  data-col-selected={colSelected ? 'true' : undefined}
                  onDoubleClick={e => {
                    // Renommage en ligne — seulement sur un champ manipulable.
                    if (col.alwaysVisible) return
                    e.stopPropagation()
                    setRenamingCol({ id: col.id, value: col.label || '' })
                  }}
                  draggable={renamingCol?.id !== col.id}
                  onDragStart={e => handleColDragStart(e, col.id)}
                  onDragOver={e => handleColDragOver(e, col.id)}
                  onDrop={handleColDrop}
                  onDragEnd={handleColDragEnd}
                  onDragLeave={() => setDragOverCol(prev => prev === col.id ? null : prev)}
                  onClick={e => handleColHeaderClick(e, col.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    // Clic droit hors sélection : on repart d'une sélection vide
                    // pour que le menu ne propose pas un lot inattendu.
                    if (!selectedColIds.has(col.id)) clearColSelection()
                    setColMenu({
                      x: e.clientX,
                      y: e.clientY,
                      col,
                      source: customField ? (customField.source || 'native') : null,
                      field: customField || null,
                    })
                  }}
                  className={`group/col relative px-4 py-2.5 text-xs font-semibold uppercase tracking-wide leading-tight break-words select-none cursor-grab active:cursor-grabbing ${colSelected ? 'bg-brand-100 text-brand-800' : 'text-slate-500'}`}
                >
                  {renamingCol?.id === col.id ? (
                    <input
                      autoFocus
                      value={renamingCol.value}
                      data-testid={`col-rename-${col.id}`}
                      onChange={e => setRenamingCol({ id: col.id, value: e.target.value })}
                      onBlur={e => commitRename(col, e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRename(col, e.currentTarget.value) }
                        else if (e.key === 'Escape') { e.preventDefault(); setRenamingCol(null) }
                        e.stopPropagation()
                      }}
                      onClick={e => e.stopPropagation()}
                      className="w-full bg-white border border-brand-400 rounded px-1 py-0.5 text-xs font-semibold uppercase tracking-wide text-slate-700 focus:outline-none"
                    />
                  ) : (
                    <span className="inline-flex items-baseline gap-1 pr-4">
                      {col.label}
                      {col.description && <ColumnHelp description={col.description} />}
                    </span>
                  )}
                  {/* Chevron d'ouverture du menu de champ — visible au survol,
                      clic GAUCHE (le clic droit reste supporté). C'est le geste
                      Airtable : on n'a pas à deviner qu'un menu contextuel existe. */}
                  {!renamingCol && (
                    <button
                      type="button"
                      aria-label={`Menu du champ ${col.label}`}
                      data-testid={`col-menu-btn-${col.id}`}
                      onClick={e => {
                        e.stopPropagation()
                        const r = e.currentTarget.getBoundingClientRect()
                        if (!selectedColIds.has(col.id)) clearColSelection()
                        setColMenu({
                          x: r.left, y: r.bottom + 2, col,
                          source: customField ? (customField.source || 'native') : null,
                          field: customField || null,
                        })
                      }}
                      className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-400 opacity-0 group-hover/col:opacity-100 hover:bg-slate-200 hover:text-slate-700 transition-opacity"
                    >
                      <ChevronDown size={13} />
                    </button>
                  )}
                  {dragOverCol === col.id && dragColRef.current && dragColRef.current !== col.id && (
                    <div
                      className={`absolute top-0 bottom-0 w-0.5 bg-brand-500 pointer-events-none ${dragOverSide === 'before' ? '-left-px' : '-right-px'}`}
                    />
                  )}
                  <ResizeHandle onResize={w => handleColResize(col.id, w)} />
                </div>
              )
            })}
            {addCustomField && (
              <div className="flex items-center justify-center">
                <button
                  type="button"
                  onClick={() => { creationIntent.current = true; addCustomField() }}
                  className="p-1 rounded text-slate-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                  title="Ajouter un champ"
                  aria-label="Ajouter un champ"
                >
                  <Plus size={14} />
                </button>
              </div>
            )}
          </div>

          {colMenu && (() => {
            const c = colMenu.col
            // Un champ est manipulable dès qu'on sait le rattacher à quelque
            // chose : un champ perso/Airtable (colMenu.field), ou une colonne
            // native connue de la table. Les colonnes d'action (boutons de
            // ligne) n'en sont pas.
            const isFieldManageable = !!colMenu.field
              || (!!table && !c?.alwaysVisible && columnsWithOwnCf.some(x => x.id === c.id))
            const canGroup = c?.groupable !== false && c?.field
            const canSort = c?.sortable !== false && c?.field
            const canFilter = c?.filterable !== false && c?.field
            const itemCls = 'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 text-left'
            return (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setColMenu(null)} onContextMenu={e => { e.preventDefault(); setColMenu(null) }} />
                <div
                  className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[200px]"
                  style={{ top: colMenu.y, left: colMenu.x }}
                >
                  {canGroup && (
                    <button onClick={() => { setGroupBy(c.field); setColMenu(null) }} className={itemCls}>
                      <Layers size={13} /> Grouper par cette colonne
                    </button>
                  )}
                  {canFilter && (
                    <button
                      onClick={() => {
                        const op = defaultOpForType(c.type)
                        const newRule = { field: c.field, op, value: '' }
                        const cur = view.filters
                        const nextFilters = (cur && cur.rules)
                          ? { ...cur, rules: [...cur.rules, newRule] }
                          : (Array.isArray(cur) ? [...cur, newRule] : [newRule])
                        view.setFilters(nextFilters)
                        window.dispatchEvent(new CustomEvent('datatable:open-panel', { detail: { table, panel: 'filter' } }))
                        setColMenu(null)
                      }}
                      className={itemCls}
                    >
                      <Filter size={13} /> Filtrer cette colonne
                    </button>
                  )}
                  {canSort && (
                    <button onClick={() => { view.setSorts([{ field: c.field, dir: 'asc' }]); setColMenu(null) }} className={itemCls}>
                      <ArrowUp size={13} /> Trier croissant
                    </button>
                  )}
                  {canSort && (
                    <button onClick={() => { view.setSorts([{ field: c.field, dir: 'desc' }]); setColMenu(null) }} className={itemCls}>
                      <ArrowDown size={13} /> Trier décroissant
                    </button>
                  )}
                  {hideableSelectedColIds.length > 1 && selectedColIds.has(c.id) ? (
                    <button
                      onClick={() => { hideSelectedColumns(); setColMenu(null) }}
                      className={itemCls}
                      data-testid="colmenu-hide-selected"
                    >
                      <EyeOff size={13} /> Cacher les {hideableSelectedColIds.length} colonnes sélectionnées
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        setVisibleCols(prev => prev.filter(id => id !== c.id))
                        setColMenu(null)
                      }}
                      className={itemCls}
                    >
                      <EyeOff size={13} /> Cacher cette colonne
                    </button>
                  )}
                  {/* Actions de CHAMP — identiques pour un champ natif (défini
                      dans tableDefs) et pour un champ perso/Airtable. Seule la
                      mécanique diffère sous le capot : la modale native écrit
                      une personnalisation, la modale perso édite le champ ;
                      « Supprimer » masque globalement le natif et soft-delete
                      le perso. L'utilisateur, lui, voit un seul type de champ. */}
                  {isFieldManageable && (
                    <>
                      <div className="my-1 border-t border-slate-100" />
                      <button
                        onClick={() => {
                          setColMenu(null)
                          if (colMenu.field) editCustomField?.(colMenu.field)
                          else {
                            // La modale attend la définition D'ORIGINE (pré-override)
                            // pour afficher « nom/type d'origine » et détecter un reset.
                            const orig = columnsWithOwnCf.find(x => x.id === c.id) || c
                            setFieldOverrideModal({
                              col: orig.render && LINKED_RECORD_TYPE_LABELS[orig.id]
                                ? { ...orig, renderTypeLabel: LINKED_RECORD_TYPE_LABELS[orig.id] }
                                : orig,
                            })
                          }
                        }}
                        className={itemCls}
                        data-testid={colMenu.field ? 'colmenu-edit-custom-field' : 'colmenu-edit-native-field'}
                      >
                        <Edit2 size={13} /> Modifier le champ
                      </button>
                      <button
                        onClick={() => { setColMenu(null); duplicateField(c) }}
                        className={itemCls}
                        data-testid="colmenu-duplicate-field"
                      >
                        <Copy size={13} /> Dupliquer le champ
                      </button>
                      {addCustomField && (
                        <>
                          <button
                            onClick={() => { setColMenu(null); insertFieldAt(c, 'before') }}
                            className={itemCls}
                            data-testid="colmenu-insert-left"
                          >
                            <ArrowLeftToLine size={13} /> Insérer un champ à gauche
                          </button>
                          <button
                            onClick={() => { setColMenu(null); insertFieldAt(c, 'after') }}
                            className={itemCls}
                            data-testid="colmenu-insert-right"
                          >
                            <ArrowRightToLine size={13} /> Insérer un champ à droite
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => {
                          const f = colMenu.field
                          setColMenu(null)
                          if (f) deleteCustomField?.(f)
                          else hideNativeField(c)
                        }}
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 text-left"
                        data-testid="colmenu-delete-field"
                      >
                        <Trash2 size={13} /> Supprimer le champ
                      </button>
                    </>
                  )}
                </div>
              </>
            )
          })()}

          {/* Modale UNIQUE de modification de champ — commune aux champs custom
              auto-gérés (création/édition) et aux champs natifs (renommage /
              changement de type via field_overrides). Les valeurs calculées
              (formule/lookup) d'un nouveau champ apparaissent au prochain
              rechargement des données de la page ; un champ data neuf est vide
              de toute façon. */}
          <CustomFieldModal
            isOpen={!!ownCfModal || !!fieldOverrideModal}
            onClose={() => { setOwnCfModal(null); setFieldOverrideModal(null) }}
            erpTable={table}
            editing={ownCfModal?.editing || null}
            native={fieldOverrideModal?.col
              ? { column: fieldOverrideModal.col, override: fieldOverrides.get(fieldOverrideModal.col.id) || null }
              : null}
            onSaved={() => { fieldOverrideModal ? reloadFieldOverrides() : reloadOwnCustomFields() }}
            onDeleted={() => { reloadOwnCustomFields() }}
          />


          {loading ? (
            <div className="flex items-center justify-center text-slate-400 text-sm py-12">
              Chargement...
            </div>
          ) : virtualItems.length === 0 ? (
            (() => {
              const hasRows = Array.isArray(data) && data.length > 0
              const filtersActive = Array.isArray(filters)
                ? filters.length > 0
                : !!(filters?.rules?.length)
              // Des lignes existent mais la recherche/les filtres les masquent toutes.
              if (hasRows && (search || filtersActive)) {
                return (
                  <EmptyState
                    icon={Filter}
                    title="Aucun résultat ne correspond"
                    description="Aucune ligne ne correspond à votre recherche ou à vos filtres actifs."
                    cta={{
                      label: 'Réinitialiser',
                      icon: RotateCcw,
                      onClick: () => { setSearch?.(''); setFilters?.([]) },
                    }}
                  />
                )
              }
              // Table réellement vide : message contextuel fourni par le parent, sinon défaut.
              return (
                <EmptyState
                  icon={emptyState?.icon || Inbox}
                  title={emptyState?.title || 'Aucune donnée'}
                  description={emptyState?.description || 'Cette table ne contient encore aucun enregistrement.'}
                  cta={emptyState?.cta}
                />
              )
            })()
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map(vItem => {
              const item = displayItems[vItem.index]

              if (item.__isExpansion) {
                return (
                  <div
                    key={vItem.key}
                    data-index={vItem.index}
                    data-testid={`datatable-expansion-${item.__expandKey}`}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: vItem.start, left: 0, right: 0, width: '100%' }}
                    className="border-b border-slate-100 bg-slate-50/40"
                  >
                    {renderExpanded(item.__row)}
                  </div>
                )
              }

              if (item.__isGroup) {
                const sums = item.__sums || {}
                // Niveau 0 = la teinte la plus marquée ; chaque niveau imbriqué
                // s'éclaircit légèrement pour visualiser la hiérarchie. Cap au
                // niveau 2 pour éviter de devenir invisible.
                const lvl = item.__level || 0
                // Reformate la clé du groupe via la colonne du niveau (utile
                // pour ex. afficher "mai 2026" pour un YYYY-MM ou "Upgrade"
                // pour la catégorie brute "upgrade").
                const lvlField = groupBy[lvl]
                const lvlCol = lvlField ? mergedColumns.find(c => c.field === lvlField) : null
                const groupLabel = lvlCol?.formatGroupKey
                  ? lvlCol.formatGroupKey(item.__key)
                  : item.__key
                const groupBg = lvl === 0
                  ? 'bg-slate-100 hover:bg-slate-200'
                  : lvl === 1
                    ? 'bg-slate-50 hover:bg-slate-100'
                    : 'bg-white hover:bg-slate-50'
                return (
                  <div
                    key={vItem.key}
                    data-testid={`datatable-group-${item.__pathKey}`}
                    data-group-level={lvl}
                    style={{
                      position: 'absolute', top: vItem.start, left: 0, right: 0, height: vItem.size,
                      display: 'grid',
                      gridTemplateColumns: gridTemplate,
                      alignItems: 'center',
                    }}
                    className={`${groupBg} border-b border-slate-200 cursor-pointer transition-colors select-none`}
                    onClick={() => toggleGroup(item.__pathKey)}
                  >
                    {reorderActive && <div />}
                    {selectionActive && <div />}
                    {expandable && <div />}
                    <div className="flex items-center gap-2 px-3" style={{ paddingLeft: `${12 + lvl * 16}px` }}>
                      {item.__collapsed
                        ? <ChevronRight size={13} className="text-slate-400 flex-shrink-0" />
                        : <ChevronDown size={13} className="text-slate-400 flex-shrink-0" />
                      }
                      <span className="text-xs font-semibold text-slate-600 truncate capitalize">{groupLabel}</span>
                      <span className="text-xs text-slate-400 flex-shrink-0">({item.__count})</span>
                    </div>
                    {visibleColumns.slice(1).map(col => (
                      <div key={col.id} className="px-4 text-xs tabular-nums">
                        {sums[col.field] != null && (
                          <span className="font-medium text-slate-500">
                            {sums[col.field].toLocaleString('fr-CA', { maximumFractionDigits: 2 })}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )
              }

              const rowFlash = flashes.size > 0 ? flashes.get(item.id) : null
              // Pendant le flash, on affiche les nouvelles valeurs venues du
              // payload realtime (le store, lui, ne rattrape qu'au prochain poll).
              const renderItem = rowFlash ? { ...item, ...rowFlash.values } : item
              const rowColor = rowColorById.size > 0 ? rowColorById.get(item.id) : undefined
              const rowColorStyle = rowColor ? ROW_COLOR_STYLES[rowColor] : null

              return (
                <div
                  key={vItem.key}
                  data-row-id={item.id}
                  data-row-color={rowColor}
                  style={{
                    position: 'absolute',
                    top: vItem.start,
                    left: 0,
                    right: 0,
                    height: vItem.size,
                    display: 'grid',
                    gridTemplateColumns: gridTemplate,
                    alignItems: 'center',
                    ...(rowColorStyle ? { background: rowColorStyle.bg, boxShadow: `inset 3px 0 0 0 ${rowColorStyle.bar}` } : {}),
                  }}
                  onClick={() => { if (gridMode) return; if (peekEnabled) setPeekItem(item); else if (onRowClick) onRowClick(item); else if (expandable) toggleExpand(item) }}
                  onDoubleClick={gridMode ? (peekEnabled ? () => setPeekItem(item) : (onRowClick ? () => onRowClick(item) : undefined)) : undefined}
                  onDragOver={reorderActive && dragRowId ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverRowId !== item.id) setDragOverRowId(item.id) } : undefined}
                  onDrop={reorderActive && dragRowId ? (e) => { e.preventDefault(); handleRowDrop(item.id) } : undefined}
                  className={`border-b border-slate-100 hover:bg-slate-50${gridMode ? '' : ' cursor-pointer'}${reorderActive && dragRowId === item.id ? ' opacity-40' : ''}${reorderActive && dragOverRowId === item.id && dragRowId && dragRowId !== item.id ? ' bg-brand-50 border-t-2 border-t-brand-400' : ''}${rowClassName ? ` ${rowClassName(item) || ''}` : ''}`}
                >
                  {reorderActive && (
                    <div
                      draggable
                      data-testid={`datatable-row-drag-${item.id}`}
                      onDragStart={e => {
                        setDragRowId(item.id)
                        e.dataTransfer.effectAllowed = 'move'
                        try { e.dataTransfer.setData('text/plain', String(item.id)) } catch {}
                      }}
                      onDragEnd={() => { setDragRowId(null); setDragOverRowId(null) }}
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => e.stopPropagation()}
                      className="flex items-center justify-center h-full text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing"
                    >
                      <GripVertical size={13} />
                    </div>
                  )}
                  {selectionActive && (
                    <div className="flex items-center justify-center px-2" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label="Sélectionner la ligne"
                        checked={selectedIds.has(item.id)}
                        onChange={() => toggleRow(item.id)}
                        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                      />
                    </div>
                  )}
                  {expandable && (
                    <div
                      className="flex items-center justify-center text-slate-400 hover:text-slate-600"
                      onClick={e => { e.stopPropagation(); toggleExpand(item) }}
                      data-testid={`datatable-expand-toggle-${item[rowKey]}`}
                      aria-label={expandedKeys.has(item[rowKey]) ? 'Replier' : 'Déplier'}
                    >
                      {expandedKeys.has(item[rowKey])
                        ? <ChevronDown size={14} />
                        : <ChevronRight size={14} />}
                    </div>
                  )}
                  {visibleColumns.map((col, ci) => {
                    const flashing = rowFlash && rowFlash.fields.has(col.field)
                    if (gridMode) {
                      const ri = rowIndexById.get(item.id)
                      const inSel = gridBounds && ri != null
                        && ri >= gridBounds.minR && ri <= gridBounds.maxR
                        && ci >= gridBounds.minC && ci <= gridBounds.maxC
                      const isActive = sel && sel.focus.rowId === item.id && sel.focus.colId === col.id
                      const editable = isColEditable(col)
                      const isEditing = editingCell && editingCell.rowId === item.id && editingCell.colId === col.id
                      return (
                        <div
                          key={col.id}
                          data-grid-cell={`${item.id}|${col.id}`}
                          onMouseDown={e => {
                            if (e.button !== 0) return
                            const cell = { rowId: item.id, colId: col.id }
                            if (e.shiftKey && sel) setSel(s => ({ anchor: s.anchor, focus: cell }))
                            else setSel({ anchor: cell, focus: cell })
                            focusGrid()
                          }}
                          onDoubleClick={e => { if (editable) { e.stopPropagation(); startEdit(item.id, col.id) } }}
                          className={`relative px-4 text-sm select-none${flashing ? ' dt-cell-flash' : ''}${inSel ? ' bg-brand-50' : ''}${isActive ? ' z-[1] ring-2 ring-inset ring-brand-500' : ''}`}
                        >
                          {isEditing ? (
                            (col.type === 'single_select' || col.type === 'multi_select') ? (
                              <>
                                <span className="block truncate opacity-50">{renderCell(col, renderItem, getDecimals(table, col.field))}</span>
                                <SelectCellEditor
                                  col={col}
                                  value={item[col.field]}
                                  onCommit={(val) => {
                                    const cur = item[col.field]
                                    if (val !== (cur == null ? '' : String(cur))) applyCellChanges([{ row: item, col, value: val }])
                                    setEditingCell(null); focusGrid()
                                  }}
                                  onCancel={() => { setEditingCell(null); focusGrid() }}
                                />
                              </>
                            ) : (
                            <input
                              autoFocus
                              data-testid="datatable-cell-input"
                              value={editValue}
                              onChange={e => setEditValue(e.target.value)}
                              onMouseDown={e => e.stopPropagation()}
                              onClick={e => e.stopPropagation()}
                              onDoubleClick={e => e.stopPropagation()}
                              onBlur={() => commitEdit(null)}
                              onKeyDown={e => {
                                e.stopPropagation()
                                if (e.key === 'Enter') { e.preventDefault(); commitEdit('down') }
                                else if (e.key === 'Tab') { e.preventDefault(); commitEdit(e.shiftKey ? 'left' : 'right') }
                                else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                              }}
                              className="w-full bg-white border border-brand-500 rounded px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                            />
                            )
                          ) : (
                            <span className="block truncate">{renderCell(col, renderItem, getDecimals(table, col.field))}</span>
                          )}
                        </div>
                      )
                    }
                    return (
                      <div key={col.id} className={`px-4 truncate text-sm${flashing ? ' dt-cell-flash' : ''}`}>
                        {renderCell(col, renderItem, getDecimals(table, col.field))}
                      </div>
                    )
                  })}
                  {rowFlash && (
                    <div
                      className="dt-editor-badge"
                      data-editor-badge={rowFlash.actorName}
                      style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', zIndex: 5 }}
                    >
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500 text-white text-[10px] font-medium px-2 py-0.5 shadow-sm whitespace-nowrap">
                        <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
                        {rowFlash.actorName}
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
            </div>
          )}

          {/* Barre de totaux configurable (summary bar à la Airtable). Toujours
              visible (cellules vides cliquables pour ajouter un total), épinglée
              en bas du conteneur scrollable et alignée sur la grille. Les valeurs
              reflètent les lignes filtrées/recherchées (« total courant »). */}
          {!loading && visibleColumns.length > 0 && (
            <div
              data-testid="datatable-footer"
              className="grid border-t border-slate-200 bg-slate-50/95 backdrop-blur-sm sticky bottom-0 z-10"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              {reorderActive && <div aria-hidden />}
              {selectionActive && <div aria-hidden />}
              {expandable && <div aria-hidden />}
              {visibleColumns.map(col => {
                const aggType = footerAggs[col.id]
                const agg = footerValues.get(col.id)
                const formatted = aggType ? formatAggValue(agg, getDecimals(table, col.field)) : ''
                return (
                  <div
                    key={col.id}
                    data-testid={`datatable-footer-cell-${col.id}`}
                    onClick={e => { e.stopPropagation(); setFooterMenu({ col, x: e.clientX, y: e.clientY }) }}
                    className="group/foot relative px-4 py-1.5 text-xs cursor-pointer hover:bg-slate-100 transition-colors flex items-baseline justify-end gap-1.5 overflow-hidden select-none"
                    title="Cliquer pour choisir un total (somme, moyenne, compte, min, max…)"
                  >
                    {aggType ? (
                      <>
                        <span className="text-[10px] uppercase tracking-wide text-slate-400 truncate">{agg?.label}</span>
                        <span className="font-semibold text-slate-700 tabular-nums truncate">{formatted}</span>
                      </>
                    ) : (
                      <span className="text-[10px] text-slate-300 opacity-0 group-hover/foot:opacity-100 transition-opacity inline-flex items-center gap-1">
                        <Sigma size={11} /> Total
                      </span>
                    )}
                  </div>
                )
              })}
              {addCustomField && <div aria-hidden />}
            </div>
          )}

          {footerMenu && (() => {
            const c = footerMenu.col
            const opts = aggOptionsFor(c)
            const current = footerAggs[c.id] || 'none'
            const itemCls = 'flex items-center justify-between gap-3 w-full px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 text-left'
            return (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setFooterMenu(null)} onContextMenu={e => { e.preventDefault(); setFooterMenu(null) }} />
                <div
                  className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[180px]"
                  style={{ top: footerMenu.y - 8, left: footerMenu.x, transform: 'translateY(-100%)' }}
                >
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-slate-400 truncate">{c.label}</div>
                  <button onClick={() => { setColAggregation(c.id, 'none'); setFooterMenu(null) }} className={itemCls}>
                    <span>Aucun</span>{current === 'none' && <Check size={13} className="text-brand-600 flex-shrink-0" />}
                  </button>
                  {opts.map(o => (
                    <button key={o} onClick={() => { setColAggregation(c.id, o); setFooterMenu(null) }} className={itemCls}>
                      <span>{AGG_LABELS[o]}</span>{current === o && <Check size={13} className="text-brand-600 flex-shrink-0" />}
                    </button>
                  ))}
                </div>
              </>
            )
          })()}
        </div>
      </div>

      {peekEnabled && (
        <RecordPeekDrawer
          open={!!peekItem}
          onClose={() => setPeekItem(null)}
          title={resolvePeek('title', peekItem) || ''}
          subtitle={resolvePeek('subtitle', peekItem)}
          to={resolvePeek('to', peekItem)}
          width={peek.width}
        >
          {peekItem && peek.render(peekItem, { close: () => setPeekItem(null) })}
        </RecordPeekDrawer>
      )}
    </div>
  )
}
