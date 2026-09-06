import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Check, Zap, Phone, ImageOff, Paperclip } from 'lucide-react'
import { useRecordLinks } from './useRecordLinks.js'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { fmtDateWithFormat, normalizeDateFormat } from './formatDate.js'
import { fmtMoney, fmtNumber } from '../utils/formatters.js'
import { formatDurationSeconds, normalizeDurationFormat } from './duration.js'
import { formatDecimals } from './decimalPrefs.jsx'
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
  return fmtMoney(n, String(currency || 'CAD').trim(), { decimals: d })
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

// Vrai si l'URL pointe (vraisemblablement) vers une image : soit son chemin se
// termine par une extension image connue, soit elle provient d'un hôte de pièces
// jointes connu qui ne met pas d'extension (ex: attachments Airtable, dont le
// champ « Image » est toujours une image). Sert à afficher une vignette plutôt
// qu'un lien brut. Le rendu <img> a de toute façon un fallback onError → lien,
// donc un faux positif reste sans dommage.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|heic|heif)$/i
const IMAGE_HOST_RE = /(?:^|\.)airtableusercontent\.com$/i
// Répertoires same-origin qui ne contiennent QUE des images : le nom de fichier
// y porte normalement une extension, mais on ne veut pas dépendre de ça (des
// copies historiques n'en ont pas).
const IMAGE_PATH_RE = /^\/(?:erp\/)?api\/(?:product-images|attachments\/airtable)\//

// Source utilisable dans un <img> : URL absolue http(s) OU chemin same-origin
// servi par l'app (ex. `/erp/api/product-images/recXXX.jpeg`, les images produit
// stockées dans uploads/). Retourne null si la valeur n'est pas exploitable.
export function imageSrc(value) {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  if (raw.startsWith('/')) return raw
  return normalizeUrl(raw)
}

function isSingleImageUrl(str) {
  const src = imageSrc(str)
  if (!src) return false
  // Chemin same-origin : ni espace ni virgule (les noms de fichiers servis par
  // l'app sont assainis) — sinon « /a.png, /b.png » passerait pour UNE image,
  // son extension finale étant valide (cf. imageSrcList).
  if (src.startsWith('/')) {
    if (/[\s,]/.test(src)) return false
    const p = src.split(/[?#]/)[0]
    return IMAGE_EXT_RE.test(p) || IMAGE_PATH_RE.test(p)
  }
  try {
    const u = new URL(src)
    return IMAGE_EXT_RE.test(u.pathname) || IMAGE_HOST_RE.test(u.hostname)
  } catch {
    return false
  }
}

// Sources d'un champ image. Une cellule peut porter PLUSIEURS images : un champ
// « pièces jointes » Airtable en accepte plusieurs, et la sync les stocke jointes
// par « , » (cf. `convertValue` / `mirrorImageAttachments` côté serveur). On ne
// découpe que si CHAQUE morceau est une URL d'image — sinon la virgule fait
// partie de la valeur et on garde la chaîne entière. Retourne [] si ce n'est pas
// un champ image.
export function imageSrcList(value) {
  if (value == null) return []
  const raw = String(value).trim()
  if (!raw) return []
  if (raw.includes(',')) {
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
    if (parts.length > 1 && parts.every(isSingleImageUrl)) return parts.map(imageSrc)
  }
  return isSingleImageUrl(raw) ? [imageSrc(raw)] : []
}

export function isImageUrl(str) {
  return imageSrcList(str).length > 0
}

// Placeholder compact quand l'image ne charge pas (typiquement une URL de pièce
// jointe Airtable expirée : elles ne vivent que quelques heures). On garde le
// lien d'origine accessible via l'icône, mais on n'étale JAMAIS l'URL brute dans
// la cellule — une colonne « Image » doit montrer une image, pas une adresse.
function ImageUnavailable({ href }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      data-testid="cf-image-unavailable"
      title="Image indisponible — ouvrir le lien d'origine"
      className="inline-flex h-7 w-7 items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 text-slate-300 hover:border-slate-400 hover:text-slate-500"
    >
      <ImageOff size={13} />
    </a>
  )
}

// Affiche une image (champ dont la valeur est une URL / un chemin d'image) sous
// forme de vignette cliquable ouvrant l'original dans un nouvel onglet. En cas
// d'échec de chargement (URL expirée, hôte inaccessible), bascule sur un
// placeholder discret plutôt qu'une image cassée ou l'URL en toutes lettres.
// stopPropagation pour ne pas déclencher la navigation de ligne ni l'entrée en
// mode édition de la cellule (même pattern que UrlValue).
// La hauteur est DÉFINIE (`h-7`) et non un simple plafond (`max-h-7`) : un SVG
// n'a pas de dimensions en pixels, seulement un ratio. Avec hauteur ET largeur en
// `auto`, le navigateur retombe sur la largeur du bloc conteneur — ici un
// `inline-block` qui se dimensionne sur son contenu, donc quelques pixels : les
// vignettes SVG (toute la gamme JWT) sortaient en carrés de 2 px. Hauteur figée,
// la largeur se déduit du ratio, pour le vectoriel comme pour le matriciel.
function ImageThumb({ href }) {
  // Mémorise la source EN ÉCHEC (pas un simple booléen) pour que le placeholder
  // se réinitialise tout seul quand la valeur de la cellule change.
  const [failedSrc, setFailedSrc] = useState(null)
  if (failedSrc === href) return <ImageUnavailable href={href} />
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
        data-testid="cf-image-thumb"
        onError={() => setFailedSrc(href)}
        className="h-7 max-w-[7rem] w-auto rounded border border-slate-200 object-contain bg-white"
      />
    </a>
  )
}

