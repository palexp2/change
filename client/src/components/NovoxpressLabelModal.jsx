import { useState } from 'react'
import { fmtMoney } from '../utils/formatters.js'
import { ChevronRight, CheckCircle, Download, AlertTriangle, RefreshCw, Stethoscope, Truck } from 'lucide-react'
import api from '../lib/api.js'
import NovoxpressDiagnosticPanel from './NovoxpressDiagnosticPanel.jsx'
import { BOX_PRESETS, fmtPrice, getRateName, getRateCarrier, getRateDelivery, DebugDetails } from './novoxpressShared.jsx'
import ErrorBanner from './ErrorBanner.jsx'

export default function NovoxpressLabelModal({ envoi, orderItemsTotalWeight, onClose, onDone }) {
  const [step, setStep] = useState('package') // 'package' | 'rates' | 'confirm' | 'done'
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
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState('')
  // Diagnostic en env dev Novoxpress (système temporaire) — rempli soit par le
  // serveur (auto sur erreur opaque), soit par le bouton « Diagnostiquer en dev ».
  const [diagnostic, setDiagnostic] = useState(null)
  const [diagLoading, setDiagLoading] = useState(false)
  // Comparaison avec les tarifs UPS directs (hors Novoxpress). Lecture seule :
  // l'achat d'étiquette sortante passe toujours par Novoxpress ; UPS sert ici
  // à savoir si le tarif Novoxpress est concurrentiel.
  const [ups, setUps] = useState(null) // { rates, customs, environment }
  const [upsLoading, setUpsLoading] = useState(false)
  const [upsError, setUpsError] = useState('')

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
    setDiagnostic(null)
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
      setDiagnostic(e.details?.diagnostic || null)
    } finally {
      setLoading(false)
    }
  }

  // Diagnostic manuel en env dev (le serveur ne le lance automatiquement que
  // pour les erreurs opaques — ce bouton couvre les autres cas).
  async function handleDiagnose(op) {
    setDiagLoading(true)
    try {
      const res = await api.novoxpress.diagnostic(envoi.id, {
        op,
        packaging_type: packagingType(),
        packages: buildPackages(),
        declared_value: declaredValue || '1',
        service_id: selectedRate?.service_id || undefined,
        prod_error: error || undefined,
      })
      setDiagnostic(res)
    } catch (e) {
      setDiagnostic({ available: true, verdict: 'not_isolated', message: `Le diagnostic lui-même a échoué : ${e.message}`, attempts: [] })
    } finally {
      setDiagLoading(false)
    }
  }

  async function handleConfirm() {
    setLoading(true)
    setError('')
    setErrorDetails(null)
    setDiagnostic(null)

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
      setStep('done')
      onDone?.()
    } catch (e) {
      setError(e.message)
      setErrorDetails({
        sent: e.details?.sent || sentPayload,
        responseBody: e.details?.responseBody || null,
        novoxpressStatus: e.details?.novoxpressStatus || null,
      })
      setDiagnostic(e.details?.diagnostic || null)
    } finally {
      setLoading(false)
    }
  }

  // Re-télécharge le PDF d'une étiquette déjà achetée (ne re-facture pas).
  async function handleRetryPdf() {
    setRetrying(true)
    setRetryError('')
    try {
      const res = await api.novoxpress.retryLabelPdf(envoi.id)
      setResult(r => ({ ...r, label_url: res.label_url, label_error: null, tracking_id: r?.tracking_id || res.tracking_id }))
      onDone?.()
    } catch (e) {
      setRetryError(e.message)
    } finally {
      setRetrying(false)
    }
  }

  async function handleCompareUps() {
    setUpsLoading(true); setUpsError(''); setUps(null)
    try {
      const res = await api.ups.shipmentRates(envoi.id, { packages: buildPackages() })
      setUps(res)
    } catch (e) {
      // Message brut de l'API UPS — jamais un échec silencieux.
      setUpsError(e.message)
    } finally {
      setUpsLoading(false)
    }
  }

  // Rendue par appel de fonction (pas <UpsComparison />) pour ne pas recréer un
  // type de composant à chaque rendu du modal.
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
              Comparaison seulement — l'achat d'étiquette sortante passe par Novoxpress.
            </p>
          </>
        )}
        {ups?.customs?.length > 0 && (
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer select-none">Déclaration douanière (envoi hors Canada)</summary>
            <ul className="mt-1 space-y-0.5">
              {ups.customs.map((c, i) => (
                <li key={i}>{c.qty} × {c.description} — {Number(c.unit_value).toFixed(2)} $ · origine {c.origin_country} · SH {c.hs_code}</li>
              ))}
            </ul>
          </details>
        )}
        {ups && !ups.rates?.length && !upsError && (
          <p className="text-xs text-slate-400">UPS n'a retourné aucun tarif pour cet envoi.</p>
        )}
      </div>
    )
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
            <input type="number" min="1" className="input text-center" value={custom.length} onChange={e => setCustom(c => ({ ...c, length: e.target.value }))} />
            <input type="number" min="1" className="input text-center" value={custom.width}  onChange={e => setCustom(c => ({ ...c, width: e.target.value }))} />
            <input type="number" min="1" className="input text-center" value={custom.depth}  onChange={e => setCustom(c => ({ ...c, depth: e.target.value }))} />
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
          <ErrorBanner>{error}</ErrorBanner>
          <NovoxpressDiagnosticPanel diagnostic={diagnostic} />
          {!diagnostic?.available && (
            <button onClick={() => handleDiagnose('rate')} disabled={diagLoading} className="btn-secondary text-sm flex items-center gap-1.5">
              {diagLoading
                ? <><div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-slate-500" /> Diagnostic en cours… (~20 s)</>
                : <><Stethoscope size={14} /> Diagnostiquer en dev</>}
            </button>
          )}
          <DebugDetails details={errorDetails} />
          <div className="flex justify-between">
            <button onClick={() => { setStep('package'); setError(''); setErrorDetails(null); setDiagnostic(null) }} className="btn-secondary">← Retour</button>
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
          {renderUpsComparison()}
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
            <p>Valeur déclarée : <span className="font-medium">{fmtMoney(Math.ceil(totalValue))}</span></p>
            <p className="text-blue-600">Note : les coordonnées de votre broker doivent être configurées dans votre compte Novoxpress.</p>
          </div>
        )
      })()}
      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
        Cette action va facturer l'étiquette sur votre compte Novoxpress.
        <br />Le ramassage du colis se commande séparément après l'achat de l'étiquette.
        <br />En cas d'erreur inexpliquée, un diagnostic automatique (~20 s, environnement de test, aucun achat) tentera d'en isoler la cause.
      </p>
      {error && (
        <>
          <ErrorBanner>{error}</ErrorBanner>
          <NovoxpressDiagnosticPanel diagnostic={diagnostic} />
          {!diagnostic?.available && (
            <button onClick={() => handleDiagnose('label')} disabled={diagLoading} className="btn-secondary text-sm flex items-center gap-1.5">
              {diagLoading
                ? <><div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-slate-500" /> Diagnostic en cours… (~20 s)</>
                : <><Stethoscope size={14} /> Diagnostiquer en dev</>}
            </button>
          )}
          <DebugDetails details={errorDetails} />
        </>
      )}
      <div className="flex justify-between gap-3 pt-2">
        <button onClick={() => { setStep('rates'); setError(''); setErrorDetails(null); setDiagnostic(null) }} disabled={loading} className="btn-secondary">← Retour</button>
        <button onClick={handleConfirm} disabled={loading} className="btn-primary flex items-center gap-1.5">
          {loading
            ? <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> Création…</>
            : <><CheckCircle size={14} /> Confirmer et acheter</>
          }
        </button>
      </div>
    </div>
  )

  // ── Step: done ──
  if (step === 'done') {
    // Achat réussi mais PDF non téléchargé (ex. 403 du CDN Novoxpress). L'étiquette
    // EST payée et l'envoi marqué « Envoyé » — on confirme l'achat et on propose
    // de réessayer le téléchargement, sans re-facturer.
    const pdfMissing = !result?.label_url
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <div className={`w-14 h-14 rounded-full flex items-center justify-center ${pdfMissing ? 'bg-amber-100' : 'bg-green-100'}`}>
            {pdfMissing
              ? <AlertTriangle size={28} className="text-amber-600" />
              : <CheckCircle size={28} className="text-green-600" />}
          </div>
          <h3 className="font-semibold text-slate-900 text-lg">
            {pdfMissing ? 'Étiquette achetée — PDF à récupérer' : 'Étiquette créée !'}
          </h3>
          {result?.tracking_id && (
            <p className="text-sm text-slate-600">
              N° de suivi : <span className="font-mono font-semibold text-slate-900">{result.tracking_id}</span>
            </p>
          )}
          {result?.tracking_url && (
            <a
              href={result.tracking_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-brand-600 hover:underline"
              data-testid="direct-carrier-tracking-link"
            >
              Suivre le colis sur Novoxpress
            </a>
          )}
          {result?.shipment_id && (
            <p className="text-xs text-slate-400">
              N° Novoxpress : <span className="font-mono">{result.shipment_id}</span>
            </p>
          )}
        </div>

        {pdfMissing ? (
          <>
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800 space-y-2">
              <p className="font-semibold flex items-center gap-1.5">
                <CheckCircle size={15} className="text-green-600" /> L'achat de l'étiquette a bien été effectué.
              </p>
              <p>
                Votre compte Novoxpress a été facturé et l'envoi est marqué « Envoyé ».
                Seul le <span className="font-medium">téléchargement du PDF</span> a échoué — l'étiquette,
                elle, existe bien chez Novoxpress.
              </p>
              {result?.label_error && (
                <p className="text-xs text-amber-700">
                  Raison du blocage : <span className="font-mono break-all">{result.label_error}</span>
                </p>
              )}
              <p className="text-xs">
                Aucune nouvelle facturation : « Réessayer » récupère le même PDF déjà acheté.
              </p>
            </div>
            {retryError && (
              <ErrorBanner>
                {retryError}
              </ErrorBanner>
            )}
            <button
              onClick={handleRetryPdf}
              disabled={retrying}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {retrying
                ? <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> Téléchargement…</>
                : <><RefreshCw size={15} /> Réessayer le téléchargement</>}
            </button>
            <button onClick={onClose} className="btn-secondary w-full">Fermer (récupérable plus tard depuis l'envoi)</button>
          </>
        ) : (
          <>
            <a
              href={result?.label_url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary w-full flex items-center justify-center gap-2"
            >
              <Download size={15} /> Télécharger l'étiquette PDF
            </a>
            <p className="text-xs text-slate-500 text-center">
              Le ramassage du colis se commande séparément depuis la fiche de l'envoi.
            </p>
            <button onClick={onClose} className="btn-primary w-full">Fermer</button>
          </>
        )}
      </div>
    )
  }

  return null
}
