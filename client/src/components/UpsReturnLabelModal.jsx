import { useState, useEffect, useCallback } from 'react'
import { CheckCircle, Download, Truck, Mail } from 'lucide-react'
import api from '../lib/api.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { useUndoSend } from './UndoSendProvider.jsx'
import { BOX_PRESETS, DebugDetails } from './novoxpressShared.jsx'

// Étiquette de retour UPS (achat direct chez UPS, hors Novoxpress) : le client
// expédie, l'atelier d'Orisha reçoit. L'étiquette PDF est ensuite envoyée au
// client par courriel — planifié avec la fenêtre d'annulation de 10 s
// (UndoSendProvider), jamais un envoi immédiat.

// Services UPS pertinents depuis/vers le Québec. Le code 11 (Standard) couvre
// le sol au Canada comme les échanges terrestres CA ↔ US.
const SERVICES = [
  { code: '11', label: 'UPS Standard (sol)' },
  { code: '03', label: 'UPS Ground' },
  { code: '02', label: 'UPS 2nd Day Air' },
  { code: '01', label: 'UPS Next Day Air' },
  { code: '65', label: 'UPS Worldwide Saver' },
]

const ATELIER = "Automatisation Orisha Inc. — 220-1535 ch. Ste-Foy, Québec, QC G1S 2P1"

import { fmtMoney } from '../utils/formatters.js'