export function ImageValue({ value }) {
  const sources = imageSrcList(value)
  if (!sources.length) {
    const single = imageSrc(value)
    return single ? <ImageThumb href={single} /> : <UrlValue value={value} />
  }
  if (sources.length === 1) return <ImageThumb href={sources[0]} />
  return (
    <span className="inline-flex items-center gap-1">
      {sources.map(src => <ImageThumb key={src} href={src} />)}
    </span>
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
// Champ lien Airtable. Un champ « linked record » d'Airtable est stocké côté
// ERP en type 'text' (la colonne porte l'id du record lié) : `custom_fields.kind
// = 'link'` désigne une TOUTE AUTRE notion — une vraie relation ERP, avec champ
// inverse. Le mapping marque donc ces champs `airtable_link_hint` (cf.
// routes/connectors.js). Sans ça la page des champs les nommait « Texte », alors
// que la colonne « Champ Airtable » affiche déjà leur table cible (« → adresses »).
export function isAirtableLinkField(field) {
  let opts = field?.options
  if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch { return false } }
  return !!opts?.airtable_link_hint
}

// ── Champs lien Airtable ────────────────────────────────────────────────────
//
// Un champ « linked record » d'Airtable arrive dans l'ERP sous forme
// d'identifiants : record IDs Airtable bruts (`recXXXX, recYYYY`) quand le
// mapping n'a pas de table cible, ids ERP quand il en a une (la sync traduit
// alors à l'import — cf. convertValue, airtableAutoSync.js). Affichés tels
// quels, ces champs ne disaient rien à personne.
//
// On les rend donc comme ce qu'ils sont : des liens vers les fiches visées. La
// réconciliation des deux identités (id Boréal ↔ record ID Airtable) se fait
// côté serveur, par le miroir local (server/src/services/recordLinks.js).

// Extrait la liste d'identifiants d'une valeur de champ lien : tableau JSON,
// liste séparée par des virgules, ou identifiant seul.
// `splitCommas` : découper une chaîne simple sur les virgules. Vrai pour des
// identifiants (`recA, recB`), FAUX pour des libellés — « Bouchard, Ferme du
// Nord » est un seul nom d'entreprise, pas deux.
export function parseLinkedKeys(value, { splitCommas = true } = {}) {
  if (value == null || value === '') return []
  let items = value
  if (typeof value === 'string') {
    const raw = value.trim()
    if (raw.startsWith('[')) {
      try { items = JSON.parse(raw) } catch { items = splitCommas ? raw.split(',') : [raw] }
    } else {
      items = splitCommas ? raw.split(',') : [raw]
    }
  }
  if (!Array.isArray(items)) items = [items]
  return items.map(v => String(v ?? '').trim()).filter(Boolean)
}

// Rendu d'une valeur de champ lien : une pastille par enregistrement visé,
// cliquable vers sa fiche. Les enregistrements dont la table Airtable n'est pas
// miroitée dans l'ERP (Boîtes, Mois, Change log…) restent en pastille inerte —
// mieux qu'un lien mort, et sans perdre l'information qu'il y a bien un lien.
// `byLabel` : la colonne porte le NOM de la fiche visée et non son identifiant
// (cas d'un champ natif qu'on a demandé à afficher en « Lien vers … »). Le
// serveur cherche alors aussi par libellé dans la table cible.
export function LinkedRecordsValue({ field, value, byLabel = false, detail = false }) {
  const keys = useMemo(() => parseLinkedKeys(value, { splitCommas: !byLabel }), [value, byLabel])
  const resolved = useRecordLinks(keys, field?.record_link_target || null, byLabel)
  if (!keys.length) return <span className="text-slate-400">—</span>
  const title = resolved.map((r, i) => (r ? [r.label, r.sub].filter(Boolean).join(' · ') : keys[i])).join(', ')
  // Dans une FICHE, un champ lien s'affiche comme le lien d'entreprise en haut de
  // la fiche commande : la même pastille, celle de <LinkedRecordField>, en
  // lecture seule. Un seul rendu de lien pour toutes les fiches — avant, un champ
  // lien Airtable sortait en pastille grise minuscule à côté de pastilles pleine
  // taille, dans la même carte. La cellule de tableau, elle, garde sa pastille
  // compacte : sa hauteur de ligne est fixe (lignes virtualisées).
  if (detail) {
    return (
      <div className="flex flex-wrap items-center gap-1.5" title={title} data-testid="cf-linked-records">
        {keys.map((key, i) => {
          const rec = resolved[i]
          const label = rec === undefined
            ? '…'
            : (rec?.label || (byLabel || key.length <= 12 ? key : `${key.slice(0, 8)}…`))
          return (
            <LinkedRecordField
              key={key}
              value={key}
              options={[{ id: key, name: label }]}
              labelFn={o => o.name}
              getHref={rec?.url ? () => rec.url : undefined}
              disabled
              allowClear={false}
            />
          )
        })}
      </div>
    )
  }
  // Une seule ligne, sans retour à la ligne : la hauteur de ligne d'une cellule
  // de DataTable est fixe (lignes virtualisées) — même règle que multi_select.
  return (
    <div className="flex items-center gap-1 overflow-hidden" title={title} data-testid="cf-linked-records">
      {keys.map((key, i) => {
        const rec = resolved[i]
        if (rec === undefined) {
          // Résolution en cours — placeholder de la largeur d'une pastille.
          return (
            <span key={key} className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-400">
              …
            </span>
          )
        }
        if (!rec || !rec.label) {
          // Rien derrière la clé. Un libellé se lit très bien tel quel : on le
          // laisse en texte plutôt que de le tronquer en pastille grise.
          return (
            <span
              key={key}
              data-testid="cf-linked-unresolved"
              title={byLabel
                ? `${key} — aucune fiche de cette table ne porte ce nom`
                : `${key} — aucune fiche trouvée derrière cet identifiant`}
              className={byLabel
                ? 'truncate text-slate-600'
                : 'shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500 whitespace-nowrap'}
            >
              {byLabel || key.length <= 12 ? key : `${key.slice(0, 8)}…`}
            </span>
          )
        }
        const chip = (
          <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] whitespace-nowrap">
            {rec.label}
          </span>
        )
        if (!rec.url) return <span key={key} className="shrink-0 text-slate-600">{chip}</span>
        return (
          <Link
            key={key}
            to={rec.url}
            onClick={e => e.stopPropagation()}
            data-testid="cf-linked-record-link"
            className="shrink-0 text-brand-600 hover:underline"
          >
            {chip}
          </Link>
        )
      })}
    </div>
  )
}

