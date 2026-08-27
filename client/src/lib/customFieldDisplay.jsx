import { useState } from 'react'
import { ExternalLink, Check, Zap, Phone } from 'lucide-react'
import { fmtDate } from './formatDate.js'
import { formatDurationSeconds, normalizeDurationFormat } from './duration.js'
import { Badge } from '../components/Badge.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import api from './api.js'

// Helpers de rendu partagés pour les champs personnalisés (custom fields).
// Centralise le formatage « currency » et « url » pour qu'il soit identique
// entre les tables qui affichent les champs custom en lecture seule (Factures)
// et celles avec édition inline (Pipeline). Voir CLAUDE.md → « Champs
// personnalisés » : Currency = nombre au format monétaire ; URL = lien cliquable.

// Format monétaire fr-CA. `decimals` borné 0..5 (défaut 2), `currency` = code
// ISO 4217 (défaut CAD — rétro-compatible avec les champs devise sans options).
export function formatCurrency(value, decimals = 2, currency = 'CAD') {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const d = Number.isInteger(decimals) ? Math.max(0, Math.min(5, decimals)) : 2
  const opts = { style: 'currency', minimumFractionDigits: d, maximumFractionDigits: d }
  const code = String(currency || 'CAD').trim().toUpperCase()
  try {
    return n.toLocaleString('fr-CA', { ...opts, currency: code })
  } catch {
    // Code inconnu d'Intl (donnée héritée / invalide) → repli CAD plutôt que crash.
    return n.toLocaleString('fr-CA', { ...opts, currency: 'CAD' })
  }
}

// Code de devise (ISO 4217) d'un champ de type currency, lu depuis sa config
// `options` (JSON). Défaut CAD (champs créés avant le choix de devise).
export function currencyCodeOf(field) {
  let opts = field?.options
  if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch { opts = null } }
  const code = String(opts?.currency || '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : 'CAD'
}

// Valide une URL http(s). On accepte aussi les URLs sans schéma (ex.
// « exemple.com ») en testant un préfixe https:// — utile pour les saisies
// rapides. Retourne l'URL normalisée (avec schéma) ou null si invalide.
export function normalizeUrl(str) {
  if (str == null) return null
  const raw = String(str).trim()
  if (!raw) return null
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const u = new URL(candidate)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    // Doit avoir un hostname avec un point (évite que « bonjour » devienne un lien).
    if (!u.hostname.includes('.')) return null
    return candidate
  } catch {
    return null
  }
}

export function isValidUrl(str) {
  return normalizeUrl(str) != null
}

// Vrai si l'URL pointe (vraisemblablement) vers une image : soit son chemin se
// termine par une extension image connue, soit elle provient d'un hôte de pièces
// jointes connu qui ne met pas d'extension (ex: attachments Airtable, dont le
// champ « Image » est toujours une image). Sert à afficher une vignette plutôt
// qu'un lien brut. Le rendu <img> a de toute façon un fallback onError → lien,
// donc un faux positif reste sans dommage.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|heic|heif)$/i
const IMAGE_HOST_RE = /(?:^|\.)airtableusercontent\.com$/i
export function isImageUrl(str) {
  const href = normalizeUrl(str)
  if (!href) return false
  try {
    const u = new URL(href)
    return IMAGE_EXT_RE.test(u.pathname) || IMAGE_HOST_RE.test(u.hostname)
  } catch {
    return false
  }
}

// Affiche une image (champ dont la valeur est une URL d'image) sous forme de
// vignette cliquable ouvrant l'original dans un nouvel onglet. En cas d'échec de
// chargement (URL expirée, hôte inaccessible), bascule sur un lien texte plutôt
// qu'une image cassée. stopPropagation pour ne pas déclencher la navigation de
// ligne ni l'entrée en mode édition de la cellule (même pattern que UrlValue).
export function ImageValue({ value }) {
  const [failed, setFailed] = useState(false)
  const href = normalizeUrl(value)
  if (!href || failed) return <UrlValue value={value} />
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      className="inline-block"
      title="Ouvrir l'image"
    >
      <img
        src={href}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="max-h-7 max-w-[7rem] w-auto rounded border border-slate-200 object-contain bg-white"
      />
    </a>
  )
}

