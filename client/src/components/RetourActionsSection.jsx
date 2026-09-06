import { useState, useEffect, useCallback } from 'react'
import { fmtDate } from '../lib/formatDate.js'
import { ChevronRight, CheckCircle, Download, RefreshCw, Stethoscope, Mail, FileText, Sparkles, Truck } from 'lucide-react'
import api from '../lib/api.js'
import EmailComposerModal from './EmailComposerModal.jsx'
import NovoxpressDiagnosticPanel from './NovoxpressDiagnosticPanel.jsx'
import { BOX_PRESETS, fmtPrice, getRateName, getRateCarrier, getRateDelivery, DebugDetails, addressOptionLabel } from './novoxpressShared.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import Spinner from './Spinner.jsx'

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

// Actions d'un retour (RMA) : achat d'étiquette de retour Novoxpress
// (client → Orisha, l'inverse d'un envoi sortant), génération de l'aide-mémoire,
// envoi des instructions au client. Rendu à même la fiche RetourDetail.jsx —
// plus de panneau latéral séparé.
export default function RetourActionsSection({ retour, onDone }) {
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
  // Comparaison avec les tarifs UPS directs (hors Novoxpress), même principe que
  // la modale d'étiquette des envois : lecture seule, l'achat passe par
  // Novoxpress. Le trajet tarifé est celui du retour (client → atelier).
  const [ups, setUps] = useState(null)
  const [upsLoading, setUpsLoading] = useState(false)
  const [upsError, setUpsError] = useState('')

  // /api/retours/memos/:filename est derrière requireAuth (contrairement aux
  // étiquettes, servies en statique sans auth) — un lien <a> classique n'envoie
  // pas le Bearer token, il faut donc le passer en query param (cf. CLAUDE.md,
  // requireAuth accepte ?token=, pattern déjà utilisé pour les iframes/downloads).
  const withToken = (url) => url ? `${url}?token=${localStorage.getItem('erp_token')}` : url
  const [memoStatus, setMemoStatus] = useState(retour.memo_pdf_path ? 'done' : 'idle')
  const [memoUrl, setMemoUrl] = useState(retour.memo_pdf_path ? withToken(`/erp/api/retours/memos/${retour.memo_pdf_path.split('/').pop()}`) : null)
  const [composerOpen, setComposerOpen] = useState(false)

  const loadContext = useCallback(() => {
    setLoadingContext(true)
    api.retours.context(retour.id)
      .then(res => { setContext(res); setAddressId(res.address?.id || null) })
      .catch(e => setError(e.message))
      .finally(() => setLoadingContext(false))
  }, [retour.id])

  useEffect(() => { loadContext() }, [loadContext])

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
    setUps(null); setUpsError('')
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

  async function handleCompareUps() {
    setUpsLoading(true); setUpsError(''); setUps(null)
    try {
      setUps(await api.ups.returnRates(retour.id, { address_id: addressId, packages: buildPackages() }))
    } catch (e) {
      // Message brut de l'API UPS — jamais un échec silencieux.
      setUpsError(e.message)
    } finally {
      setUpsLoading(false)
    }
  }

  // Rendue par appel de fonction (pas <UpsComparison />) pour ne pas recréer un
  // type de composant à chaque rendu.
  function renderUpsComparison() {
    return (
      <div className="border-t border-slate-100 pt-3 space-y-2" data-testid="ups-rate-comparison">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-slate-700 flex items-center gap-1.5"><Truck size={14} className="text-amber-700" /> Tarifs UPS (direct)</p>
          <button onClick={handleCompareUps} disabled={upsLoading} className="btn-secondary btn-sm text-xs" data-testid="ups-compare-rates">
            {upsLoading ? 'Interrogation…' : ups ? 'Rafraîchir' : 'Comparer avec UPS'}
          </button>
        </div>
        {upsError && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 whitespace-pre-wrap break-words" data-testid="ups-rate-error">{upsError}</p>
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
              Comparaison seulement — l'étiquette de retour s'achète via Novoxpress.
            </p>
          </>
        )}
        {ups?.customs?.length > 0 && (
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer select-none">Déclaration douanière (retour hors Canada)</summary>
            <ul className="mt-1 space-y-0.5">
              {ups.customs.map((c, i) => (
                <li key={i}>{c.qty} × {c.description} — {Number(c.unit_value).toFixed(2)} $ · origine {c.origin_country} · SH {c.hs_code}</li>
              ))}
            </ul>
          </details>
        )}
        {ups && !ups.rates?.length && !upsError && (
          <p className="text-xs text-slate-400">UPS n'a retourné aucun tarif pour ce retour.</p>
        )}
      </div>
    )
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
        ) : loadingContext ? (
          <p className="text-sm text-slate-400"><Spinner size="xs" label="Chargement…" /></p>
        ) : step === 'address' ? (
          <div className="space-y-3">
            {context?.candidates?.length > 0 ? (
              <>
                <label className="label">Adresse du client</label>
                <select className="input" value={addressId || ''} onChange={e => setAddressId(e.target.value)}>
                  {context.candidates.map(c => (
                    <option key={c.id} value={c.id}>
                      {addressOptionLabel(c)}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                Aucune adresse sur la fiche entreprise de ce retour.
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
                <input type="number" min="1" className="input text-center" value={custom.length} onChange={e => setCustom(c => ({ ...c, length: e.target.value }))} />
                <input type="number" min="1" className="input text-center" value={custom.width} onChange={e => setCustom(c => ({ ...c, width: e.target.value }))} />
                <input type="number" min="1" className="input text-center" value={custom.depth} onChange={e => setCustom(c => ({ ...c, depth: e.target.value }))} />
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
                <ErrorBanner>{error}</ErrorBanner>
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
                {renderUpsComparison()}
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
                <ErrorBanner>{error}</ErrorBanner>
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
          <p className="text-sm text-slate-500">Envoyées le {fmtDate(retour.instructions_sent_at)}.</p>
        ) : (
          <button onClick={() => setComposerOpen(true)} className="btn-primary text-sm whitespace-nowrap">Envoyer</button>
        )}
      </section>

      {/* « Envoyer » ouvre la composition : le courriel s'y voit et s'y modifie
          avant de partir (plus de bouton « Aperçu » séparé). */}
      <EmailComposerModal
        isOpen={composerOpen}
        onClose={() => setComposerOpen(false)}
        title="Instructions de retour"
        load={() => api.retours.instructionsEmail(retour.id)}
        onSend={({ to, cc, subject, bodyHtml }) => api.retours.sendInstructions(retour.id, { to, cc, subject, body_html: bodyHtml })}
        onSent={onDone}
      />
    </div>
  )
}