// ── Champs « Attachement » ──────────────────────────────────────────────────
//
// La cellule porte un tableau JSON de descripteurs de fichiers, écrit par la
// route dédiée (server/src/routes/custom-field-files.js) :
//   [{ id, name, size, type }]
// Les octets ne transitent jamais par la valeur : ils se servent par URL, d'où
// attachmentFileUrl() ci-dessous.

export function parseAttachments(value) {
  if (Array.isArray(value)) return value.filter(f => f && typeof f.id === 'string')
  if (value == null || value === '') return []
  const str = String(value).trim()
  if (!str.startsWith('[')) return []
  try {
    const arr = JSON.parse(str)
    return Array.isArray(arr) ? arr.filter(f => f && typeof f.id === 'string') : []
  } catch { return [] }
}

// URL de service d'un fichier. Le token passe en query param : un <img src> ou
// un <a href> ne peut pas porter d'en-tête Authorization (cf. CLAUDE.md,
// middleware requireAuth). `download` force la sauvegarde plutôt que l'affichage.
export function attachmentFileUrl(fieldId, recordId, fileId, { download = false } = {}) {
  if (!fieldId || !recordId || !fileId) return null
  const token = localStorage.getItem('erp_token') || ''
  const qs = new URLSearchParams({ token })
  if (download) qs.set('download', '1')
  return `/erp/api/custom-field-files/${encodeURIComponent(fieldId)}/${encodeURIComponent(recordId)}/${encodeURIComponent(fileId)}?${qs}`
}

