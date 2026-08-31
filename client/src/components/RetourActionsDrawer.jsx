import { useState, useEffect, useCallback } from 'react'
import { ChevronRight, CheckCircle, Download, RefreshCw, Stethoscope, Mail, FileText, Sparkles } from 'lucide-react'
import api from '../lib/api.js'
import NovoxpressDiagnosticPanel from './NovoxpressDiagnosticPanel.jsx'
import { BOX_PRESETS, fmtPrice, getRateName, getRateCarrier, getRateDelivery, DebugDetails } from './novoxpressShared.jsx'

const REASON_LABELS = {
  preferred: 'transporteur préféré',
  fallback_cheapest: 'transporteur préféré indisponible — moins cher retenu',
}
function reasonLabel(reason) {
  if (!reason) return null
  if (REASON_LABELS[reason]) return REASON_LABELS[reason]
  const m = /^cheaper_by_(.+)$/.exec(reason)
  if (m) return `moins cher de ${m[1]} $ que le transporteur préféré`
  return reason
}

// Panneau d'actions pour un retour (RMA) : achat d'étiquette de retour
// Novoxpress (client → Orisha, l'inverse d'un envoi sortant), génération de
// l'aide-mémoire, envoi des instructions au client. Conçu pour vivre dans un
// RecordPeekDrawer / une section de RetourDetail.jsx.
export default function RetourActionsDrawer({ retour, onClose, onDone }) {
  const [step, setStep] = useState('address') // 'address' | 'package' | 'rates' | 'confirm' | 'done'
  const [context, setContext] = useState(null)
  const [loadingContext, setLoadingContext] = useState(true)
  const [addressId, setAddressId] = useState(null)

  const [preset, setPreset] = useState('moyenne')
  const [qty, setQty] = useState(1)
  const [totalWeight, setTotalWeight] = useState('2')
  const [custom, setCustom] = useState({ length: '', width: '', depth: '' })
  const [rates, setRates] = useState([])
  const [recommendation, setRecommendation] = useState(null)
  const [requestId, setRequestId] = useState(null)
  const [selectedRate, setSelectedRate] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [errorDetails, setErrorDetails] = useState(null)
  const [result, setResult] = useState(null)
  const [retrying, setRetrying] = useState(false)
  const [diagnostic, setDiagnostic] = useState(null)
  const [diagLoading, setDiagLoading] = useState(false)

  // /api/retours/memos/:filename est derrière requireAuth (contrairement aux
  // étiquettes, servies en statique sans auth) — un lien <a> classique n'envoie
  // pas le Bearer token, il faut donc le passer en query param (cf. CLAUDE.md,
  // requireAuth accepte ?token=, pattern déjà utilisé pour les iframes/downloads).
  const withToken = (url) => url ? `${url}?token=${localStorage.getItem('erp_token')}` : url
  const [memoStatus, setMemoStatus] = useState(retour.memo_pdf_path ? 'done' : 'idle')
  const [memoUrl, setMemoUrl] = useState(retour.memo_pdf_path ? withToken(`/erp/api/retours/memos/${retour.memo_pdf_path.split('/').pop()}`) : null)
  const [emailTo, setEmailTo] = useState('')
  const [emailStatus, setEmailStatus] = useState('idle') // idle|sending|done|error
  const [emailError, setEmailError] = useState('')

  const loadContext = useCallback(() => {
    setLoadingContext(true)
    api.retours.context(retour.id)
      .then(res => { setContext(res); setAddressId(res.address?.id || null) })
      .catch(e => setError(e.message))
      .finally(() => setLoadingContext(false))
  }, [retour.id])

  useEffect(() => { loadContext() }, [loadContext])

  // Pré-remplit le courriel du client dès que le contexte est chargé — évite
  // de le retaper à chaque retour. Contact rattaché à l'adresse en priorité,
  // sinon le courriel de l'entreprise. Ne touche pas si l'utilisateur a déjà
  // modifié le champ lui-même.
  useEffect(() => {
    if (emailTo) return
    const auto = context?.party_ctx?.address_contact_email || context?.party_ctx?.company_email
    if (auto) setEmailTo(auto)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context])

  const isEnvelope = BOX_PRESETS[preset]?.packagingType === 'envelope'
  const effectiveQty = isEnvelope ? 1 : qty
  const effectiveWeight = isEnvelope ? '1' : totalWeight

  function buildPackages() {
    const p = BOX_PRESETS[preset]
    const length = preset === 'custom' ? custom.length : p.length
    const width  = preset === 'custom' ? custom.width  : p.width
    const depth  = preset === 'custom' ? custom.depth  : p.depth
    const perBox = effectiveQty > 0
      ? String(Math.max(1, Math.ceil(parseFloat(effectiveWeight) / effectiveQty)))
      : String(Math.max(1, Math.ceil(parseFloat(effectiveWeight))))
    return [{ quantity: String(effectiveQty), weight: String(perBox), length: String(length), width: String(width), depth: String(depth) }]
  }

  function packagingType() {
    return BOX_PRESETS[preset]?.packagingType || 'package'
  }

  async function handleGetRates() {
    if (!isEnvelope && (!totalWeight || parseFloat(totalWeight) <= 0)) { setError('Entrez un poids total valide'); return }
    if (preset === 'custom' && (!custom.length || !custom.width || !custom.depth)) { setError('Entrez toutes les dimensions de la boîte'); return }
    setError(''); setErrorDetails(null); setDiagnostic(null); setLoading(true); setStep('rates')
    const sentPayload = { address_id: addressId, packaging_type: packagingType(), packages: buildPackages(), declared_value: '1' }
    try {
      const res = await api.retours.getRates(retour.id, sentPayload)
      setRequestId(res.request_id)
      setRates(res.rates || [])
      setRecommendation(res.recommendation || null)
      if (res.recommendation?.rate) setSelectedRate(res.recommendation.rate)
      if (!res.rates?.length) setErrorDetails({ sent: res.sent || sentPayload, response: res.response || null })
    } catch (e) {
      setError(e.message)
      setErrorDetails({ sent: e.details?.sent || sentPayload, responseBody: e.details?.responseBody || null, novoxpressStatus: e.details?.novoxpressStatus || null })
    } finally {
      setLoading(false)
    }
  }

  async function handleDiagnose(op) {
    setDiagLoading(true)
    try {
      const res = await api.retours.diagnostic(retour.id, {
        address_id: addressId, op, packaging_type: packagingType(), packages: buildPackages(),
        declared_value: '1', service_id: selectedRate?.service_id || undefined,
      })
      setDiagnostic(res)
    } catch (e) {
      setDiagnostic({ available: true, verdict: 'not_isolated', message: `Le diagnostic a échoué : ${e.message}`, attempts: [] })
    } finally {
      setDiagLoading(false)
    }
  }

  async function handleConfirm() {
    setLoading(true); setError(''); setErrorDetails(null); setDiagnostic(null)
    const sentPayload = {
      address_id: addressId, request_id: requestId, service_id: selectedRate.service_id,
      carrier_name: getRateCarrier(selectedRate) || null, service_name: getRateName(selectedRate) || null,
      packaging_type: packagingType(), packages: buildPackages(), declared_value: '1',
    }
    try {
      const res = await api.retours.createLabel(retour.id, sentPayload)
      setResult(res); setStep('done'); onDone?.()
    } catch (e) {
      setError(e.message)
      setErrorDetails({ sent: e.details?.sent || sentPayload, responseBody: e.details?.responseBody || null, novoxpressStatus: e.details?.novoxpressStatus || null })
    } finally {
      setLoading(false)
    }
  }

  async function handleRetryPdf() {
    setRetrying(true)
    try {
      const res = await api.retours.retryLabelPdf(retour.id)
      setResult(r => ({ ...r, label_url: res.label_url, tracking_id: r?.tracking_id || res.tracking_id }))
      onDone?.()
    } catch (e) { setError(e.message) } finally { setRetrying(false) }
  }

  async function handleGenerateMemo() {
    setMemoStatus('loading')
    try {
      const res = await api.retours.generateMemo(retour.id)
      setMemoUrl(withToken(res.memo_url)); setMemoStatus('done'); onDone?.()
    } catch (e) { setMemoStatus('error'); setError(e.message) }
  }

  async function handleSendInstructions() {
    if (!emailTo || !emailTo.includes('@')) { setEmailError('Adresse courriel invalide'); return }
    setEmailStatus('sending'); setEmailError('')
    try {
      await api.retours.sendInstructions(retour.id, emailTo)
      setEmailStatus('done'); onDone?.()
    } catch (e) { setEmailStatus('error'); setEmailError(e.message) }
  }

  if (loadingContext) return <div className="p-6 text-center text-slate-400 text-sm">Chargement…</div>

  return (
    <div className="space-y-6">
      {/* ── Étiquette de retour ── */}
      <section className="space-y-4">
        <h3 className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">
          <Sparkles size={14} className="text-brand-500" /> Étiquette de retour
        </h3>

        {result?.tracking_id ? (
          <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm space-y-2">
            <p className="flex items-center gap-1.5 font-medium text-green-800"><CheckCircle size={15} /> Étiquette achetée</p>
            <p className="text-slate-600">N° de suivi : <span className="font-mono font-semibold text-slate-900">{result.tracking_id}</span></p>
            {result.label_url ? (
              <a href={result.label_url} target="_blank" rel="noopener noreferrer" className="btn-secondary inline-flex items-center gap-2 text-sm">
                <Download size={14} /> Télécharger l'étiquette
              </a>
            ) : (
              <button onClick={handleRetryPdf} disabled={retrying} className="btn-secondary inline-flex items-center gap-2 text-sm">
                {retrying ? 'Téléchargement…' : <><RefreshCw size={14} /> Réessayer le téléchargement</>}
              </button>
            )}
          </div>
        ) : retour.return_label_tracking_number ? (
          <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-slate-600">
            Étiquette déjà achetée — suivi <span className="font-mono">{retour.return_label_tracking_number}</span>
          </div>
        ) : step === 'address' ? (
          <div className="space-y-3">
            {context?.candidates?.length > 0 ? (
              <>
                <label className="label">Adresse du client</label>
                <select className="input" value={addressId || ''} onChange={e => setAddressId(e.target.value)}>
                  {context.candidates.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.line1}, {c.city} — {c.cascade_label}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                Aucune adresse trouvée automatiquement pour ce retour.
              </p>
            )}
            <button onClick={() => setStep('package')} disabled={!addressId} className="btn-primary text-sm flex items-center gap-1.5">
              Continuer <ChevronRight size={14} />
            </button>
          </div>
        ) : step === 'package' ? (
          <div className="space-y-3">
            <label className="label">Type de colis</label>
            <div className="space-y-2">
              {Object.entries(BOX_PRESETS).map(([key, box]) => (
                <label key={key} className={`flex items-center gap-3 p-2.5 rounded-xl border cursor-pointer text-sm transition-colors ${preset === key ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:border-slate-300'}`}>
                  <input type="radio" name="preset" value={key} checked={preset === key} onChange={() => setPreset(key)} className="accent-brand-600" />
                  {box.label}
                </label>
              ))}
            </div>
            {preset === 'custom' && (
              <div className="grid grid-cols-3 gap-2">
                <input type="number" min="1" className="input text-center" placeholder="Long." value={custom.length} onChange={e => setCustom(c => ({ ...c, length: e.target.value }))} />
                <input type="number" min="1" className="input text-center" placeholder="Larg." value={custom.width} onChange={e => setCustom(c => ({ ...c, width: e.target.value }))} />
                <input type="number" min="1" className="input text-center" placeholder="Haut." value={custom.depth} onChange={e => setCustom(c => ({ ...c, depth: e.target.value }))} />
              </div>
            )}
            {!isEnvelope && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label">Poids total (lbs)</label>
                  <input type="number" min="0.1" step="0.1" className="input" value={totalWeight} onChange={e => setTotalWeight(e.target.value)} />
                </div>
                <div>
                  <label className="label">Nb de colis</label>
                  <input type="number" min="1" step="1" className="input" value={qty} onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))} />
                </div>
              </div>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setStep('address')} className="btn-secondary text-sm">← Retour</button>
              <button onClick={handleGetRates} className="btn-primary text-sm flex items-center gap-1.5">Obtenir les tarifs <ChevronRight size={14} /></button>
            </div>
          </div>
        ) : step === 'rates' ? (
          <div className="space-y-3">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500 py-4 justify-center">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-brand-600" /> Récupération des tarifs…
              </div>
            ) : error ? (
              <div className="space-y-3">
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3 whitespace-pre-wrap break-words">{error}</p>
                <NovoxpressDiagnosticPanel diagnostic={diagnostic} />
                {!diagnostic?.available && (
                  <button onClick={() => handleDiagnose('rate')} disabled={diagLoading} className="btn-secondary text-sm flex items-center gap-1.5">
                    {diagLoading ? 'Diagnostic…' : <><Stethoscope size={14} /> Diagnostiquer en dev</>}
                  </button>
                )}
                <DebugDetails details={errorDetails} />
                <button onClick={() => { setStep('package'); setError(''); setErrorDetails(null) }} className="btn-secondary text-sm">← Retour</button>
              </div>
            ) : rates.length === 0 ? (
              <div className="space-y-3">
                <p className="text-sm text-slate-500 text-center py-2">Aucun tarif disponible.</p>
                <DebugDetails details={errorDetails} />
                <button onClick={() => setStep('package')} className="btn-secondary text-sm">← Retour</button>
              </div>
            ) : (
              <>
                {recommendation?.rate && (
                  <p className="text-xs bg-brand-50 border border-brand-200 text-brand-800 rounded-lg px-3 py-2">
                    Recommandé : <span className="font-semibold">{getRateCarrier(recommendation.rate) || getRateName(recommendation.rate)}</span> — {reasonLabel(recommendation.reason)}
                  </p>
                )}
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {rates.map((rate, i) => (
                    <button
                      key={rate.service_id || i}
                      onClick={() => { setSelectedRate(rate); setStep('confirm') }}
                      className={`w-full text-left p-3 rounded-xl border transition-colors ${selectedRate === rate ? 'border-brand-400 bg-brand-50' : 'border-slate-200 hover:border-brand-400 hover:bg-brand-50'}`}
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
        ) : step === 'confirm' ? (
          <div className="space-y-3">
            <div className="bg-slate-50 rounded-xl p-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-slate-400">Service</span><span className="font-medium">{getRateName(selectedRate)}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Transporteur</span><span>{getRateCarrier(selectedRate)}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Tarif</span><span className="font-semibold text-brand-700">{fmtPrice(selectedRate)}</span></div>
            </div>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              Cette action facture l'étiquette sur le compte Novoxpress d'Orisha.
            </p>
            {error && (
              <>
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3 whitespace-pre-wrap break-words">{error}</p>
                <DebugDetails details={errorDetails} />
              </>
            )}
            <div className="flex justify-between gap-2">
              <button onClick={() => setStep('rates')} disabled={loading} className="btn-secondary text-sm">← Retour</button>
              <button onClick={handleConfirm} disabled={loading} className="btn-primary text-sm flex items-center gap-1.5">
                {loading ? 'Création…' : <><CheckCircle size={14} /> Confirmer et acheter</>}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* ── Aide-mémoire ── */}
      <section className="space-y-2 border-t border-slate-100 pt-4">
        <h3 className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">
          <FileText size={14} className="text-brand-500" /> Aide-mémoire
        </h3>
        {memoUrl ? (
          <a href={memoUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary inline-flex items-center gap-2 text-sm">
            <Download size={14} /> Voir l'aide-mémoire
          </a>
        ) : (
          <button onClick={handleGenerateMemo} disabled={memoStatus === 'loading'} className="btn-secondary text-sm">
            {memoStatus === 'loading' ? 'Génération…' : 'Générer l\'aide-mémoire'}
          </button>
        )}
        {memoStatus === 'error' && <p className="text-sm text-red-600">{error}</p>}
      </section>

      {/* ── Instructions au client ── */}
      <section className="space-y-2 border-t border-slate-100 pt-4">
        <h3 className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">
          <Mail size={14} className="text-brand-500" /> Instructions au client
        </h3>
        {retour.instructions_sent_at ? (
          <p className="text-sm text-slate-500">Envoyées le {new Date(retour.instructions_sent_at).toLocaleDateString('fr-CA')}.</p>
        ) : (
          <div className="flex gap-2">
            <input type="email" className="input flex-1" placeholder="courriel du client" value={emailTo} onChange={e => setEmailTo(e.target.value)} />
            <button onClick={handleSendInstructions} disabled={emailStatus === 'sending'} className="btn-primary text-sm whitespace-nowrap">
              {emailStatus === 'sending' ? 'Envoi…' : 'Envoyer'}
            </button>
          </div>
        )}
        {emailStatus === 'done' && <p className="text-sm text-green-700">Courriel envoyé.</p>}
        {emailError && <p className="text-sm text-red-600">{emailError}</p>}
      </section>

      <div className="flex justify-end pt-2">
        <button onClick={onClose} className="btn-secondary text-sm">Fermer</button>
      </div>
    </div>
  )
}