// Config d'affichage de l'indicatif de pays d'un champ téléphone :
//   'auto' — comportement historique (10 chiffres sans indicatif, 11 chiffres
//            commençant par 1 → +1) ; défaut des appels sans option.
//   'show' — toujours afficher l'indicatif +1 sur les numéros nord-américains.
//   'hide' — ne jamais afficher l'indicatif (les numéros NANP en 11 chiffres
//            perdent leur « +1 »).
// Les numéros internationaux (avec « + » hors NANP) gardent toujours leur
// indicatif : sans table des indicatifs, on ne peut pas le retirer de façon
// fiable. Défaut des champs custom : 'hide' (cf. phoneCountryCodeOf).

// Lit la préférence d'indicatif de pays d'un champ téléphone depuis `options`
// (JSON) : { country_code: 'show' | 'hide' }. Défaut 'hide' — les numéros
// s'affichent sans indicatif, cohérent avec les champs téléphone natifs.
export function phoneCountryCodeOf(field) {
  let opts = field?.options
  if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch { opts = null } }
  return opts?.country_code === 'show' ? 'show' : 'hide'
}

// Formate un numéro de téléphone pour l'affichage. Formats reconnus :
//   - 10 chiffres (NANP)          → (514) 123-4567
//   - 11 chiffres commençant par 1 → +1 (514) 123-4567
//   - international avec « + »     → +33 1 23 45 67 89 (espaces normalisés)
// `countryCode` ('auto' | 'show' | 'hide') pilote l'affichage de l'indicatif de
// pays sur les numéros nord-américains (voir ci-dessus).
// Une extension en fin de saisie (« x123 », « ext 123 », « poste 123 », « #123 »)
// est préservée en suffixe « poste 123 ». Retourne null si le numéro ne
// correspond à aucun format connu (l'appelant affiche alors la valeur brute).
export function formatPhoneNumber(str, { countryCode = 'auto' } = {}) {
  if (str == null) return null
  const raw = String(str).trim()
  if (!raw) return null
  // Détache l'extension éventuelle avant de compter les chiffres.
  let main = raw
  let ext = null
  const extMatch = raw.match(/(?:ext\.?|x|poste|#)\s*:?\s*(\d{1,6})\s*$/i)
  if (extMatch) { ext = extMatch[1]; main = raw.slice(0, extMatch.index).replace(/[\s,;-]+$/, '') }
  const hasPlus = main.startsWith('+')
  const digits = main.replace(/\D/g, '')
  let formatted = null
  if (digits.length === 10 && !hasPlus) {
    const national = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    formatted = countryCode === 'show' ? `+1 ${national}` : national
  } else if (digits.length === 11 && digits[0] === '1') {
    const national = `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
    formatted = countryCode === 'hide' ? national : `+1 ${national}`
  } else if (hasPlus && digits.length >= 8 && digits.length <= 15) {
    // International hors NANP : on garde le groupement saisi, en normalisant
    // les séparateurs en espaces (ex: « +33 1 23 45 67 89 »). L'indicatif ne
    // peut pas être retiré de façon fiable → conservé quel que soit `countryCode`.
    formatted = '+' + main.slice(1).replace(/[^\d]+/g, ' ').trim().replace(/ +/g, ' ')
  }
  if (!formatted) return null
  return ext ? `${formatted} poste ${ext}` : formatted
}

// Href tel: correspondant (chiffres seuls, +1 implicite pour les 10 chiffres
// NANP). Retourne null si la valeur ne ressemble pas à un numéro composable.
export function phoneHref(str) {
  if (str == null) return null
  let main = String(str).trim()
  const extMatch = main.match(/(?:ext\.?|x|poste|#)\s*:?\s*(\d{1,6})\s*$/i)
  if (extMatch) main = main.slice(0, extMatch.index)
  const hasPlus = main.trim().startsWith('+')
  const digits = main.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  if (digits.length === 10 && !hasPlus) return `tel:+1${digits}`
  return `tel:${hasPlus ? '+' : ''}${digits}`
}

// Numéro de téléphone : affiché formaté (ou brut si non reconnu) et cliquable
// (tel:) quand composable. stopPropagation pour ne pas déclencher la navigation
// de ligne ni l'entrée en mode édition de la cellule (même pattern que UrlValue).
export function PhoneValue({ value, countryCode = 'auto' }) {
  if (value == null || value === '') return null
  const display = formatPhoneNumber(value, { countryCode }) ?? String(value)
  const href = phoneHref(value)
  if (!href) return <span className="text-slate-700 truncate">{display}</span>
  return (
    <a
      href={href}
      onClick={e => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700 hover:underline truncate tabular-nums"
      title={display}
    >
      <Phone size={12} className="shrink-0 opacity-70" />
      <span className="truncate">{display}</span>
    </a>
  )
}

// Lien cliquable pour un champ de type URL. stopPropagation pour ne pas
// déclencher la navigation de ligne ni l'entrée en mode édition de la cellule.
export function UrlValue({ value }) {
  const href = normalizeUrl(value)
  if (!href) return <span className="text-slate-700 truncate">{value}</span>
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700 hover:underline truncate"
      title={href}
    >
      <span className="truncate">{String(value)}</span>
      <ExternalLink size={12} className="shrink-0 opacity-70" />
    </a>
  )
}

// Badge #ERROR (style Airtable) pour un champ custom dont la VUE n'a pas pu être
// régénérée — typiquement une formule/lookup/rollup qui référence une colonne
// supprimée ou renommée. Le détail de l'erreur est en tooltip. À distinguer
// d'une valeur vide (« — »).
export function CustomFieldError({ detail }) {
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold bg-red-50 text-red-700 border border-red-200 cursor-help"
      title={detail || 'Champ invalide : une colonne référencée est introuvable.'}
    >
      #ERROR
    </span>
  )
}

// Parse la config des choix d'un champ single_select / multi_select. `options`
// est stocké en JSON (string) côté serveur : { choices:[{id,label,color}], … }.
// Tolère un objet déjà parsé. Retourne le tableau de choix (vide si absent).
export function parseSelectChoices(field) {
  if (!field?.options) return []
  let opts = field.options
  if (typeof opts === 'string') {
    try { opts = JSON.parse(opts) } catch { return [] }
  }
  return Array.isArray(opts?.choices) ? opts.choices : []
}

// Format d'affichage ('h:mm' / 'h:mm:ss') d'un champ de type duration, lu depuis
// sa config `options` (JSON). Défaut 'h:mm'.
export function durationFormatOf(field) {
  let opts = field?.options
  if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch { opts = null } }
  return normalizeDurationFormat(opts?.format)
}

// Couleur (palette Badge) associée à un label de choix. Défaut 'gray' si le
// label ne correspond à aucun choix configuré (ex: valeur héritée hors-liste).
function colorForChoice(choices, label) {
  const c = choices.find(ch => ch.label === label)
  return c?.color || 'gray'
}

// Miroir client de ALLOWED_TABLES (server/src/routes/custom-fields.js) : tables
// pour lesquelles DataTable affiche le « + » d'ajout de champ custom en mode
// auto-géré. Tenir les deux listes alignées.
export const CUSTOM_FIELD_TABLES = new Set([
  'projects', 'factures',
  'companies', 'contacts', 'products', 'orders', 'tickets', 'tasks',
  'shipments', 'employees', 'purchases', 'achats_fournisseurs',
  'returns', 'sale_receipts', 'serial_numbers', 'interactions',
  'order_items', 'abonnements', 'retours', 'return_items', 'adresses',
  'soumissions', 'assemblages', 'paies', 'paie_items', 'bom_items', 'company_serials',
  'payments', 'serial_state_changes',
])

// Colonne DataTable dérivée d'un champ custom — mapping partagé entre les pages
// câblées manuellement (Pipeline, Factures) et le mode auto-géré de DataTable.
export function customFieldToColumn(f) {
  return {
    id: f.column_name,
    label: f.name,
    field: f.column_name,
    type: customFieldColumnType(f),
    // Select : on expose les choix au filtre (FilterRow) et à l'éditeur inline.
    ...((f.type === 'single_select' || f.type === 'multi_select')
      ? { options: parseSelectChoices(f), selectChoices: parseSelectChoices(f) }
      : {}),
    // Durée : format d'affichage (h:mm / h:mm:ss) pour DynamicCell.
    ...(f.type === 'duration' ? { durationFormat: durationFormatOf(f) } : {}),
    // Bouton : action sur la ligne, pas une valeur → ni groupable, ni triable,
    // ni filtrable, ni éditable.
    groupable: f.type !== 'button',
    sortable: f.type !== 'button',
    filterable: f.type !== 'button',
    // Seuls les champs kind='data' sont éditables (mode tableur de DataTable,
    // actif uniquement si la page fournit onCellEdit). Les champs virtuels
    // (formula/lookup/auto/button) sont calculés à la lecture → lecture seule.
    editable: f.type !== 'button' && (!f.kind || f.kind === 'data'),
    render: row => renderCustomFieldValue(f, row[f.column_name], row),
  }
}

// Type de colonne DataTable dérivé d'un champ custom — centralisé pour rester
// cohérent entre les tables qui exposent les champs custom (Pipeline, Factures).
// Les select renvoient leur propre type pour que le filtre/éditeur les reconnaisse.
export function customFieldColumnType(f) {
  // Bouton : action sur la ligne, pas une valeur — type dédié non éditable et
  // non filtrable/triable/groupable (cf. mapping de colonne dans les pages).
  if (f.type === 'button') return 'button'
  if (f.result_type === 'date') return 'date'
  if (f.type === 'duration') return 'duration'
  // Checkbox → 'boolean' : aligne le filtre (opérateurs is_true/is_false) et
  // l'éditeur inline (toggle) déjà câblés pour ce type de colonne.
  if (f.type === 'checkbox') return 'boolean'
  if (f.result_type === 'number' || f.type === 'number' || f.type === 'currency') return 'number'
  if (f.type === 'single_select') return 'single_select'
  if (f.type === 'multi_select') return 'multi_select'
  return 'text'
}

// Vrai/faux d'une valeur de checkbox, tolérant les formes héritées (1, true,
// '1', '1.0', cast SQLite). Centralisé pour le rendu et l'éditeur inline.
export function isCheckboxTruthy(value) {
  return value === 1 || value === true || value === '1' || value === '1.0' || Number(value) === 1
}

// Parse la config d'un champ de type 'button' ({ label, automation_id, style }).
export function parseButtonOptions(field) {
  let opts = field?.options
  if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch { opts = {} } }
  return {
    label: opts?.label || field?.name || 'Exécuter',
    automation_id: opts?.automation_id || '',
    style: opts?.style || 'brand',
  }
}

// Classes Tailwind par style de bouton (alignées sur BUTTON_STYLES côté serveur).
const BUTTON_STYLE_CLS = {
  brand: 'bg-brand-50 text-brand-700 border-brand-200 hover:bg-brand-100',
  green: 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100',
  red:   'bg-red-50 text-red-700 border-red-200 hover:bg-red-100',
  slate: 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200',
}

// Cellule d'un champ « Bouton » : déclenche l'automation câblée sur le record de
// la ligne au clic. Auto-suffisant (toast + spinner + stopPropagation) pour être
// réutilisable dans toute DataTable / fiche détail sans câblage par la page.
export function ButtonFieldCell({ field, row }) {
  const { addToast } = useToast()
  const [running, setRunning] = useState(false)
  const { label, automation_id, style } = parseButtonOptions(field)
  const cls = BUTTON_STYLE_CLS[style] || BUTTON_STYLE_CLS.brand

  async function handleClick(e) {
    e.stopPropagation()
    if (running || !row?.id) return
    if (!automation_id) { addToast({ message: 'Bouton non configuré', type: 'error' }); return }
    setRunning(true)
    try {
      await api.customFields.runButton(field.id, row.id)
      addToast({ message: `${label} : déclenché`, type: 'success' })
    } catch (err) {
      addToast({ message: err.message || 'Échec du déclenchement', type: 'error' })
    } finally {
      setRunning(false)
    }
  }

  return (
    <button
      type="button"
      data-testid="cf-button-cell"
      onClick={handleClick}
      disabled={running}
      title={`Déclencher : ${label}`}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors disabled:opacity-60 ${cls}`}
    >
      {running
        ? <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
        : <Zap size={12} />}
      <span className="truncate">{label}</span>
    </button>
  )
}

// Rendu lecture seule d'une valeur de champ custom selon son type/résultat.
// `field` = ligne custom_fields { type, result_type, decimals, view_error, options }.
// `row`   = la ligne complète (nécessaire pour les boutons : action sur le record).
export function renderCustomFieldValue(field, value, row) {
  // Bouton : action sur la ligne, pas une valeur — rendu en premier (pas de
  // notion de valeur vide). Nécessite `row.id` pour cibler le record.
  if (field.type === 'button') return <ButtonFieldCell field={field} row={row} />
  // La VUE n'a pas pu calculer ce champ (colonne source disparue, etc.) — on
  // affiche #ERROR pour toute la colonne plutôt qu'un « — » trompeur.
  if (field?.view_error) return <CustomFieldError detail={field.view_error} />
  // checkbox : case stylée lecture seule (cochée = ✓ sur fond brand, décochée =
  // case vide). Rendu AVANT le test « valeur vide » : NULL/0 = décoché légitime,
  // pas un « — ».
  if (field.type === 'checkbox') {
    const on = isCheckboxTruthy(value)
    return (
      <span
        data-testid="cf-checkbox-cell"
        data-checked={on ? '1' : '0'}
        className={`inline-flex h-4 w-4 items-center justify-center rounded border ${on ? 'bg-brand-500 border-brand-500 text-white' : 'border-slate-300 bg-white'}`}
      >
        {on && <Check size={12} strokeWidth={3} />}
      </span>
    )
  }
  // multi_select : tableau JSON de labels rendus en pastilles colorées.
  if (field.type === 'multi_select') {
    let items = value
    if (typeof value === 'string') { try { items = JSON.parse(value) } catch { items = value ? [value] : [] } }
    if (!Array.isArray(items)) items = value != null && value !== '' ? [items] : []
    if (!items.length) return <span className="text-slate-400">—</span>
    const choices = parseSelectChoices(field)
    return (
      <div className="flex gap-1 flex-wrap">
        {items.map((v, i) => <Badge key={i} color={colorForChoice(choices, v)}>{v}</Badge>)}
      </div>
    )
  }
  if (value == null || value === '') return <span className="text-slate-400">—</span>
  if (field.type === 'duration') {
    const n = Number(value)
    if (!Number.isFinite(n)) return <span className="text-slate-400">—</span>
    return <span className="tabular-nums text-slate-700">{formatDurationSeconds(n, durationFormatOf(field))}</span>
  }
  if (field.type === 'single_select') {
    const choices = parseSelectChoices(field)
    return <Badge color={colorForChoice(choices, value)}>{value}</Badge>
  }
  if (field.result_type === 'date') return <span className="text-slate-500">{fmtDate(value)}</span>
  if (field.type === 'currency') {
    const formatted = formatCurrency(value, field.decimals ?? 2, currencyCodeOf(field))
    return <span className="tabular-nums text-slate-700">{formatted != null ? formatted : value}</span>
  }
  // Champ URL / texte dont la valeur est une image → vignette (fallback lien si
  // le chargement échoue). Couvre le champ « Image » (attachments Airtable) qui
  // affichait auparavant l'URL brute au lieu de l'image.
  if ((field.type === 'url' || field.type === 'text') && isImageUrl(value)) {
    return <ImageValue value={value} />
  }
  if (field.type === 'url') return <UrlValue value={value} />
  if (field.type === 'phone') return <PhoneValue value={value} countryCode={phoneCountryCodeOf(field)} />
  return <span className="text-slate-700">{value}</span>
}