const ATTACHMENT_IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|heic|heif)$/i
export function isImageAttachment(file) {
  return !!(file && (String(file.type || '').startsWith('image/') || ATTACHMENT_IMAGE_RE.test(file.name || '')))
}

// Taille lisible — « 1,2 Mo ». Retourne null si la taille est inconnue.
export function formatFileSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return null
  if (n < 1024) return `${n} o`
  if (n < 1024 * 1024) return `${fmtNumber(n / 1024, { maximumFractionDigits: 0 })} ko`
  return `${fmtNumber(n / (1024 * 1024), { maximumFractionDigits: 1 })} Mo`
}

// Une pièce jointe : vignette pour une image, pastille « trombone + nom » sinon.
// Le clic ouvre le fichier dans un nouvel onglet (jamais la fiche de la ligne).
export function AttachmentChip({ href, file, compact = false }) {
  const [failed, setFailed] = useState(false)
  const title = [file.name, formatFileSize(file.size)].filter(Boolean).join(' · ')
  if (isImageAttachment(file) && !failed) {
    // Hauteur définie plutôt que plafonnée, même raison que ImageThumb : sinon
    // une pièce jointe SVG (sans dimensions en pixels) se réduit à quelques px.
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title={title} className="inline-block shrink-0">
        <img
          src={href}
          alt={file.name || ''}
          loading="lazy"
          data-testid="cf-attachment-thumb"
          onError={() => setFailed(true)}
          className={`${compact ? 'h-7' : 'h-14'} max-w-[7rem] w-auto rounded border border-slate-200 object-contain bg-white`}
        />
      </a>
    )
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      title={title}
      data-testid="cf-attachment-chip"
      className="inline-flex shrink-0 items-center gap-1 max-w-[12rem] rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600 hover:border-brand-300 hover:text-brand-700"
    >
      <Paperclip size={11} className="shrink-0 opacity-70" />
      <span className="truncate">{file.name || 'fichier'}</span>
    </a>
  )
}

// Rendu lecture seule d'un champ Attachement (cellule de tableau, fiche).
// `field` doit porter son `id` et `row` son `id` : sans eux on ne sait pas
// construire l'URL du fichier, on retombe alors sur un simple décompte.
export function AttachmentsValue({ field, value, row, compact = true }) {
  const files = parseAttachments(value)
  if (!files.length) return <span className="text-slate-400">—</span>
  const recordId = row?.id
  if (!field?.id || !recordId) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
        <Paperclip size={11} className="opacity-70" />{files.length}
      </span>
    )
  }
  return (
    <div className="flex items-center gap-1 overflow-hidden" data-testid="cf-attachments">
      {files.map(f => (
        <AttachmentChip key={f.id} file={f} compact={compact} href={attachmentFileUrl(field.id, recordId, f.id)} />
      ))}
    </div>
  )
}

