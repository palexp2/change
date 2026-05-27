import { useState } from 'react'
import { ChevronRight, CheckCircle, Download, Package, AlertTriangle } from 'lucide-react'
import api from '../lib/api.js'
import { localISODate } from '../lib/formatDate.js'

const BOX_PRESETS = {
  enveloppe: { label: 'Enveloppe (documents légers)', length: '13', width: '10', depth: '1', packagingType: 'envelope' },
  grande:    { label: 'Grande (20 × 20 × 16 po)',  length: '20', width: '20', depth: '16' },
  moyenne:   { label: 'Moyenne (20 × 16 × 8 po)',  length: '20', width: '16', depth: '8'  },
  petite:    { label: 'Petite (15 × 15 × 7 po)',   length: '15', width: '15', depth: '7'  },
  sunshield: { label: 'Sunshield (8 × 6 × 5 po)',  length: '8',  width: '6',  depth: '5'  },
  custom:    { label: 'Personnalisée…',             length: '',   width: '',   depth: ''   },
}

function fmtPrice(rate) {
  const val = rate.total?.value ?? rate.total_charge ?? rate.total ?? null
  if (val == null) return '—'
  const currency = rate.total?.currency || 'CAD'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(parseFloat(val))
}

function getRateName(rate) {
  return rate.service_name || rate.name || rate.service_id || 'Service inconnu'
}

function getRateCarrier(rate) {
  return rate.carrier_name || rate.carrier || ''
}

function getRateDelivery(rate) {
  const d = rate.expected_delivery_date
  if (d) {
    return new Date(d.year, d.month - 1, d.day).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' })
  }
  if (rate.total_transit_day != null) return `${rate.total_transit_day} jour(s)`
  return null
}

const PICKUP_LOCATIONS = [
  { value: 'OutsideDoor', label: 'Porte extérieure' },
  { value: 'FrontDoor',   label: 'Porte avant' },
  { value: 'BackDoor',    label: 'Porte arrière' },
  { value: 'SideDoor',    label: 'Porte côté' },
  { value: 'Mailroom',    label: 'Salle de courrier' },
  { value: 'Office',      label: 'Bureau' },
  { value: 'Reception',   label: 'Réception' },
]

function getDefaultPickupDate() {
  const d = new Date()
  if (d.getHours() >= 14) d.setDate(d.getDate() + 1)
  if (d.getDay() === 6) d.setDate(d.getDate() + 2)
  if (d.getDay() === 0) d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Fenêtre de ramassage ASAP, dans les heures d'ouverture 9h–16h, jours
// ouvrables. Si on est encore dans la journée avant 15h, on tente aujourd'hui
// (ready_at = heure courante + 1h, min 9h). Sinon, prochain jour ouvrable 9h–16h.
function computeAsapPickupWindow() {
  const now = new Date()
  const d = new Date(now)
  if (d.getHours() >= 15) d.setDate(d.getDate() + 1)
  if (d.getDay() === 6) d.setDate(d.getDate() + 2)
  if (d.getDay() === 0) d.setDate(d.getDate() + 1)
  const isToday = d.toDateString() === now.toDateString()
  const readyHour = isToday ? Math.max(9, now.getHours() + 1) : 9
  return {
    date: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() },
    ready_at: { hour: readyHour, minute: 0 },
    ready_until: { hour: 16, minute: 0 },
  }
}