export default function UpsReturnLabelModal({ retour, onClose, onDone }) {
  const { addToast } = useToast()
  const scheduleSend = useUndoSend()

  const [context, setContext] = useState(null)
  const [loadingContext, setLoadingContext] = useState(true)
  const [addressId, setAddressId] = useState(null)
  const [preset, setPreset] = useState('moyenne')
  const [custom, setCustom] = useState({ length: '', width: '', depth: '' })
  const [qty, setQty] = useState(1)
  const [totalWeight, setTotalWeight] = useState('2')
  const [serviceCode, setServiceCode] = useState('11')
  const [emailTo, setEmailTo] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [errorDetails, setErrorDetails] = useState(null)
  const [result, setResult] = useState(null)

  const loadContext = useCallback(() => {
    setLoadingContext(true)
    api.retours.context(retour.id)
      .then(res => {
        setContext(res)
        setAddressId(res.address?.id || null)
        const auto = res.party_ctx?.address_contact_email || res.party_ctx?.company_email
        if (auto) setEmailTo(auto)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoadingContext(false))
  }, [retour.id])

  useEffect(() => { loadContext() }, [loadContext])

  const withToken = (url) => url ? `${url}?token=${localStorage.getItem('erp_token')}` : url

  function buildPackages() {
    const p = BOX_PRESETS[preset]
    const length = preset === 'custom' ? custom.length : p.length
    const width = preset === 'custom' ? custom.width : p.width
    const depth = preset === 'custom' ? custom.depth : p.depth
    const perBox = qty > 0
      ? String(Math.max(1, Math.ceil(parseFloat(totalWeight) / qty)))
      : String(Math.max(1, Math.ceil(parseFloat(totalWeight))))
    return [{ quantity: String(qty), weight: perBox, length: String(length), width: String(width), depth: String(depth) }]
  }

  // Planifie l'envoi du courriel avec la fenêtre d'annulation de 10 s.
  function scheduleLabelEmail(to) {
    scheduleSend({
      message: `Envoi de l'étiquette de retour à ${to}…`,
      onRun: async () => {
        try {
          await api.ups.sendReturnLabel(retour.id, to)
          addToast({ message: `Étiquette de retour envoyée à ${to}`, type: 'success' })
          onDone?.()
        } catch (e) {
          addToast({ message: e.message || "Erreur lors de l'envoi", type: 'error' })
        }
      },
      onCancel: () => addToast({ message: 'Envoi annulé — l\'étiquette reste disponible sur le retour', type: 'info' }),
    })
  }

  async function handleCreate() {
    if (!totalWeight || parseFloat(totalWeight) <= 0) { setError('Entrez un poids total valide'); return }
    if (preset === 'custom' && (!custom.length || !custom.width || !custom.depth)) {
      setError('Entrez toutes les dimensions de la boîte'); return
    }
    if (!emailTo || !emailTo.includes('@')) { setError('Entrez le courriel du client (l\'étiquette lui est envoyée)'); return }

    setError(''); setErrorDetails(null); setLoading(true)
    const sent = { address_id: addressId, packages: buildPackages(), service_code: serviceCode }
    try {
      const res = await api.ups.createReturnLabel(retour.id, sent)
      setResult(res)
      onDone?.()
      if (res.label_error) {
        addToast({ message: `Étiquette achetée mais PDF indisponible : ${res.label_error}`, type: 'error' })
      } else {
        scheduleLabelEmail(emailTo.trim())
      }
    } catch (e) {
      // Message BRUT remonté par l'API UPS — jamais un échec silencieux.
      setError(e.message)
      setErrorDetails({ sent: e.details?.sent || sent, responseBody: e.details?.responseBody || null, novoxpressStatus: e.details?.upsStatus || null })
      addToast({ message: e.message, type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  if (loadingContext) return <div className="py-8 text-center text-slate-400 text-sm">Chargement…</div>

  if (result) return (
    <div className="space-y-4" data-testid="ups-return-label-result">
      <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm space-y-2">
        <p className="flex items-center gap-1.5 font-medium text-green-800"><CheckCircle size={15} /> Étiquette de retour UPS créée</p>
        <p className="text-slate-600">N° de suivi : <span className="font-mono font-semibold text-slate-900">{result.tracking_number || '—'}</span></p>
        <p className="text-slate-600">Service : {result.service_name} · Coût estimé : {fmtMoney(result.cost, result.currency)}</p>
        {result.environment !== 'production' && (
          <p className="text-amber-700">Environnement CIE (test) — cette étiquette n'est pas utilisable pour expédier.</p>
        )}
      </div>
      {result.label_url && (
        <a href={withToken(result.label_url)} target="_blank" rel="noopener noreferrer" className="btn-secondary inline-flex items-center gap-2 text-sm">
          <Download size={14} /> Télécharger l'étiquette
        </a>
      )}
      {result.label_error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{result.label_error}</p>}
      {!result.label_error && (
        <p className="text-sm text-slate-500 flex items-center gap-1.5">
          <Mail size={14} /> Courriel au client planifié — vous pouvez encore l'annuler pendant 10 secondes.
        </p>
      )}
      <div className="flex justify-end"><button onClick={onClose} className="btn-primary">Fermer</button></div>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-sm space-y-1">
        <p className="flex items-center gap-1.5 font-medium text-slate-700"><Truck size={14} /> Sens de l'expédition</p>
        <p className="text-slate-500">Expéditeur : <span className="text-slate-700">le client</span> · Destinataire : <span className="text-slate-700">{ATELIER}</span></p>
      </div>

      <div>
        <label className="label">Adresse du client (expéditeur)</label>
        {context?.candidates?.length ? (
          <select className="input" value={addressId || ''} onChange={e => setAddressId(e.target.value)} data-testid="ups-return-address">
            {context.candidates.map(c => (
              <option key={c.id} value={c.id}>{c.line1}, {c.city} — {c.cascade_label}</option>
            ))}
          </select>
        ) : (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
            Aucune adresse trouvée automatiquement pour ce retour.
          </p>
        )}
      </div>

      <div>
        <label className="label">Type de colis</label>
        <select className="input" value={preset} onChange={e => setPreset(e.target.value)} data-testid="ups-return-preset">
          {Object.entries(BOX_PRESETS).filter(([k]) => k !== 'enveloppe').map(([key, box]) => (
            <option key={key} value={key}>{box.label}</option>
          ))}
        </select>
      </div>

      {preset === 'custom' && (
        <div className="grid grid-cols-3 gap-2">
          <input type="number" min="1" className="input text-center" placeholder="Long." value={custom.length} onChange={e => setCustom(c => ({ ...c, length: e.target.value }))} />
          <input type="number" min="1" className="input text-center" placeholder="Larg." value={custom.width} onChange={e => setCustom(c => ({ ...c, width: e.target.value }))} />
          <input type="number" min="1" className="input text-center" placeholder="Haut." value={custom.depth} onChange={e => setCustom(c => ({ ...c, depth: e.target.value }))} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Poids total (lbs)</label>
          <input type="number" min="0.1" step="0.1" className="input" value={totalWeight} onChange={e => setTotalWeight(e.target.value)} data-testid="ups-return-weight" />
        </div>
        <div>
          <label className="label">Nb de colis</label>
          <input type="number" min="1" step="1" className="input" value={qty} onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))} />
        </div>
      </div>

      <div>
        <label className="label">Service UPS</label>
        <select className="input" value={serviceCode} onChange={e => setServiceCode(e.target.value)} data-testid="ups-return-service">
          {SERVICES.map(s => <option key={s.code} value={s.code}>{s.label}</option>)}
        </select>
      </div>

      <div>
        <label className="label">Courriel du client (destinataire de l'étiquette)</label>
        <input type="email" className="input" value={emailTo} onChange={e => setEmailTo(e.target.value)} placeholder="client@exemple.com" data-testid="ups-return-email" />
      </div>

      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
        Cette action achète l'étiquette sur le compte UPS d'Orisha, puis envoie le PDF au client (annulable 10 s).
      </p>

      {error && (
        <>
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3 whitespace-pre-wrap break-words" data-testid="ups-return-error">{error}</p>
          <DebugDetails details={errorDetails} />
        </>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onClose} className="btn-secondary">Annuler</button>
        <button onClick={handleCreate} disabled={loading || !addressId} className="btn-primary flex items-center gap-1.5" data-testid="ups-return-confirm">
          {loading ? 'Création…' : <><Truck size={14} /> Créer l'étiquette de retour UPS</>}
        </button>
      </div>
    </div>
  )
}