export function parseSelectChoices(field) {
  if (!field?.options) return []
  let opts = field.options
  if (typeof opts === 'string') {
    try { opts = JSON.parse(opts) } catch { return [] }
  }
  return Array.isArray(opts?.choices) ? opts.choices : []
}

// Valeurs d'un champ multi_select, quelle que soit la forme stockée : tableau
// déjà parsé, chaîne JSON (`["a","b"]` — forme produite par le sync Airtable et
// par les éditeurs de l'app) ou texte libre séparé par des virgules (valeurs
// saisies avant que le champ ne devienne une sélection multiple).
export function parseMultiSelectItems(value) {
  if (Array.isArray(value)) return value.map(v => String(v ?? '').trim()).filter(Boolean)
  if (value == null || value === '') return []
  const str = String(value)
  if (str.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(str)
      if (Array.isArray(arr)) return arr.map(v => String(v ?? '').trim()).filter(Boolean)
    } catch { /* chaîne non-JSON : traitée comme du texte libre ci-dessous */ }
  }
  return str.split(',').map(s => s.trim()).filter(Boolean)
}

// Format d'affichage ('h:mm' / 'h:mm:ss') d'un champ de type duration, lu depuis
// sa config `options` (JSON). Défaut 'h:mm'.
export function durationFormatOf(field) {
  let opts = field?.options
  if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch { opts = null } }
  return normalizeDurationFormat(opts?.format)
}

// Format d'affichage d'un champ date (data/formula/lookup/rollup), lu depuis
// sa config `options` (JSON) — voir DATE_DISPLAY_FORMATS. Défaut 'iso_date'
// (comportement historique, rétro-compatible avec les champs créés avant ce réglage).
export function dateFormatOf(field) {
  let opts = field?.options
  if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch { opts = null } }
  return normalizeDateFormat(opts?.format)
}

// Couleur (palette Badge) associée à un label de choix. Défaut 'gray' si le
// label ne correspond à aucun choix configuré (ex: valeur héritée hors-liste).
function colorForChoice(choices, label) {
  const c = choices.find(ch => ch.label === label)
  return c?.color || 'gray'
}

// Miroir client de ALLOWED_TABLES (server/src/routes/custom-fields.js) : tables
// pour lesquelles DataTable affiche le « + » d'ajout de champ custom en mode
// auto-géré. Tenir les deux listes alignées. Ce sont des VRAIES tables SQL —
// les clés de vue DataTable qui portent un autre nom passent par
// sqlTableForView ci-dessous. 'company_serials' (jointure embarquée de la fiche
// entreprise, sans table propre) n'y figure pas : pas de champ custom possible.
export const CUSTOM_FIELD_TABLES = new Set([
  'projects', 'factures',
  'companies', 'contacts', 'products', 'orders', 'tickets', 'tasks',
  'shipments', 'employees', 'purchases', 'achats_fournisseurs',
  'returns', 'sale_receipts', 'serial_numbers', 'interactions',
  'order_items', 'subscriptions', 'return_items', 'adresses',
  'soumissions', 'assemblages', 'paies', 'paie_items', 'bom_items',
  'payments', 'serial_state_changes',
])

