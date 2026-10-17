// Helpers partagés entre NovoxpressLabelModal (envois sortants) et
// RetourActionsSection (étiquettes de retour) — extraits pour éviter la
// duplication du choix de boîte / affichage de tarif entre les deux flux.
import { useState } from 'react'
import { Truck } from 'lucide-react'
import { fmtMoney } from '../utils/formatters.js'
import { fmtDate } from '../lib/formatDate.js'

export const BOX_PRESETS = {
  enveloppe: { label: 'Enveloppe (documents légers)', length: '13', width: '10', depth: '1', packagingType: 'envelope' },
  grande:    { label: 'Grande (20 × 20 × 16 po)',  length: '20', width: '20', depth: '16' },
  moyenne:   { label: 'Moyenne (20 × 16 × 8 po)',  length: '20', width: '16', depth: '8'  },
  petite:    { label: 'Petite (15 × 15 × 7 po)',   length: '15', width: '15', depth: '7'  },
  sunshield: { label: 'Sunshield (8 × 6 × 5 po)',  length: '8',  width: '6',  depth: '5'  },
  custom:    { label: 'Personnalisée…',             length: '',   width: '',   depth: ''   },
}

// Choix du type de colis (radios). `dense` = variante compacte du panneau de retour.
export function BoxPresetRadios({ preset, setPreset, dense = false }) {
  return (
    <div className="space-y-2">
      {Object.entries(BOX_PRESETS).map(([key, box]) => (
        <label key={key} className={`flex items-center gap-3 ${dense ? 'p-2.5 text-sm' : 'p-3'} rounded-xl border cursor-pointer transition-colors ${preset === key ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:border-slate-300'}`}>
          <input type="radio" name="preset" value={key} checked={preset === key} onChange={() => setPreset(key)} className="accent-brand-600" />
          {dense ? box.label : <span className="text-sm text-slate-700">{box.label}</span>}
        </label>
      ))}
    </div>
  )
}

// Dimensions personnalisées L × l × H (pouces).
export function CustomDimsInputs({ custom, setCustom, min = '1', step, ariaPrefix }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {[['length', 'longueur'], ['width', 'largeur'], ['depth', 'hauteur']].map(([k, lbl]) => (
        <input key={k} aria-label={ariaPrefix ? `${ariaPrefix} — ${lbl} (po)` : undefined} type="number" min={min} step={step}
          className="input text-center" value={custom[k]} onChange={e => setCustom(c => ({ ...c, [k]: e.target.value }))} />
      ))}
    </div>
  )
}

