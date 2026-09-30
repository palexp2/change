import { useState } from 'react'
import { AlertTriangle, RefreshCw, CheckCircle2, MapPinOff } from 'lucide-react'
import { Badge } from './Badge.jsx'
import api from '../lib/api.js'
import { useToast } from '../contexts/ToastContext.jsx'

// Rendu partagé du verdict du vérificateur d'adresses postales
// (server/src/services/addressCheck.js) : une pastille de statut + la liste des
// problèmes trouvés. Utilisé par Paramètres → Adresses et par la fiche
// entreprise, pour que le même problème se lise exactement pareil aux deux
// endroits.

const LABEL = { error: 'À corriger', warning: 'À surveiller' }

/** Pastille de statut. Ne rend rien si l'adresse est conforme ou non vérifiée. */
export function AddressCheckBadge({ status, className = '' }) {
  if (status !== 'error' && status !== 'warning') return null
  return (
    <Badge color={status === 'error' ? 'red' : 'orange'} className={className}>
      {LABEL[status]}
    </Badge>
  )
}

/** Liste des problèmes. `issues` = tableau {code, field, severity, message}. */
export function AddressCheckIssues({ issues, className = '' }) {
  const list = Array.isArray(issues) ? issues : []
  if (!list.length) return null
  return (
    <ul className={`space-y-1 ${className}`} data-testid="address-check-issues">
      {list.map((issue, i) => (
        <li
          key={issue.code || i}
          className={`text-xs flex items-start gap-1.5 ${issue.severity === 'error' ? 'text-red-600' : 'text-orange-600'}`}
        >
          <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Bouton « Revérifier » une adresse. Le verdict est déjà recalculé à chaque
 * écriture ; ce bouton sert quand l'adresse a changé par un autre chemin.
 * `onChecked(row)` reçoit la ligne à jour.
 */
export function AddressRecheckButton({ adresseId, onChecked, className = '' }) {
  const [busy, setBusy] = useState(false)
  const { addToast } = useToast()
  if (!adresseId) return null

  async function recheck() {
    setBusy(true)
    try {
      const row = await api.adresses.recheck(adresseId)
      onChecked?.(row)
    } catch (err) {
      addToast({ message: err.message || 'Revérification impossible', type: 'error' })
    } finally { setBusy(false) }
  }

  return (
    <button
      type="button"
      onClick={recheck}
      disabled={busy}
      title="Revérifier l'adresse"
      className={`inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 disabled:opacity-50 ${className}`}
      data-testid="adresse-check-recheck"
    >
      <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
      Revérifier
    </button>
  )
}

/**
 * Bandeau complet du verdict : pastille + problèmes + « Revérifier ».
 * Ne rend rien quand l'adresse est conforme — c'est ce qui fait disparaître le
 * message dès que la correction passe la vérification.
 *
 * `onChecked(row)` reçoit l'adresse à jour après une revérification manuelle.
 */
export function AddressCheckPanel({ adresseId, status, issues, onChecked, className = '' }) {
  const list = parseCheckIssues(issues)
  if (!list.length) return null

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${status === 'error' ? 'border-red-200 bg-red-50' : 'border-orange-200 bg-orange-50'} ${className}`}
      data-testid="adresse-check-panel"
    >
      <div className="flex items-center gap-2 mb-1">
        <AddressCheckBadge status={status} />
        <span className="text-xs text-slate-600">Ne passe pas la vérification</span>
        <AddressRecheckButton adresseId={adresseId} onChecked={onChecked} className="ml-auto" />
      </div>
      <AddressCheckIssues issues={list} />
    </div>
  )
}

// ── Confirmation auprès de l'API d'adresses ──────────────────────────────────
// Complément du vérificateur de forme : les adresses de livraison et de ferme
// sont confirmées auprès de Google (server/src/services/addressConfirm.js).
// Ici on rend le verdict et, quand Google propose une autre écriture, le choix
// « Utiliser / Garder ».

const CONFIRM_FIELDS = { line1: 'Rue', city: 'Ville', province: 'Province', postal_code: 'Code postal', country: 'Pays' }

/** Parse la colonne `confirm_suggestion` (JSON en DB) → { …champs, diff:[] }. */
export function parseSuggestion(raw) {
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(raw || 'null') } catch { return null }
}

/** Adresse proposée, sur une ligne. */
export function formatSuggestion(s) {
  if (!s) return ''
  return [s.line1, s.city, s.province, s.postal_code, s.country].filter(Boolean).join(', ')
}

/** Pastille compacte du verdict de confirmation (listes). Muette si tout va bien. */
export function AddressConfirmBadge({ status, className = '' }) {
  if (status !== 'corrected' && status !== 'not_found') return null
  return (
    <Badge color={status === 'not_found' ? 'orange' : 'blue'} className={className}>
      {status === 'not_found' ? 'Introuvable' : 'À confirmer'}
    </Badge>
  )
}

/**
 * Verdict de la confirmation d'adresse.
 * `status` = 'confirmed' | 'corrected' | 'not_found' | 'incomplete' | 'unavailable'.
 * `onApply(suggestion)` : applique l'écriture proposée. `onRecheck()` : reconfirme.
 * Ne rend rien tant qu'aucune confirmation n'a eu lieu.
 */
export function AddressConfirmPanel({
  status, formatted, suggestion, busy, onApply, onKeep, onRecheck, className = '',
}) {
  const s = parseSuggestion(suggestion)
  if (!status || status === 'skipped' || status === 'incomplete') return null

  if (status === 'confirmed') {
    return (
      <div className={`flex items-center gap-1.5 text-xs text-green-700 ${className}`} data-testid="adresse-confirm-ok">
        <CheckCircle2 size={13} />
        <span>Adresse confirmée</span>
        {formatted && <span className="text-slate-500 truncate">· {formatted}</span>}
      </div>
    )
  }

  if (status === 'unavailable') {
    return (
      <div className={`flex items-center gap-2 text-xs text-slate-500 ${className}`} data-testid="adresse-confirm-unavailable">
        <span>Confirmation indisponible</span>
        {onRecheck && <button type="button" onClick={onRecheck} disabled={busy} className="link-record">Réessayer</button>}
      </div>
    )
  }

  if (status === 'not_found') {
    return (
      <div
        className={`rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 flex items-center gap-2 ${className}`}
        data-testid="adresse-confirm-notfound"
      >
        <MapPinOff size={14} className="text-orange-600 flex-shrink-0" />
        <span className="text-xs text-orange-700">Adresse introuvable</span>
        <div className="ml-auto flex items-center gap-3">
          {onRecheck && <button type="button" onClick={onRecheck} disabled={busy} className="text-xs link-record">Reconfirmer</button>}
          {onKeep && <button type="button" onClick={onKeep} disabled={busy} className="text-xs link-record">Garder</button>}
        </div>
      </div>
    )
  }

  // corrected
  const diff = new Set(s?.diff || [])
  return (
    <div
      className={`rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 ${className}`}
      data-testid="adresse-confirm-suggestion"
    >
      <div className="text-xs text-slate-600 mb-1">Adresse trouvée</div>
      <div className="text-sm text-slate-900">{formatSuggestion(s) || formatted}</div>
      {!!diff.size && (
        <div className="text-xs text-slate-500 mt-0.5">
          Diffère : {[...diff].map(f => CONFIRM_FIELDS[f] || f).join(', ')}
        </div>
      )}
      <div className="flex items-center gap-3 mt-2">
        {s && onApply && (
          <button type="button" onClick={() => onApply(s)} disabled={busy} className="btn-primary py-1 px-2.5 text-xs">
            Utiliser
          </button>
        )}
        {onKeep && (
          <button type="button" onClick={onKeep} disabled={busy} className="text-xs link-record">Garder ma saisie</button>
        )}
        {onRecheck && (
          <button type="button" onClick={onRecheck} disabled={busy} className="text-xs text-slate-500 hover:text-slate-800 ml-auto">
            Reconfirmer
          </button>
        )}
      </div>
    </div>
  )
}

/** Parse la colonne `check_issues` (JSON en DB) en tableau exploitable. */
export function parseCheckIssues(raw) {
  let list = raw
  if (typeof raw === 'string') { try { list = JSON.parse(raw) } catch { list = null } }
  return Array.isArray(list) ? list : []
}

export default AddressCheckIssues
