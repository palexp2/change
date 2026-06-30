import { useState } from 'react'
import { CheckCircle, Package, Stethoscope } from 'lucide-react'
import api from '../lib/api.js'
import { localISODate } from '../lib/formatDate.js'
import NovoxpressDiagnosticPanel from './NovoxpressDiagnosticPanel.jsx'

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
  return localISODate(d)
}

// Modal dédié à la commande d'un ramassage Novoxpress, séparé de l'achat
// d'étiquette : l'étiquette s'achète d'abord (et son téléchargement peut
// échouer sans bloquer), le ramassage se commande ensuite via ce bouton.
export default function NovoxpressPickupModal({ envoi, defaultWeight, onClose, onDone }) {
  const [step, setStep] = useState('form') // 'form' | 'done'
  const [pickupDate, setPickupDate] = useState(getDefaultPickupDate)
  const [pickupReadyAt, setPickupReadyAt] = useState('09:00')
  const [pickupReadyUntil, setPickupReadyUntil] = useState('17:00')
  const [pickupLocation, setPickupLocation] = useState('OutsideDoor')
  const [pickupInstructions, setPickupInstructions] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [pickupResult, setPickupResult] = useState(null)
  // Diagnostic en env dev Novoxpress (système temporaire) — déclenché à la
  // demande via le bouton « Diagnostiquer en dev » après un échec.
  const [diagnostic, setDiagnostic] = useState(null)
  const [diagLoading, setDiagLoading] = useState(false)

  const weight = defaultWeight > 0 ? String(Math.max(1, Math.ceil(defaultWeight))) : '1'

  function buildPickupParams() {
    const [year, month, day] = pickupDate.split('-').map(Number)
    const [rH, rM] = pickupReadyAt.split(':').map(Number)
    const [uH, uM] = pickupReadyUntil.split(':').map(Number)
    return {
      date: { year, month, day },
      ready_at: { hour: rH, minute: rM },
      ready_until: { hour: uH, minute: uM },
      quantity: 1,
      weight,
      pickup_location: pickupLocation,
      pickup_instructions: pickupInstructions || undefined,
    }
  }

  async function handleSchedulePickup() {
    setLoading(true)
    setError('')
    setDiagnostic(null)
    try {
      const res = await api.novoxpress.schedulePickup(envoi.id, buildPickupParams())
      setPickupResult(res)
      setStep('done')
      onDone?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // Rejoue le ramassage en environnement dev Novoxpress (aucun ramassage réel,
  // un shipment dev jetable est créé pour le supporter) et bissecte le payload
  // pour isoler le champ fautif.
  async function handleDiagnose() {
    setDiagLoading(true)
    try {
      const res = await api.novoxpress.diagnostic(envoi.id, {
        op: 'pickup',
        pickup: buildPickupParams(),
        prod_error: error || undefined,
      })
      setDiagnostic(res)
    } catch (e) {
      setDiagnostic({ available: true, verdict: 'not_isolated', message: `Le diagnostic lui-même a échoué : ${e.message}`, attempts: [] })
    } finally {
      setDiagLoading(false)
    }
  }

  if (step === 'done') return (
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

  return (
    <div className="space-y-4">
      {/* Note de ramassage — déplacée ici depuis la confirmation d'étiquette :
          elle décrit ce qui va se passer au moment de commander le ramassage. */}
      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex items-start gap-2">
        <Package size={14} className="mt-0.5 shrink-0" />
        <span>
          Un coursier du transporteur de l'étiquette viendra récupérer le colis à la date
          et dans la fenêtre choisies (jours ouvrables, 9h–17h par défaut). Cette commande
          de ramassage est indépendante de l'achat de l'étiquette.
        </span>
      </p>
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
      {error && (
        <>
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>
          <NovoxpressDiagnosticPanel diagnostic={diagnostic} />
          {!diagnostic?.available && (
            <button onClick={handleDiagnose} disabled={diagLoading} className="btn-secondary text-sm flex items-center gap-1.5" type="button">
              {diagLoading
                ? <><div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-slate-500" /> Diagnostic en cours… (~30 s)</>
                : <><Stethoscope size={14} /> Diagnostiquer en dev</>}
            </button>
          )}
        </>
      )}
      <div className="flex justify-between gap-3 pt-2">
        <button onClick={onClose} className="btn-secondary">Annuler</button>
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