// Un tarif proposé (service, transporteur, délai, prix) — bouton de sélection.
export function RateChoiceButton({ rate, selected = false, onPick }) {
  return (
    <button
      onClick={onPick}
      className={`w-full text-left p-3 rounded-xl border transition-colors ${selected ? 'border-brand-400 bg-brand-50' : 'border-slate-200 hover:border-brand-400 hover:bg-brand-50'}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium text-slate-900 text-sm">{getRateName(rate)}</p>
          {getRateCarrier(rate) && <p className="text-xs text-slate-500">{getRateCarrier(rate)}</p>}
          {getRateDelivery(rate) && <p className="text-xs text-slate-400 mt-0.5">{getRateDelivery(rate)}</p>}
        </div>
        <span className="font-semibold text-brand-700 whitespace-nowrap">{fmtPrice(rate)}</span>
      </div>
    </button>
  )
}

export function fmtPrice(rate) {
  const val = rate.total?.value ?? rate.total_charge ?? rate.total ?? null
  if (val == null) return '—'
  const currency = rate.total?.currency || 'CAD'
  return fmtMoney(parseFloat(val), currency)
}

export function getRateName(rate) {
  return rate.service_name || rate.name || rate.service_id || 'Service inconnu'
}

export function getRateCarrier(rate) {
  return rate.carrier_name || rate.carrier || ''
}

export function getRateDelivery(rate) {
  const d = rate.expected_delivery_date
  if (d) {
    return fmtDate(new Date(d.year, d.month - 1, d.day))
  }
  if (rate.total_transit_day != null) return `${rate.total_transit_day} jour(s)`
  return null
}

// Libellé d'une adresse candidate de retour : l'adresse + son type
// (Livraison / Facturation / Ferme). `line1` contient déjà souvent la ville :
// on ne la répète pas.
export function addressOptionLabel(a) {
  const line = a.line1 || ''
  const city = a.city && !line.includes(a.city) ? a.city : null
  const addr = [line, city].filter(Boolean).join(', ') || a.postal_code || 'Adresse'
  return a.address_label ? `${addr} — ${a.address_label}` : addr
}

export function DebugDetails({ details }) {
  if (!details) return null
  const { sent, response, responseBody, novoxpressStatus } = details
  const sections = []
  if (sent) sections.push(['Payload envoyé à Novoxpress', sent])
  if (responseBody) sections.push([`Réponse brute Novoxpress${novoxpressStatus ? ` (HTTP ${novoxpressStatus})` : ''}`, responseBody])
  if (response && Object.keys(response).length > 0) sections.push(['Réponse Novoxpress (parsée, hors ratelist)', response])
  if (!sections.length) return null
  return (
    <details className="bg-slate-50 border border-slate-200 rounded-xl text-xs">
      <summary className="cursor-pointer px-3 py-2 font-medium text-slate-700 select-none">
        🔍 Détails techniques (cliquer pour voir)
      </summary>
      <div className="px-3 pb-3 space-y-3">
        {sections.map(([title, content]) => {
          const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
          return (
            <div key={title}>
              <div className="flex items-center justify-between mb-1">
                <span className="font-semibold text-slate-600">{title}</span>
                <button
                  onClick={() => navigator.clipboard.writeText(text).catch(() => {})}
                  className="text-[10px] text-slate-500 hover:text-brand-600 underline"
                  type="button"
                >
                  copier
                </button>
              </div>
              <pre className="bg-white border border-slate-200 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all text-[11px] leading-snug text-slate-800 max-h-60 overflow-y-auto">
                {text}
              </pre>
            </div>
          )
        })}
      </div>
    </details>
  )
}

// Comparaison des tarifs UPS directs, sous la liste Novoxpress. `fetchRates`
// fait l'appel propre au flux (envoi ou retour) ; `outbound` = envoi sortant
// (sinon retour). L'état vit ici : il se vide en quittant l'étape des tarifs.
export function UpsRateComparison({ fetchRates, outbound }) {
  const [ups, setUps] = useState(null) // { rates, customs, environment }
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleCompare() {
    setLoading(true); setError(''); setUps(null)
    try {
      setUps(await fetchRates())
    } catch (e) {
      // Message brut de l'API UPS — jamais un échec silencieux.
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border-t border-slate-100 pt-3 space-y-2" data-testid="ups-rate-comparison">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-700 flex items-center gap-1.5"><Truck size={14} className="text-amber-700" /> Tarifs UPS (direct)</p>
        <button onClick={handleCompare} disabled={loading} className="btn-secondary btn-sm text-xs" data-testid="ups-compare-rates">
          {loading ? 'Interrogation…' : ups ? 'Rafraîchir' : 'Comparer avec UPS'}
        </button>
      </div>
      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 whitespace-pre-wrap break-words" data-testid="ups-rate-error">{error}</p>
      )}
      {ups?.rates?.length > 0 && (
        <>
          {ups.environment !== 'production' && (
            <p className="text-[11px] text-amber-700">Environnement CIE (test) — tarifs indicatifs.</p>
          )}
          <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
            {ups.rates.map(r => (
              <div key={r.service_id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-slate-200 text-sm">
                <div>
                  <p className="font-medium text-slate-800">{r.service_name}</p>
                  <p className="text-xs text-slate-400">
                    UPS{r.negotiated ? ' · tarif négocié' : ''}{r.total_transit_day ? ` · ${r.total_transit_day} jour(s)` : ''}
                  </p>
                </div>
                <span className="font-semibold text-slate-700 whitespace-nowrap">{fmtPrice(r)}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-400">
            {outbound ? "Comparaison seulement — l'achat d'étiquette sortante passe par Novoxpress." : "Comparaison seulement — l'étiquette de retour s'achète via Novoxpress."}
          </p>
        </>
      )}
      {ups?.customs?.length > 0 && (
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer select-none">Déclaration douanière ({outbound ? 'envoi' : 'retour'} hors Canada)</summary>
          <ul className="mt-1 space-y-0.5">
            {ups.customs.map((c, i) => (
              <li key={i}>{c.qty} × {c.description} — {Number(c.unit_value).toFixed(2)} $ · origine {c.origin_country} · SH {c.hs_code}</li>
            ))}
          </ul>
        </details>
      )}
      {ups && !ups.rates?.length && !error && (
        <p className="text-xs text-slate-400">UPS n'a retourné aucun tarif pour {outbound ? 'cet envoi' : 'ce retour'}.</p>
      )}
    </div>
  )
}
