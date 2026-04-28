import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Pencil, Printer, ChevronRight, CheckCircle, Download, Package, Mail, XCircle, FileText, X } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { fmtDate } from '../lib/formatDate.js'


function fmtCurrency(v) {
  if (v == null) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(v)
}

const STATUS_COLORS = { 'À envoyer': 'yellow', 'Envoyé': 'green' }

// ── Novoxpress label creation modal ──────────────────────────────────────────

const BOX_PRESETS = {
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
  // If past 14h, default to tomorrow
  if (d.getHours() >= 14) d.setDate(d.getDate() + 1)
  // Skip weekends
  if (d.getDay() === 6) d.setDate(d.getDate() + 2)
  if (d.getDay() === 0) d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

function CreateLabelModal({ envoi, orderItemsTotalWeight, onClose, onDone }) {
  const [step, setStep] = useState('package') // 'package' | 'rates' | 'confirm' | 'done' | 'pickup'
  const [preset, setPreset] = useState('moyenne')
  const [qty, setQty] = useState(1)
  const [totalWeight, setTotalWeight] = useState(
    orderItemsTotalWeight > 0 ? orderItemsTotalWeight.toFixed(2) : ''
  )
  const [custom, setCustom] = useState({ length: '', width: '', depth: '' })
  const [declaredValue, _setDeclaredValue] = useState('1')
  const [rates, setRates] = useState([])
  const [requestId, setRequestId] = useState(null)
  const [selectedRate, setSelectedRate] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [pickupDate, setPickupDate] = useState(getDefaultPickupDate)
  const [pickupReadyAt, setPickupReadyAt] = useState('09:00')
  const [pickupReadyUntil, setPickupReadyUntil] = useState('17:00')
  const [pickupLocation, setPickupLocation] = useState('OutsideDoor')
  const [pickupInstructions, setPickupInstructions] = useState('')
  const [pickupResult, setPickupResult] = useState(null)

  function buildPackages() {
    const p = BOX_PRESETS[preset]
    const length = preset === 'custom' ? custom.length : p.length
    const width  = preset === 'custom' ? custom.width  : p.width
    const depth  = preset === 'custom' ? custom.depth  : p.depth
    const perBox = qty > 0 ? String(Math.ceil(parseFloat(totalWeight) / qty)) : String(Math.ceil(parseFloat(totalWeight)))
    return [{
      quantity: String(qty),
      weight: String(perBox),
      length: String(length),
      width: String(width),
      depth: String(depth),
    }]
  }

  async function handleGetRates() {
    if (!totalWeight || parseFloat(totalWeight) <= 0) { setError('Entrez un poids total valide'); return }
    if (preset === 'custom' && (!custom.length || !custom.width || !custom.depth)) {
      setError('Entrez toutes les dimensions de la boîte'); return
    }
    setError('')
    setLoading(true)
    setStep('rates')
    try {
      const res = await api.novoxpress.getRates(envoi.id, {
        packaging_type: 'package',
        packages: buildPackages(),
        declared_value: declaredValue || '1'
      })
      setRequestId(res.request_id)
      setRates(res.rates || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirm() {
    setLoading(true)
    setError('')
    try {
      const res = await api.novoxpress.createLabel(envoi.id, {
        request_id: requestId,
        service_id: selectedRate.service_id,
        packaging_type: 'package',
        packages: buildPackages(),
        declared_value: declaredValue || '1'
      })
      setResult(res)
      setStep('done')
      onDone()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // ── Step: package ──
  if (step === 'package') return (
    <div className="space-y-4">
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
        <label className="label">Type de boîte</label>
        <div className="space-y-2">
          {Object.entries(BOX_PRESETS).map(([key, box]) => (
            <label key={key} className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${preset === key ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'}`}>
              <input type="radio" name="preset" value={key} checked={preset === key} onChange={() => setPreset(key)} className="accent-indigo-600" />
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

      <div>
        <label className="label">Nombre de boîtes</label>
        <input
          type="number" min="1" step="1"
          className="input"
          value={qty}
          onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))}
        />
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
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
          <span className="text-sm">Récupération des tarifs…</span>
        </div>
      ) : error ? (
        <div className="space-y-4">
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>
          <div className="flex justify-between">
            <button onClick={() => { setStep('package'); setError('') }} className="btn-secondary">← Retour</button>
          </div>
        </div>
      ) : rates.length === 0 ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-500 text-center py-8">Aucun tarif disponible pour cet envoi.</p>
          <button onClick={() => setStep('package')} className="btn-secondary">← Retour</button>
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-500">Sélectionnez le service souhaité :</p>
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {rates.map((rate, i) => (
              <button
                key={rate.service_id || i}
                onClick={() => { setSelectedRate(rate); setStep('confirm') }}
                className="w-full text-left p-3 rounded-xl border border-slate-200 hover:border-indigo-400 hover:bg-indigo-50 transition-colors"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-900 text-sm">{getRateName(rate)}</p>
                    {getRateCarrier(rate) && <p className="text-xs text-slate-500">{getRateCarrier(rate)}</p>}
                    {getRateDelivery(rate) && <p className="text-xs text-slate-400 mt-0.5">{getRateDelivery(rate)}</p>}
                  </div>
                  <span className="font-semibold text-indigo-700 whitespace-nowrap">{fmtPrice(rate)}</span>
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
          <span className="font-semibold text-indigo-700">{fmtPrice(selectedRate)}</span>
          <span className="text-slate-400">Boîte</span>
          <span>{BOX_PRESETS[preset]?.label || 'Personnalisée'} × {qty}</span>
          <span className="text-slate-400">Poids total</span>
          <span>{totalWeight} lbs</span>
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
      </p>
      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>}
      <div className="flex justify-between gap-3 pt-2">
        <button onClick={() => { setStep('rates'); setError('') }} disabled={loading} className="btn-secondary">← Retour</button>
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
      <div className="border border-indigo-200 bg-indigo-50 rounded-xl p-4 space-y-1">
        <p className="text-sm font-semibold text-indigo-900">Planifier un ramassage ?</p>
        <p className="text-xs text-indigo-700">Souhaitez-vous qu'un coursier vienne récupérer le colis ?</p>
      </div>
      <div className="flex gap-3">
        <button onClick={onClose} className="btn-secondary flex-1">Non merci</button>
        <button onClick={() => setStep('pickup')} className="btn-primary flex-1 flex items-center justify-center gap-1.5">
          <Package size={14} /> Oui, planifier
        </button>
      </div>
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
          quantity: qty,
          weight: totalWeight,
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
            <input type="date" className="input" value={pickupDate} onChange={e => setPickupDate(e.target.value)} min={new Date().toISOString().slice(0, 10)} />
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

function SendTrackingModal({ envoi, onClose, onSent }) {
  const defaultEmail = envoi.address_contact_email || ''
  const [to, setTo] = useState(defaultEmail)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function handleSend() {
    if (!to || !to.includes('@')) { setError('Adresse courriel invalide'); return }
    setSending(true)
    setError('')
    try {
      await api.shipments.sendTracking(envoi.id, to)
      setSent(true)
      onSent()
    } catch (e) {
      setError(e.message)
    } finally {
      setSending(false)
    }
  }

  if (sent) return (
    <div className="space-y-4 text-center">
      <div className="flex flex-col items-center gap-3 py-4">
        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
          <CheckCircle size={28} className="text-green-600" />
        </div>
        <h3 className="font-semibold text-slate-900 text-lg">Courriel envoyé !</h3>
        <p className="text-sm text-slate-500">Le courriel de suivi a été envoyé à <span className="font-medium text-slate-700">{to}</span>.</p>
      </div>
      <button onClick={onClose} className="btn-secondary w-full">Fermer</button>
    </div>
  )

  const contactName = [envoi.address_contact_first_name, envoi.address_contact_last_name].filter(Boolean).join(' ')

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Un courriel contenant le numéro de suivi <span className="font-mono font-semibold text-slate-900">{envoi.tracking_number}</span> sera envoyé au destinataire.
      </p>

      <div>
        <label className="label">Destinataire</label>
        {contactName && (
          <p className="text-xs text-slate-500 mb-1">{contactName}</p>
        )}
        <input
          type="email"
          className="input"
          value={to}
          onChange={e => setTo(e.target.value)}
          placeholder="client@exemple.com"
          autoFocus={!defaultEmail}
        />
        {!defaultEmail && (
          <p className="text-xs text-amber-600 mt-1">Aucun courriel trouvé pour le contact de l'adresse de livraison.</p>
        )}
      </div>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>}

      <div className="flex justify-end gap-3 pt-2">
        <button onClick={onClose} className="btn-secondary">Annuler</button>
        <button onClick={handleSend} disabled={sending || !to} className="btn-primary flex items-center gap-1.5">
          {sending
            ? <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> Envoi…</>
            : <><Mail size={14} /> Envoyer</>
          }
        </button>
      </div>
    </div>
  )
}

function fmtAdresse(addr) {
  return [addr.line1, addr.city, addr.province, addr.postal_code, addr.country]
    .filter(Boolean).join(', ')
}

function EditEnvoiModal({ envoi, adresses, onSave, onClose }) {
  const [form, setForm] = useState({
    tracking_number: envoi.tracking_number || '',
    carrier: envoi.carrier || '',
    status: envoi.status || 'À envoyer',
    shipped_at: envoi.shipped_at ? envoi.shipped_at.slice(0, 10) : '',
    notes: envoi.notes || '',
    address_id: envoi.address_id || '',
  })
  const [fieldSaving, setFieldSaving] = useState({})
  const [error, setError] = useState('')

  async function saveField(key, value) {
    setForm(f => ({ ...f, [key]: value }))
    setError('')
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      await onSave({ [key]: value === '' ? null : value })
    } catch (err) {
      setError(err.message)
    } finally {
      setFieldSaving(s => ({ ...s, [key]: false }))
    }
  }

  const savingLabel = (k) => fieldSaving[k] ? ' (sauvegarde...)' : ''

  return (
    <div className="space-y-4">
      <div>
        <label className="label">Statut{savingLabel('status')}</label>
        <select
          value={form.status}
          onChange={e => saveField('status', e.target.value)}
          className="select"
        >
          <option value="À envoyer">À envoyer</option>
          <option value="Envoyé">Envoyé</option>
        </select>
      </div>
      <div>
        <label className="label">Transporteur{savingLabel('carrier')}</label>
        <input
          type="text"
          value={form.carrier}
          onChange={e => setForm(f => ({ ...f, carrier: e.target.value }))}
          onBlur={e => saveField('carrier', e.target.value)}
          className="input"
          placeholder="ex. Purolator, FedEx, UPS…"
        />
      </div>
      <div>
        <label className="label">N° de suivi{savingLabel('tracking_number')}</label>
        <input
          type="text"
          value={form.tracking_number}
          onChange={e => setForm(f => ({ ...f, tracking_number: e.target.value }))}
          onBlur={e => saveField('tracking_number', e.target.value)}
          className="input"
        />
      </div>
      <div>
        <label className="label">Envoyé le{savingLabel('shipped_at')}</label>
        <input
          type="date"
          value={form.shipped_at}
          onChange={e => saveField('shipped_at', e.target.value)}
          className="input"
        />
      </div>
      <div>
        <label className="label">Adresse de livraison{savingLabel('address_id')}</label>
        <LinkedRecordField
          name="address_id"
          value={form.address_id}
          options={adresses}
          labelFn={fmtAdresse}
          placeholder="Adresse"
          onChange={v => saveField('address_id', v)}
        />
      </div>
      <div>
        <label className="label">Notes{savingLabel('notes')}</label>
        <textarea
          value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          onBlur={e => saveField('notes', e.target.value)}
          className="input"
          rows={3}
        />
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-primary">Fermer</button>
      </div>
    </div>
  )
}

export default function EnvoisDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [envoi, setEnvoi] = useState(null)
  const [adresses, setAdresses] = useState([])
  const [loading, setLoading] = useState(true)
  const [showEdit, setShowEdit] = useState(false)
  const [showLabel, setShowLabel] = useState(false)
  const [showSendTracking, setShowSendTracking] = useState(false)
  const [cancellingPickup, setCancellingPickup] = useState(false)
  const [novoxConfigured, setNovoxConfigured] = useState(false)
  const [generatingPdf, setGeneratingPdf] = useState(false)
  const [showPdf, setShowPdf] = useState(false)
  const confirm = useConfirm()
  const { addToast } = useToast()

  useEffect(() => {
    api.adresses.lookup().then(setAdresses).catch(() => {})
    api.novoxpress.status().then(r => setNovoxConfigured(!!r.configured)).catch(() => {})
  }, [])

  function load() {
    setLoading(true)
    api.shipments.get(id)
      .then(data => setEnvoi(data))
      .catch(() => setEnvoi(null))
      .finally(() => setLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [id])

  async function handleCancelPickup() {
    if (!(await confirm('Annuler le ramassage planifié ?'))) return
    setCancellingPickup(true)
    try {
      await api.novoxpress.cancelPickup(id)
      load()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setCancellingPickup(false)
    }
  }

  async function handleUpdate(form) {
    await api.shipments.update(id, form)
    load()
  }

  async function handleGenerateBonLivraison() {
    setGeneratingPdf(true)
    try { await api.shipments.generateBonLivraison(id); await load() }
    finally { setGeneratingPdf(false) }
  }

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" />
        </div>
      </Layout>
    )
  }
  if (!envoi) return <Layout><div className="p-6 text-slate-500">Envoi introuvable.</div></Layout>

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button
            onClick={() => navigate('/envois')}
            className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">
                {envoi.tracking_number ? `Envoi ${envoi.tracking_number}` : 'Envoi'}
              </h1>
              <Badge color={STATUS_COLORS[envoi.status] || 'gray'} size="md">{envoi.status}</Badge>
            </div>
            {envoi.company_name && envoi.company_id && (
              <div className="text-sm text-slate-500 mt-1">
                <Link to={`/companies/${envoi.company_id}`} className="text-indigo-600 hover:underline">
                  {envoi.company_name}
                </Link>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {novoxConfigured && envoi.address_id && (
              <button onClick={() => setShowLabel(true)} className="btn-primary flex items-center gap-1.5 text-sm">
                <Printer size={14} />
                {envoi.label_pdf_path ? 'Réimprimer' : 'Créer étiquette'}
              </button>
            )}
            {envoi.tracking_number && (
              <button onClick={() => setShowSendTracking(true)} className="btn-secondary flex items-center gap-1.5 text-sm">
                <Mail size={14} /> Envoyer le suivi
              </button>
            )}
            <button onClick={handleGenerateBonLivraison} disabled={generatingPdf} className="btn-secondary flex items-center gap-1.5 text-sm">
              <FileText size={14} />
              {generatingPdf ? 'Génération...' : envoi.bon_livraison_path ? 'Régénérer BL' : 'Bon de livraison'}
            </button>
            <button onClick={() => setShowEdit(true)} className="btn-secondary flex items-center gap-1.5">
              <Pencil size={14} /> Modifier
            </button>
          </div>
        </div>

        {/* Informations */}
        <div className="card p-5 mb-4">
          <h2 className="font-semibold text-slate-900 mb-4">Informations</h2>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Commande</dt>
              <dd>
                {envoi.order_id
                  ? <Link to={`/orders/${envoi.order_id}`} className="text-indigo-600 hover:underline font-medium">#{envoi.order_number}</Link>
                  : <span className="text-slate-400">—</span>
                }
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Transporteur</dt>
              <dd className="text-slate-700">{envoi.carrier || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">N° de suivi</dt>
              <dd className="font-mono text-slate-700">{envoi.tracking_number || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Envoyé le</dt>
              <dd className="text-slate-700">{fmtDate(envoi.shipped_at)}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Créé le</dt>
              <dd className="text-slate-700">{fmtDate(envoi.created_at)}</dd>
            </div>
            {(envoi.address_line1 || envoi.address_city) && (
              <div className="col-span-2 md:col-span-3">
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Adresse de livraison</dt>
                <dd className="text-slate-700 space-y-0.5">
                  {(envoi.address_contact_first_name || envoi.address_contact_last_name) && (
                    <div className="font-medium">
                      {[envoi.address_contact_first_name, envoi.address_contact_last_name].filter(Boolean).join(' ')}
                    </div>
                  )}
                  <div>{envoi.address_line1 || [envoi.address_city, envoi.address_province, envoi.address_postal_code, envoi.address_country].filter(Boolean).join(', ')}</div>
                  {(envoi.address_contact_email || envoi.address_contact_phone || envoi.address_contact_mobile) && (
                    <div className="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                      {envoi.address_contact_email && <span>{envoi.address_contact_email}</span>}
                      {(envoi.address_contact_phone || envoi.address_contact_mobile) && (
                        <span>{envoi.address_contact_phone || envoi.address_contact_mobile}</span>
                      )}
                    </div>
                  )}
                </dd>
              </div>
            )}
            {envoi.notes && (
              <div className="col-span-2 md:col-span-3">
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Notes</dt>
                <dd className="text-slate-700 whitespace-pre-wrap">{envoi.notes}</dd>
              </div>
            )}
            {envoi.label_pdf_path && (
              <div>
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Étiquette</dt>
                <dd>
                  <a
                    href={`/erp/api/novoxpress/labels/${envoi.label_pdf_path}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-indigo-600 hover:underline font-medium"
                  >
                    <Download size={13} /> Télécharger PDF
                  </a>
                </dd>
              </div>
            )}
            {envoi.novoxpress_pickup_id && (
              <div className="col-span-2 md:col-span-3">
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Ramassage</dt>
                <dd className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-sm text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg px-2.5 py-1">
                    <Package size={13} /> Planifié · {envoi.novoxpress_pickup_id}
                  </span>
                  <button
                    onClick={handleCancelPickup}
                    disabled={cancellingPickup}
                    className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-700 hover:underline disabled:opacity-50"
                  >
                    <XCircle size={12} /> {cancellingPickup ? 'Annulation…' : 'Annuler le ramassage'}
                  </button>
                </dd>
              </div>
            )}
          </dl>
        </div>

        {/* Articles de la commande */}
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200">
            <h2 className="font-semibold text-slate-900">
              Articles de la commande ({envoi.order_items?.length || 0})
            </h2>
          </div>
          {!envoi.order_items?.length ? (
            <p className="text-center py-10 text-slate-400">Aucun article sur cette commande</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Produit</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">SKU</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Qté</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Coût unitaire</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Poids (lbs)</th>
                </tr>
              </thead>
              <tbody>
                {envoi.order_items.map((item, i) => {
                  const lineWeight = (item.weight_lbs || 0) * (item.qty || 0)
                  return (
                    <tr key={item.id || i} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-900">{item.product_name || '—'}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">{item.sku || '—'}</td>
                      <td className="px-4 py-3 text-right text-slate-700">{item.qty ?? '—'}</td>
                      <td className="px-4 py-3 text-right text-slate-500 hidden sm:table-cell">{fmtCurrency(item.unit_cost)}</td>
                      <td className="px-4 py-3 text-right text-slate-500">
                        {item.weight_lbs ? `${lineWeight.toFixed(2)} lbs` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50">
                  <td colSpan={4} className="px-4 py-3 text-xs font-semibold text-slate-500 text-right hidden sm:table-cell">Poids total</td>
                  <td colSpan={4} className="px-4 py-3 text-xs font-semibold text-slate-500 text-right sm:hidden">Poids total</td>
                  <td className="px-4 py-3 text-right font-semibold text-slate-700">
                    {(() => {
                      const total = envoi.order_items.reduce((sum, item) => sum + (item.weight_lbs || 0) * (item.qty || 0), 0)
                      return total > 0 ? `${total.toFixed(2)} lbs` : '—'
                    })()}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        {/* Bon de livraison */}
        {envoi.bon_livraison_path && (() => {
          const pdfUrl = `/erp/api/bons-livraison/${envoi.bon_livraison_path.replace('bons-livraison/', '')}`
          return (
            <div className="card p-5 mt-4">
              <h2 className="font-semibold text-slate-900 text-sm mb-3">Bon de livraison</h2>
              <button onClick={() => setShowPdf(true)} className="group relative w-40 h-52 bg-white border border-slate-200 rounded-lg overflow-hidden hover:border-indigo-400 hover:shadow-md transition-all">
                <iframe src={`${pdfUrl}#toolbar=0&navpanes=0&scrollbar=0`} className="w-[200%] h-[200%] origin-top-left scale-50 pointer-events-none" title="Aperçu bon de livraison" />
                <div className="absolute inset-0 bg-transparent group-hover:bg-indigo-600/5 transition-colors flex items-center justify-center">
                  <span className="opacity-0 group-hover:opacity-100 bg-indigo-600 text-white text-xs px-3 py-1.5 rounded-lg shadow-lg transition-opacity">Ouvrir</span>
                </div>
              </button>
            </div>
          )
        })()}
      </div>

      {/* PDF viewer modal */}
      {showPdf && envoi.bon_livraison_path && (() => {
        const pdfUrl = `/erp/api/bons-livraison/${envoi.bon_livraison_path.replace('bons-livraison/', '')}`
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/60" onClick={() => setShowPdf(false)} />
            <div className="relative bg-white rounded-xl shadow-2xl w-[95vw] max-w-6xl h-[92vh] flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
                <span className="text-sm font-semibold text-slate-900">Bon de livraison — Commande #{envoi.order_number}</span>
                <div className="flex items-center gap-2">
                  <a href={pdfUrl} download className="btn-secondary btn-sm flex items-center gap-1.5"><Download size={13} /> Télécharger</a>
                  <button onClick={() => setShowPdf(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded"><X size={16} /></button>
                </div>
              </div>
              <iframe src={pdfUrl} className="flex-1 w-full" title="Bon de livraison" />
            </div>
          </div>
        )
      })()}

      <Modal isOpen={showEdit} onClose={() => setShowEdit(false)} title="Modifier l'envoi">
        <EditEnvoiModal envoi={envoi} adresses={adresses} onSave={handleUpdate} onClose={() => setShowEdit(false)} />
      </Modal>

      <Modal isOpen={showLabel} onClose={() => setShowLabel(false)} title="Créer une étiquette postale">
        <CreateLabelModal
          envoi={envoi}
          orderItemsTotalWeight={
            (envoi.order_items || []).reduce((sum, item) => sum + (item.weight_lbs || 0) * (item.qty || 0), 0)
          }
          onClose={() => setShowLabel(false)}
          onDone={() => { setShowLabel(false); load() }}
        />
      </Modal>

      <Modal isOpen={showSendTracking} onClose={() => setShowSendTracking(false)} title="Envoyer le courriel de suivi">
        <SendTrackingModal envoi={envoi} onClose={() => setShowSendTracking(false)} onSent={load} />
      </Modal>
    </Layout>
  )
}