// Clés de vue DataTable dont la table SQL sous-jacente porte un autre nom.
// Les vues/pills/colonnes visibles restent stockées sous la clé de vue ; les
// champs custom (custom_fields) et leurs routes sont indexés par vraie table
// SQL. Miroir serveur : VIEW_KEY_TO_SQL_TABLE (server/src/routes/views.js).
const VIEW_KEY_TO_SQL_TABLE = {
  retours: 'returns',
  abonnements: 'subscriptions',
  // Articles d'un envoi (EnvoisDetail) : ce sont des order_items, mais avec
  // leurs propres vues/colonnes visibles, séparées du tableau Articles de la
  // fiche commande.
  shipment_items: 'order_items',
  // Envois d'une commande (OrderDetail) : ce sont des shipments, mais avec
  // leurs propres vues/colonnes visibles, séparées de la page /envois.
  order_envois: 'shipments',
  // Envois expédiés à une adresse (AdresseDetail) : mêmes shipments, vues et
  // colonnes visibles propres à la fiche adresse.
  adresse_envois: 'shipments',
  // Articles d'un retour (RetourDetail) : lignes `return_items`, dont la clé de
  // vue est francisée comme le reste du domaine retours.
  retour_items: 'return_items',
}
export function sqlTableForView(viewKey) {
  return VIEW_KEY_TO_SQL_TABLE[viewKey] || viewKey
}

// ── Clé de CHAMPS d'une clé de vue ──────────────────────────────────────────
//
// Un tableau encastré dans une fiche (les Envois d'une entreprise, les Commandes
// d'une entreprise…) porte sa propre clé de vue : ses colonnes visibles, ses
// largeurs et son tri lui appartiennent, et changer la vue du tableau encastré
// ne doit pas toucher celle de la page dédiée — c'est voulu.
//
// Mais ce sont les MÊMES enregistrements, donc les mêmes CHAMPS : un envoi n'a
// pas un jeu de champs « vu depuis l'entreprise » et un autre « vu depuis
// /envois ». La définition des champs (libellé, type, suppression) est donc
// toujours celle de la table canonique — une seule page /champs, un seul
// stockage. Sans cette table de correspondance, « Configurer les champs » depuis
// une fiche ouvrait une page vide-ish propre à la clé encastrée, et un renommage
// n'y valait que là.
//
// Ce que la clé de vue garde : vues/pills, colonnes visibles, largeurs, tri.
// Ce que la clé de champs porte : /champs/:table, libellés, types, suppressions.
const VIEW_KEY_TO_FIELD_KEY = {
  // Fiche entreprise
  company_contacts:    'contacts',
  company_orders:      'orders',
  company_tickets:     'tickets',
  company_factures:    'factures',
  company_abonnements: 'abonnements',
  company_envois:      'shipments',
  company_tasks:       'tasks',
  company_achats:      'achats_fournisseurs',
  company_retours:     'retours',
  company_serials:     'serial_numbers',
  // Fiche projet
  project_factures:    'factures',
  project_soumissions: 'soumissions',
  // Fiche contact
  contact_tasks:       'tasks',
  // Fiche produit (pièce)
  product_achats:      'purchases',
  // Fiches commande / adresse / envoi
  order_envois:        'shipments',
  adresse_envois:      'shipments',
  shipment_items:      'order_items',
  // Fiche retour : les articles n'ont pas de page dédiée, la table canonique de
  // leurs champs est donc `return_items` (/champs/return_items). Conséquence
  // voulue : les 46 champs Airtable de la table sont PROPOSÉS dans le sélecteur
  // de champs sans s'afficher d'office (cf. columnsWithOwnCf, DataTable.jsx).
  retour_items:        'return_items',
}
export function fieldKeyForView(viewKey) {
  return VIEW_KEY_TO_FIELD_KEY[viewKey] || viewKey
}