function DebugDetails({ details }) {
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

export default function NovoxpressLabelModal({ envoi, orderItemsTotalWeight, onClose, onDone }) {
  const [step, setStep] = useState('package') // 'package' | 'rates' | 'confirm' | 'done' | 'pickup' | 'pickup-done'
  const [preset, setPreset] = useState('moyenne')
  const [qty, setQty] = useState(1)
  const [totalWeight, setTotalWeight] = useState(
    orderItemsTotalWeight > 0 ? orderItemsTotalWeight.toFixed(2) : '1'
  )
  const [custom, setCustom] = useState({ length: '', width: '', depth: '' })
  const [declaredValue, _setDeclaredValue] = useState('1')
  const [rates, setRates] = useState([])
  const [requestId, setRequestId] = useState(null)
  const [selectedRate, setSelectedRate] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [errorDetails, setErrorDetails] = useState(null) // { sent, responseBody, response } pour debug
  const [result, setResult] = useState(null)
  const [pickupDate, setPickupDate] = useState(getDefaultPickupDate)
  const [pickupReadyAt, setPickupReadyAt] = useState('09:00')
  const [pickupReadyUntil, setPickupReadyUntil] = useState('17:00')
  const [pickupLocation, setPickupLocation] = useState('OutsideDoor')
  const [pickupInstructions, setPickupInstructions] = useState('')
  const [pickupResult, setPickupResult] = useState(null)
  const [autoPickup, setAutoPickup] = useState(true)
  const [autoPickupError, setAutoPickupError] = useState(null)

  const isEnvelope = BOX_PRESETS[preset]?.packagingType === 'envelope'
  const effectiveQty = isEnvelope ? 1 : qty
  const effectiveWeight = isEnvelope ? '1' : totalWeight  // Novoxpress exige un poids ≥ 1 même pour enveloppe

  function buildPackages() {
    const p = BOX_PRESETS[preset]
    const length = preset === 'custom' ? custom.length : p.length
    const width  = preset === 'custom' ? custom.width  : p.width
    const depth  = preset === 'custom' ? custom.depth  : p.depth
    const perBox = effectiveQty > 0
      ? String(Math.max(1, Math.ceil(parseFloat(effectiveWeight) / effectiveQty)))
      : String(Math.max(1, Math.ceil(parseFloat(effectiveWeight))))
    return [{
      quantity: String(effectiveQty),
      weight: String(perBox),
      length: String(length),
      width: String(width),
      depth: String(depth),
    }]
  }

  function packagingType() {
    return BOX_PRESETS[preset]?.packagingType || 'package'
  }

  async function handleGetRates() {
    if (!isEnvelope && (!totalWeight || parseFloat(totalWeight) <= 0)) {
      setError('Entrez un poids total valide'); return
    }
    if (preset === 'custom' && (!custom.length || !custom.width || !custom.depth)) {
      setError('Entrez toutes les dimensions de la boîte'); return
    }
    setError('')
    setErrorDetails(null)
    setLoading(true)
    setStep('rates')
    const sentPayload = {
      packaging_type: packagingType(),
      packages: buildPackages(),
      declared_value: declaredValue || '1'
    }
    try {
      const res = await api.novoxpress.getRates(envoi.id, sentPayload)
      setRequestId(res.request_id)
      setRates(res.rates || [])
      // Si l'API renvoie 0 tarifs, on garde quand même les diagnostics pour
      // affichage (warnings/errors Novoxpress éventuels + payload envoyé).
      if (!res.rates?.length) {
        setErrorDetails({ sent: res.sent || sentPayload, response: res.response || null, responseBody: null })
      }
    } catch (e) {
      setError(e.message)
      setErrorDetails({
        sent: e.details?.sent || sentPayload,
        responseBody: e.details?.responseBody || null,
        novoxpressStatus: e.details?.novoxpressStatus || null,
      })
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirm() {
    setLoading(true)
    setError('')
    setErrorDetails(null)
    const sentPayload = {
      request_id: requestId,
      service_id: selectedRate.service_id,
      carrier_name: getRateCarrier(selectedRate) || null,
      service_name: getRateName(selectedRate) || null,
      packaging_type: packagingType(),
      packages: buildPackages(),
      declared_value: declaredValue || '1'
    }
    try {
      const res = await api.novoxpress.createLabel(envoi.id, sentPayload)
      setResult(res)

      if (autoPickup) {
        const window = computeAsapPickupWindow()
        try {
          const pickup = await api.novoxpress.schedulePickup(envoi.id, {
            ...window,
            quantity: effectiveQty,
            weight: effectiveWeight,
            pickup_location: 'OutsideDoor',
          })
          setPickupResult(pickup)
        } catch (pickupErr) {
          setAutoPickupError(pickupErr.message || 'Échec de la planification du ramassage')
        }
      }

      setStep('done')
      onDone?.()
    } catch (e) {
      setError(e.message)
      setErrorDetails({
        sent: e.details?.sent || sentPayload,
        responseBody: e.details?.responseBody || null,
        novoxpressStatus: e.details?.novoxpressStatus || null,
      })
    } finally {
      setLoading(false)
    }
  }

  // ── Step: package ──
  if (step === 'package') return (
    <div className="space-y-4">
      <div>
        <label className="label">Type de colis</label>
        <div className="space-y-2">
          {Object.entries(BOX_PRESETS).map(([key, box]) => (
            <label key={key} className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${preset === key ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:border-slate-300'}`}>
              <input type="radio" name="preset" value={key} checked={preset === key} onChange={() => setPreset(key)} className="accent-brand-600" />
              <span className="text-sm text-slate-700">{box.label}</span>
            </label>
          ))}
        </div>
      </div>

      {preset === 'custom' && (
        <div>
          <label className="label">Dimensions (pouces) — L × l × H</label>
          <div className="grid grid-cols-3 gap-2">
            <input type="number" min="1" className="input text-center" placeholder="Long." value={custom.length} onChange={e => setCustom(c => ({ ...c, length: e.target.value }))} />
            <input type="number" min="1" className="input text-center" placeholder="Larg." value={custom.width}  onChange={e => setCustom(c => ({ ...c, width: e.target.value }))} />
            <input type="number" min="1" className="input text-center" placeholder="Haut." value={custom.depth}  onChange={e => setCustom(c => ({ ...c, depth: e.target.value }))} />
          </div>
        </div>
      )}

      {!isEnvelope && (
        <>
          <div>
            <label className="label">Poids total (lbs)</label>
            <input
              type="number" min="0.1" step="0.1"
              className="input"
              value={totalWeight}
              onChange={e => setTotalWeight(e.target.value)}
              placeholder="ex. 2.5"
            />
            {orderItemsTotalWeight > 0 && (
              <p className="text-xs text-slate-400 mt-1">
                Calculé depuis les articles : {orderItemsTotalWeight.toFixed(2)} lbs
              </p>
            )}
          </div>
          <div>
            <label className="label">Nombre de colis</label>
            <input
              type="number" min="1" step="1"
              className="input"
              value={qty}
              onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))}
            />
          </div>
        </>
      )}

      <div className="pt-1 border-t border-slate-100">
        <label className="flex items-start gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoPickup}
            onChange={e => setAutoPickup(e.target.checked)}
            className="mt-0.5 accent-brand-600"
          />
          <div className="flex-1">
            <span className="text-sm font-medium text-slate-700">Commander un ramassage automatiquement</span>
            <p className="text-xs text-slate-500 mt-0.5">
              À l'achat de l'étiquette, un ramassage du transporteur sélectionné sera programmé au plus tôt (9h–16h, jours ouvrables).
            </p>
          </div>
        </label>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button onClick={onClose} className="btn-secondary">Annuler</button>
        <button onClick={handleGetRates} className="btn-primary flex items-center gap-1.5">
          Obtenir les tarifs <ChevronRight size={14} />
        </button>
      </div>
    </div>
  )

  // ── Step: rates ──
  if (step === 'rates') return (
    <div className="space-y-4">
      {loading ? (
        <div className="flex flex-col items-center justify-center py-12 gap-3 text-slate-500">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
          <span className="text-sm">Récupération des tarifs…</span>
        </div>
      ) : error ? (
        <div className="space-y-4">
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3 whitespace-pre-wrap break-words">{error}</p>
          <DebugDetails details={errorDetails} />
          <div className="flex justify-between">
            <button onClick={() => { setStep('package'); setError(''); setErrorDetails(null) }} className="btn-secondary">← Retour</button>
          </div>
        </div>
      ) : rates.length === 0 ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-500 text-center py-4">Aucun tarif disponible pour cet envoi.</p>
          <DebugDetails details={errorDetails} />
          <button onClick={() => { setStep('package'); setErrorDetails(null) }} className="btn-secondary">← Retour</button>
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-500">Sélectionnez le service souhaité :</p>
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {rates.map((rate, i) => (
              <button
                key={rate.service_id || i}
                onClick={() => { setSelectedRate(rate); setStep('confirm') }}
                className="w-full text-left p-3 rounded-xl border border-slate-200 hover:border-brand-400 hover:bg-brand-50 transition-colors"
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
            ))}
          </div>
          <button onClick={() => setStep('package')} className="btn-secondary text-sm">← Retour</button>
        </>
      )}
    </div>
  )

  // ── Step: confirm ──
  if (step === 'confirm') return (
    <div className="space-y-4">
      <div className="bg-slate-50 rounded-xl p-4 space-y-3 text-sm">
        <h3 className="font-semibold text-slate-900">Récapitulatif</h3>
        <div className="grid grid-cols-2 gap-2 text-slate-600">
          <span className="text-slate-400">Service</span>
          <span className="font-medium text-slate-900">{getRateName(selectedRate)}</span>
          {getRateCarrier(selectedRate) && <>
            <span className="text-slate-400">Transporteur</span>
            <span>{getRateCarrier(selectedRate)}</span>
          </>}
          <span className="text-slate-400">Tarif</span>
          <span className="font-semibold text-brand-700">{fmtPrice(selectedRate)}</span>
          <span className="text-slate-400">{isEnvelope ? 'Type' : 'Boîte'}</span>
          <span>{BOX_PRESETS[preset]?.label || 'Personnalisée'}{isEnvelope ? '' : ` × ${qty}`}</span>
          {!isEnvelope && <>
            <span className="text-slate-400">Poids total</span>
            <span>{totalWeight} lbs</span>
          </>}
          <span className="text-slate-400">Destinataire</span>
          <span>{envoi.company_name || '—'}</span>
        </div>
      </div>
      {(() => {
        const isIntl = envoi.address_country && envoi.address_country !== 'CA'
        if (!isIntl) return null
        const totalValue = (envoi.order_items || []).reduce((s, i) => s + (i.unit_cost || 0) * (i.qty || 0), 0)
        return (
          <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-800 space-y-1">
            <p className="font-semibold">Envoi international — facture commerciale incluse automatiquement</p>
            <p>Produit déclaré : <span className="font-medium">Intelligent greenhouse thermostat</span></p>
            <p>Code HS : <span className="font-mono">9032.10.0030</span> · Origine : Canada · Raison : Permanent</p>
            <p>Valeur déclarée : <span className="font-medium">{new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(Math.ceil(totalValue))}</span></p>
            <p className="text-blue-600">Note : les coordonnées de votre broker doivent être configurées dans votre compte Novoxpress.</p>
          </div>
        )
      })()}
      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
        Cette action va facturer l'étiquette sur votre compte Novoxpress.
        {autoPickup && (() => {
          const w = computeAsapPickupWindow()
          const dateStr = new Date(w.date.year, w.date.month - 1, w.date.day)
            .toLocaleDateString('fr-CA', { weekday: 'short', day: 'numeric', month: 'short' })
          const carrier = getRateCarrier(selectedRate) || 'le transporteur'
          return <span><br />Un ramassage <strong>{carrier}</strong> sera également planifié le <strong>{dateStr}</strong> entre <strong>{String(w.ready_at.hour).padStart(2, '0')}h00</strong> et <strong>{String(w.ready_until.hour).padStart(2, '0')}h00</strong>.</span>
        })()}
      </p>
      {error && (
        <>
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3 whitespace-pre-wrap break-words">{error}</p>
          <DebugDetails details={errorDetails} />
        </>
      )}
      <div className="flex justify-between gap-3 pt-2">
        <button onClick={() => { setStep('rates'); setError(''); setErrorDetails(null) }} disabled={loading} className="btn-secondary">← Retour</button>
        <button onClick={handleConfirm} disabled={loading} className="btn-primary flex items-center gap-1.5">
          {loading
            ? <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> Création…</>
            : <><CheckCircle size={14} /> Confirmer et acheter</>
          }
        </button>
      </div>
    </div>
  )

  // ── Step: done — propose pickup ──
  if (step === 'done') return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
          <CheckCircle size={28} className="text-green-600" />
        </div>
        <h3 className="font-semibold text-slate-900 text-lg">Étiquette créée !</h3>
        {result?.tracking_id && (
          <p className="text-sm text-slate-600">
            N° de suivi : <span className="font-mono font-semibold text-slate-900">{result.tracking_id}</span>
          </p>
        )}
      </div>
      <a
        href={result?.label_url}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-secondary w-full flex items-center justify-center gap-2"
      >
        <Download size={15} /> Télécharger l'étiquette PDF
      </a>
      {pickupResult ? (
        <div className="border border-green-200 bg-green-50 rounded-xl p-4 space-y-1">
          <p className="text-sm font-semibold text-green-900 flex items-center gap-1.5">
            <Package size={14} /> Ramassage planifié
          </p>
          {pickupResult.pickup_id && (
            <p className="text-xs text-green-800">
              ID : <span className="font-mono">{pickupResult.pickup_id}</span>
            </p>
          )}
          {(() => {
            const w = computeAsapPickupWindow()
            const dateStr = new Date(w.date.year, w.date.month - 1, w.date.day)
              .toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long' })
            return (
              <p className="text-xs text-green-700">
                {dateStr} · {String(w.ready_at.hour).padStart(2, '0')}h00–{String(w.ready_until.hour).padStart(2, '0')}h00 · Porte extérieure
              </p>
            )
          })()}
        </div>
      ) : autoPickupError ? (
        <div className="border-2 border-red-300 bg-red-50 rounded-xl p-4 space-y-2">
          <p className="text-sm font-semibold text-red-900 flex items-center gap-1.5">
            <AlertTriangle size={16} /> Le ramassage automatique a échoué
          </p>
          <p className="text-xs text-red-800 whitespace-pre-wrap break-words">{autoPickupError}</p>
          <p className="text-xs text-red-700">
            L'étiquette est bien achetée, mais aucun coursier ne viendra. Planifiez le ramassage manuellement ou réessayez plus tard.
          </p>
          <button onClick={() => setStep('pickup')} className="btn-primary text-xs flex items-center gap-1.5">
            <Package size={12} /> Planifier le ramassage manuellement
          </button>
        </div>
      ) : (
        <>
          <div className="border border-brand-200 bg-brand-50 rounded-xl p-4 space-y-1">
            <p className="text-sm font-semibold text-brand-900">Planifier un ramassage ?</p>
            <p className="text-xs text-brand-700">Souhaitez-vous qu'un coursier vienne récupérer le colis ?</p>
          </div>
          <div className="flex gap-3">
            <button onClick={onClose} className="btn-secondary flex-1">Non merci</button>
            <button onClick={() => setStep('pickup')} className="btn-primary flex-1 flex items-center justify-center gap-1.5">
              <Package size={14} /> Oui, planifier
            </button>
          </div>
        </>
      )}
      {pickupResult && (
        <button onClick={onClose} className="btn-primary w-full">Fermer</button>
      )}
    </div>
  )

  // ── Step: pickup ──
  if (step === 'pickup') {
    async function handleSchedulePickup() {
      setLoading(true)
      setError('')
      try {
        const [year, month, day] = pickupDate.split('-').map(Number)
        const [rH, rM] = pickupReadyAt.split(':').map(Number)
        const [uH, uM] = pickupReadyUntil.split(':').map(Number)
        const res = await api.novoxpress.schedulePickup(envoi.id, {
          date: { year, month, day },
          ready_at: { hour: rH, minute: rM },
          ready_until: { hour: uH, minute: uM },
          quantity: effectiveQty,
          weight: effectiveWeight,
          pickup_location: pickupLocation,
          pickup_instructions: pickupInstructions || undefined,
        })
        setPickupResult(res)
        setStep('pickup-done')
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }

    return (
      <div className="space-y-4">
        <h3 className="font-semibold text-slate-900">Planifier un ramassage</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label">Date de ramassage</label>
            <input type="date" className="input" value={pickupDate} onChange={e => setPickupDate(e.target.value)} min={localISODate()} />
          </div>
          <div>
            <label className="label">Prêt à partir de</label>
            <input type="time" className="input" value={pickupReadyAt} onChange={e => setPickupReadyAt(e.target.value)} />
          </div>
          <div>
            <label className="label">Prêt jusqu'à</label>
            <input type="time" className="input" value={pickupReadyUntil} onChange={e => setPickupReadyUntil(e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="label">Emplacement du colis</label>
            <select className="select" value={pickupLocation} onChange={e => setPickupLocation(e.target.value)}>
              {PICKUP_LOCATIONS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <label className="label">Instructions (optionnel)</label>
            <input type="text" className="input" value={pickupInstructions} onChange={e => setPickupInstructions(e.target.value)} placeholder="ex. Sonner à la porte arrière" />
          </div>
        </div>
        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>}
        <div className="flex justify-between gap-3 pt-2">
          <button onClick={onClose} className="btn-secondary">Passer</button>
          <button onClick={handleSchedulePickup} disabled={loading || !pickupDate} className="btn-primary flex items-center gap-1.5">
            {loading
              ? <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> Envoi…</>
              : <><CheckCircle size={14} /> Confirmer le ramassage</>
            }
          </button>
        </div>
      </div>
    )
  }

  // ── Step: pickup-done ──
  if (step === 'pickup-done') return (
    <div className="space-y-4 text-center">
      <div className="flex flex-col items-center gap-3 py-4">
        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
          <CheckCircle size={28} className="text-green-600" />
        </div>
        <h3 className="font-semibold text-slate-900 text-lg">Ramassage planifié !</h3>
        {pickupResult?.pickup_id && (
          <p className="text-sm text-slate-500">
            ID : <span className="font-mono text-slate-700">{pickupResult.pickup_id}</span>
          </p>
        )}
      </div>
      <button onClick={onClose} className="btn-secondary w-full">Fermer</button>
    </div>
  )

  return null
}