// Colonne DataTable dérivée d'un champ custom — mapping partagé entre les pages
// câblées manuellement (Pipeline, Factures) et le mode auto-géré de DataTable.
export function customFieldToColumn(f) {
  return {
    id: f.column_name,
    label: f.name,
    field: f.column_name,
    // Texte d'aide → « ? » survolable dans l'en-tête de colonne (DataTable).
    ...(f.description ? { description: f.description } : {}),
    type: customFieldColumnType(f),
    // Type RÉEL du champ, pour l'affichage seul (icône de type dans le panneau
    // « Champs »). `type` ci-dessus est le type de colonne DataTable, volontairement
    // grossier (une devise et une formule numérique y sont toutes deux 'number') :
    // il pilote filtre/tri/édition et ne doit pas changer.
    // Champ lien Airtable : son type stocké est 'text' (la colonne porte des
    // identifiants), mais c'est un lien — icône et libellé doivent le dire.
    fieldType: isAirtableLinkField(f) ? 'link' : (f.kind && f.kind !== 'data' ? f.kind : f.type),
    // Champ lien : la cellule ne s'édite pas au clavier mais par associations /
    // dissociations — pastilles avec « × » + liste recherchable de la table
    // cible (cf. components/LinkCellEditor.jsx). `record_link_target` peut rester
    // nul (table Airtable non miroitée) : l'éditeur déduit alors la table des
    // liens déjà posés, et à défaut ne permet que de dissocier. Un LOOKUP qui
    // rapatrie un lien (`record_link`) porte la métadonnée sans être éditable
    // pour autant — c'est un calcul.
    ...((isAirtableLinkField(f) || f.record_link)
      ? {
        linkMulti: isAirtableLinkField(f),
        linkTarget: f.record_link_target || null,
        linkIdentity: f.record_link_identity || null,
      }
      : {}),
    // Select : on expose les choix au filtre (FilterRow) et à l'éditeur inline.
    ...((f.type === 'single_select' || f.type === 'multi_select')
      ? { options: parseSelectChoices(f), selectChoices: parseSelectChoices(f) }
      : {}),
    // Durée : format d'affichage (h:mm / h:mm:ss) pour DynamicCell.
    ...(f.type === 'duration' ? { durationFormat: durationFormatOf(f) } : {}),
    // Nombre : décimales du champ → la barre de totaux (somme, moyenne…) suit le
    // même réglage que les cellules.
    ...(Number.isInteger(f.decimals) ? { decimals: f.decimals } : {}),
    // Bouton : action sur la ligne, pas une valeur → ni groupable, ni triable,
    // ni filtrable, ni éditable.
    // Bouton : action sur la ligne. Attachement : une liste de fichiers, dont
    // ni le tri ni le regroupement ni le filtre texte ne veulent rien dire.
    groupable: f.type !== 'button' && f.type !== 'attachment',
    sortable: f.type !== 'button' && f.type !== 'attachment',
    filterable: f.type !== 'button' && f.type !== 'attachment',
    // Seuls les champs kind='data' ÉDITABLES sont éditables (mode tableur de
    // DataTable, actif uniquement si la page fournit onCellEdit). Les champs
    // virtuels (formula/lookup/auto/button) sont calculés à la lecture →
    // lecture seule. `writable` vient du serveur (règle d'éditabilité unique,
    // services/customFieldWritability.js) : un champ Airtable en import seul
    // est en lecture seule — l'écriture serait écrasée au prochain sync.
    // Attachement : la valeur ne se tape pas — les fichiers se déposent depuis
    // la fiche (panneau latéral), qui écrit la cellule par sa route dédiée.
    editable: f.type !== 'button' && f.type !== 'attachment' && (!f.kind || f.kind === 'data') && f.writable !== false,
    // Flag pour l'UI (toast explicatif au double-clic) : la cellule est en
    // lecture seule PARCE QUE le champ est importé d'Airtable en sens 'pull'.
    ...(f.writable === false ? { airtablePullReadonly: true } : {}),
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
  // Attachement : type dédié, ni triable ni filtrable — la cellule liste des
  // fichiers, pas une valeur comparable.
  if (f.type === 'attachment') return 'attachment'
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
// `detail` = rendu pour une FICHE (et non une cellule de tableau) : les champs
// lien y prennent la pastille pleine taille commune à toutes les fiches.
export function renderCustomFieldValue(field, value, row, { detail = false } = {}) {
  // Bouton : action sur la ligne, pas une valeur — rendu en premier (pas de
  // notion de valeur vide). Nécessite `row.id` pour cibler le record.
  if (field.type === 'button') return <ButtonFieldCell field={field} row={row} />
  // La VUE n'a pas pu calculer ce champ (colonne source disparue, etc.) — on
  // affiche #ERROR pour toute la colonne plutôt qu'un « — » trompeur.
  if (field?.view_error) return <CustomFieldError detail={field.view_error} />
  // Attachement : vignettes / pastilles de fichiers, cliquables. Rendu avant le
  // test « valeur vide » pour garder un « — » cohérent (AttachmentsValue s'en charge).
  if (field.type === 'attachment') return <AttachmentsValue field={field} value={value} row={row} />
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
    // Une seule ligne : ce rendu ne sert que dans une cellule de DataTable, dont
    // la hauteur est fixe (lignes virtualisées). Un `flex-wrap` faisait déborder
    // les pastilles hors de la ligne, par-dessus l'en-tête et les lignes
    // voisines. On garde donc `flex-nowrap` + `shrink-0` (les pastilles ne se
    // compressent pas les unes sur les autres) et on laisse la cellule rogner,
    // comme Airtable. Le titre au survol donne la liste complète.
    return (
      <div className="flex items-center gap-1 overflow-hidden" title={items.join(', ')}>
        {items.map((v, i) => <Badge key={i} color={colorForChoice(choices, v)} className="shrink-0 whitespace-nowrap">{v}</Badge>)}
      </div>
    )
  }
  if (value == null || value === '') return <span className="text-slate-400">—</span>
  // Valeur = identifiant(s) d'enregistrement → liens vers les fiches visées.
  // Deux cas : un champ lien Airtable, ou un champ que le serveur signale comme
  // référence (`record_link`) — typiquement un LOOKUP qui rapatrie un champ lien
  // ou une colonne FK : la valeur copiée reste un id, donc elle reste navigable.
  if (isAirtableLinkField(field) || field.record_link) {
    return <LinkedRecordsValue field={field} value={value} detail={detail} />
  }
  if (field.type === 'duration') {
    const n = Number(value)
    if (!Number.isFinite(n)) return <span className="text-slate-400">—</span>
    return <span className="tabular-nums text-slate-700">{formatDurationSeconds(n, durationFormatOf(field))}</span>
  }
  if (field.type === 'single_select') {
    const choices = parseSelectChoices(field)
    return <Badge color={colorForChoice(choices, value)}>{value}</Badge>
  }
  if (field.type === 'date' || field.result_type === 'date') {
    return <span className="text-slate-500">{fmtDateWithFormat(value, dateFormatOf(field))}</span>
  }
  if (field.type === 'currency') {
    const formatted = formatCurrency(value, field.decimals ?? 2, currencyCodeOf(field))
    return <span className="tabular-nums text-slate-700">{formatted != null ? formatted : value}</span>
  }
  // Nombre : nombre de décimales FIXE, celui du champ (réglage du modal de champ,
  // ou précision Airtable publiée par le serveur). Un champ nombre sans réglage
  // suit le défaut que le modal affiche (2) — avant, la cellule rendait la
  // valeur brute (« 1.26666666666667 ») quel que soit le réglage. Les champs
  // calculés à résultat numérique ne sont formatés que s'ils portent un réglage.
  if (field.type === 'number' || field.result_type === 'number') {
    const d = Number.isInteger(field.decimals) ? Math.max(0, Math.min(5, field.decimals)) : (field.type === 'number' ? 2 : null)
    const formatted = formatDecimals(value, d)
    if (formatted != null) return <span className="tabular-nums text-slate-700">{formatted}</span>
  }
  // Champ URL / texte dont la valeur est une image → vignette (fallback lien si
  // le chargement échoue). Couvre le champ « Image » (attachments Airtable) qui
  // affichait auparavant l'URL brute au lieu de l'image.
  if ((field.type === 'url' || field.type === 'text' || field.result_type === 'url') && isImageUrl(value)) {
    return <ImageValue value={value} />
  }
  // Champ URL, ou champ calculé (formule/lookup/rollup) dont le type d'affichage
  // choisi est « URL » : lien cliquable si la valeur est une adresse valide,
  // texte simple sinon (UrlValue s'en charge).
  if (field.type === 'url' || field.result_type === 'url') return <UrlValue value={value} />
  if (field.type === 'phone') return <PhoneValue value={value} countryCode={phoneCountryCodeOf(field)} />
  return <span className="text-slate-700">{value}</span>
}
