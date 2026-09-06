import { useState, useEffect, useMemo } from 'react'
import { Plus, Trash2, ExternalLink, AlertTriangle, RefreshCw } from 'lucide-react'
import api from '../lib/api.js'
import { Modal } from './Modal.jsx'
import { ProductPicker } from './ProductPicker.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { computeCanadaTaxes } from '../lib/taxes.js'
import { fmtMoney as fmtMoneyBase } from '../utils/formatters.js'
import ErrorBanner from './ErrorBanner.jsx'
import Spinner from './Spinner.jsx'

const inputCls = 'border border-slate-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500'
const fmtMoney = (n, currency = 'CAD') => fmtMoneyBase(n, currency, { nullIsZero: true })

// Fréquences proposées. `value` encode l'intervalle Stripe + le nombre
// d'intervalles ; Stripe plafonne à 12 mois ou 1 an.
const FREQUENCIES = [
  { value: 'month:1', label: 'Mensuel', per: 'mois' },
  { value: 'month:3', label: 'Trimestriel', per: 'trimestre' },
  { value: 'month:6', label: 'Semestriel', per: '6 mois' },
  { value: 'year:1', label: 'Annuel', per: 'an' },
]

export function CreateSubscriptionModal({ companyId, isOpen, onClose, onCreated }) {
  const { addToast } = useToast()
  const [shipping, setShipping] = useState(null)
  const [billing, setBilling] = useState(null) // { stripe_configured, customer_id, email, payment_methods }
  const [loading, setLoading] = useState(true)
  const [products, setProducts] = useState([])
  const [items, setItems] = useState([emptyItem()])
  const [frequency, setFrequency] = useState('month:1')
  const [currency, setCurrency] = useState('CAD')
  const [collectionMethod, setCollectionMethod] = useState('send_invoice')
  const [paymentMethodId, setPaymentMethodId] = useState('')
  const [dueDays, setDueDays] = useState(30)
  const [trialDays, setTrialDays] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  // Réinitialise le formulaire à chaque ouverture : rouvrir la modale après une
  // création ne doit pas ré-afficher l'écran de succès précédent.
  useEffect(() => {
    if (!isOpen) return
    setItems([emptyItem()])
    setFrequency('month:1')
    setCurrency('CAD')
    setCollectionMethod('send_invoice')
    setPaymentMethodId('')
    setDueDays(30)
    setTrialDays(0)
    setResult(null)
    setError(null)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || !companyId) return
    setLoading(true)
    Promise.all([
      api.stripeInvoices.shippingProvince(companyId),
      api.products.list({ active: 'true', limit: 'all' }),
      api.stripeSubscriptions.billingContext(companyId),
    ]).then(([shipResp, prodResp, billResp]) => {
      setShipping(shipResp)
      const all = (prodResp.data || prodResp || [])
      setProducts(all.filter(p => p.is_sellable === 1 || p.is_sellable === true))
      setBilling(billResp)
      const def = (billResp.payment_methods || []).find(pm => pm.is_default) || (billResp.payment_methods || [])[0]
      if (def) setPaymentMethodId(def.id)
    }).catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [isOpen, companyId])

  const freq = FREQUENCIES.find(f => f.value === frequency) || FREQUENCIES[0]
  const cards = billing?.payment_methods || []

  const { subtotal, taxes, total } = useMemo(() => {
    const sub = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0)
    const taxList = computeCanadaTaxes({
      province: shipping?.province,
      country: shipping?.country || 'Canada',
      subtotal: sub,
    })
    const taxSum = taxList.reduce((s, t) => s + (t.amount || 0), 0)
    return { subtotal: sub, taxes: taxList, total: sub + taxSum }
  }, [items, shipping])

  function updateItem(tempId, patch) {
    setItems(arr => arr.map(it => it.tempId === tempId ? { ...it, ...patch } : it))
  }
  function removeItem(tempId) {
    setItems(arr => arr.length > 1 ? arr.filter(it => it.tempId !== tempId) : [emptyItem()])
  }
  function pickProduct(tempId, product) {
    if (!product) return
    updateItem(tempId, {
      product_id: product.id,
      description: product.name_fr || product.name_en || product.sku || 'Article',
      unit_price: Number(product.price_cad) || 0,
      qty: 1,
    })
  }

  const cleanItems = useMemo(() => items
    .map(it => ({
      product_id: it.product_id || null,
      qty: Math.floor(Number(it.qty)) || 0,
      unit_price: Number(it.unit_price),
      description: String(it.description || '').trim(),
    }))
    .filter(it => it.qty > 0 && it.description && Number.isFinite(it.unit_price)), [items])

  const noShippingProvince = !loading && !shipping?.province
  const noStripe = !loading && billing && billing.stripe_configured === false
  const noEmail = !loading && billing && !billing.email

  // Étape 1 — validation locale, puis confirmation explicite des side effects
  // (création réelle dans Stripe, facturation récurrente du client).
  function handleSubmit() {
    setError(null)
    if (!shipping?.province) {
      setError("Aucune adresse de livraison avec province trouvée. Créez une adresse de livraison sur la fiche entreprise avant de créer un abonnement.")
      return
    }
    if (cleanItems.length === 0) {
      setError('Ajoutez au moins une ligne valide (quantité > 0 et description).')
      return
    }
    if (collectionMethod === 'charge_automatically' && !paymentMethodId) {
      setError('Choisissez une carte enregistrée, ou passez à la facturation par courriel.')
      return
    }
    if (collectionMethod === 'send_invoice' && !billing?.email) {
      setError("Aucun courriel connu pour cette entreprise : Stripe ne pourrait pas envoyer la facture. Ajoutez un courriel à l'entreprise ou à un contact.")
      return
    }
    setConfirmOpen(true)
  }

  async function doCreate() {
    setConfirmOpen(false)
    setError(null)
    setSubmitting(true)
    const [interval, intervalCount] = frequency.split(':')
    try {
      const r = await api.stripeSubscriptions.create({
        company_id: companyId,
        items: cleanItems,
        interval,
        interval_count: Number(intervalCount),
        currency,
        collection_method: collectionMethod,
        days_until_due: Number(dueDays) || 30,
        trial_days: Number(trialDays) || 0,
        payment_method_id: collectionMethod === 'charge_automatically' ? paymentMethodId : null,
        shipping_province: shipping.province,
        shipping_country: shipping.country || 'Canada',
      })
      setResult(r)
      onCreated?.(r)
      addToast({ message: 'Abonnement créé dans Stripe', type: 'success' })
    } catch (e) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Nouvel abonnement Stripe" size="xl">
      <div className="p-5 space-y-4 overflow-y-auto">
        {result ? (
          <SuccessView result={result} onClose={onClose} />
        ) : (
          <>
            {noStripe && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
                Stripe n'est pas configuré — impossible de créer un abonnement.
              </div>
            )}

            {/* Adresse : détermine les taxes appliquées à chaque facture récurrente */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className="label">Adresse de livraison (utilisée pour les taxes)</div>
              {loading ? (
                <span className="text-slate-400"><Spinner size="xs" label="Chargement…" /></span>
              ) : noShippingProvince ? (
                <div className="flex items-start gap-2 text-amber-700">
                  <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="font-medium">Aucune adresse de livraison avec province</div>
                    <div className="text-amber-600 text-xs mt-0.5">Créez une adresse de livraison sur la fiche entreprise avant de pouvoir créer un abonnement.</div>
                  </div>
                </div>
              ) : (
                <div className="text-slate-700">
                  {[shipping.line1, shipping.city, shipping.province, shipping.postal_code, shipping.country].filter(Boolean).join(', ')}
                </div>
              )}
            </div>

            {/* Lignes récurrentes */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-slate-700">Lignes facturées à chaque période</h3>
                <button onClick={() => setItems(arr => [...arr, emptyItem()])} className="inline-flex items-center gap-1 px-2 py-1 text-xs text-brand-600 hover:bg-brand-50 rounded">
                  <Plus size={12} /> Ligne custom
                </button>
              </div>
              <div className="space-y-2">
                {items.map(it => (
                  <div key={it.tempId} className="grid grid-cols-12 gap-2 items-start">
                    <div className="col-span-5">
                      <ProductPicker
                        products={products}
                        value={it.product_id}
                        description={it.description}
                        onPick={p => pickProduct(it.tempId, p)}
                        onChangeDescription={d => updateItem(it.tempId, { description: d })}
                      />
                    </div>
                    <input type="number" min={1} step={1} className={`${inputCls} col-span-2`} value={it.qty} onChange={e => updateItem(it.tempId, { qty: e.target.value })} />
                    <input type="number" min={0} step={0.01} className={`${inputCls} col-span-2`} value={it.unit_price} onChange={e => updateItem(it.tempId, { unit_price: e.target.value })} />
                    <div className="col-span-2 text-right pt-1.5 text-sm text-slate-700">
                      {fmtMoney((Number(it.qty) || 0) * (Number(it.unit_price) || 0), currency)}
                    </div>
                    <button onClick={() => removeItem(it.tempId)} className="col-span-1 p-1.5 text-slate-300 hover:text-red-500" title="Retirer"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            </div>

            {/* Récurrence */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Fréquence</label>
                <select className={`${inputCls} w-full`} value={frequency} onChange={e => setFrequency(e.target.value)} data-testid="subscription-frequency">
                  {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Devise</label>
                <select className={`${inputCls} w-full`} value={currency} onChange={e => setCurrency(e.target.value)}>
                  <option value="CAD">CAD</option>
                  <option value="USD">USD</option>
                </select>
              </div>
              <div>
                <label className="label">Essai gratuit (jours)</label>
                <input type="number" min={0} className={`${inputCls} w-full`} value={trialDays} onChange={e => setTrialDays(e.target.value)} />
              </div>
            </div>

            {/* Mode de facturation */}
            <div>
              <div className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Facturation</div>
              <div className="space-y-2">
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    className="mt-1"
                    checked={collectionMethod === 'send_invoice'}
                    onChange={() => setCollectionMethod('send_invoice')}
                    data-testid="subscription-collection-send-invoice"
                  />
                  <span>
                    <span className="font-medium">Facture envoyée par Stripe</span>
                    <span className="block text-xs text-slate-500">
                      À chaque période, Stripe envoie une facture payable en ligne{billing?.email ? ` à ${billing.email}` : ''}.
                      {noEmail && <span className="text-amber-700"> Aucun courriel connu pour cette entreprise.</span>}
                    </span>
                  </span>
                </label>
                {collectionMethod === 'send_invoice' && (
                  <div className="ml-6 flex items-center gap-2">
                    <span className="text-xs text-slate-500">Échéance</span>
                    <input type="number" min={0} className={`${inputCls} w-24`} value={dueDays} onChange={e => setDueDays(e.target.value)} />
                    <span className="text-xs text-slate-500">jours</span>
                  </div>
                )}
                <label className={`flex items-start gap-2 text-sm ${cards.length === 0 ? 'text-slate-400' : 'text-slate-700'}`}>
                  <input
                    type="radio"
                    className="mt-1"
                    disabled={cards.length === 0}
                    checked={collectionMethod === 'charge_automatically'}
                    onChange={() => setCollectionMethod('charge_automatically')}
                    data-testid="subscription-collection-card"
                  />
                  <span>
                    <span className="font-medium">Prélèvement automatique sur une carte enregistrée</span>
                    <span className="block text-xs text-slate-500">
                      {cards.length === 0
                        ? "Aucune carte enregistrée chez Stripe pour ce client — le client doit d'abord payer une fois par carte."
                        : 'La carte est débitée automatiquement à chaque période.'}
                    </span>
                  </span>
                </label>
                {collectionMethod === 'charge_automatically' && cards.length > 0 && (
                  <div className="ml-6">
                    <select className={`${inputCls} w-full max-w-md`} value={paymentMethodId} onChange={e => setPaymentMethodId(e.target.value)}>
                      {cards.map(pm => (
                        <option key={pm.id} value={pm.id}>{pm.label}{pm.is_default ? ' — par défaut' : ''}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>

            {/* Totaux par période */}
            <div className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="flex justify-between"><span className="text-slate-600">Sous-total / {freq.per}</span><span className="font-medium">{fmtMoney(subtotal, currency)}</span></div>
              {taxes.map(t => (
                <div key={t.name + t.percentage} className="flex justify-between text-slate-600">
                  <span>{t.name} ({t.percentage}%)</span><span>{fmtMoney(t.amount, currency)}</span>
                </div>
              ))}
              <div className="flex justify-between mt-1 pt-2 border-t border-slate-100 font-semibold text-slate-900">
                <span>Total / {freq.per}</span><span>{fmtMoney(total, currency)}</span>
              </div>
              {taxes.length === 0 && shipping?.province && (
                <div className="text-xs text-slate-400 mt-1">Aucune taxe ne s'applique à cette province.</div>
              )}
            </div>

            {error && (
              <ErrorBanner>{error}</ErrorBanner>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} className="px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 rounded-lg">Annuler</button>
              <button
                onClick={handleSubmit}
                disabled={submitting || loading || noShippingProvince || noStripe}
                data-testid="create-subscription-submit"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50"
              >
                {submitting ? 'Création…' : "Créer l'abonnement"}
              </button>
            </div>
          </>
        )}
      </div>

      <ConfirmCreateModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={doCreate}
        total={total}
        currency={currency}
        per={freq.per}
        itemCount={cleanItems.length}
        collectionMethod={collectionMethod}
        email={billing?.email}
        trialDays={Number(trialDays) || 0}
      />
    </Modal>
  )
}

// Confirmation explicite des side effects : la création touche un système tiers
// (Stripe) et engage une facturation récurrente du client. Rien n'est exécuté
// avant que l'utilisateur ait vu cette liste.
function ConfirmCreateModal({ isOpen, onClose, onConfirm, total, currency, per, itemCount, collectionMethod, email, trialDays }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Confirmer la création de l'abonnement" size="md">
      <div className="space-y-4" data-testid="confirm-create-subscription">
        <p className="text-sm text-slate-600">
          Cette action déclenche les effets suivants. Vérifiez avant de confirmer :
        </p>
        <ul className="space-y-2 text-sm">
          <li className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-amber-500" />
            <span className="text-slate-700">
              Un abonnement <span className="font-medium">Stripe</span> de{' '}
              <span className="font-semibold">{fmtMoney(total, currency)} / {per}</span>{' '}
              (taxes incluses, {itemCount} ligne{itemCount > 1 ? 's' : ''}) sera créé dans Stripe.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-amber-500" />
            <span className="text-slate-700">
              {collectionMethod === 'send_invoice'
                ? <>Stripe enverra une <span className="font-medium">facture par courriel</span>{email ? <> à <span className="font-medium">{email}</span></> : null} à chaque période.</>
                : <>La <span className="font-medium">carte enregistrée</span> du client sera débitée automatiquement à chaque période.</>}
            </span>
          </li>
          {trialDays > 0 && (
            <li className="flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-amber-500" />
              <span className="text-slate-700">
                La première facturation n'aura lieu qu'après <span className="font-medium">{trialDays} jour{trialDays > 1 ? 's' : ''}</span> d'essai gratuit.
              </span>
            </li>
          )}
        </ul>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 rounded-lg">Annuler</button>
          <button
            onClick={onConfirm}
            data-testid="confirm-create-subscription-btn"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg"
          >
            Confirmer et créer
          </button>
        </div>
      </div>
    </Modal>
  )
}

function SuccessView({ result, onClose }) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-green-50 border border-green-200 p-4">
        <div className="font-semibold text-green-900 flex items-center gap-2"><RefreshCw size={16} /> Abonnement créé</div>
        <div className="text-sm text-green-800 mt-1">Statut Stripe : <span className="font-mono">{result.status}</span></div>
        <div className="text-xs text-green-700 mt-1 font-mono break-all">{result.subscription_id}</div>
      </div>
      {result.hosted_invoice_url && (
        <div className="rounded-lg border border-slate-200 p-3 text-sm">
          <div className="label">Première facture</div>
          <a href={result.hosted_invoice_url} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline break-all font-mono text-xs">{result.hosted_invoice_url}</a>
        </div>
      )}
      <div className="flex justify-end gap-2">
        {result.stripe_url && (
          <a href={result.stripe_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-brand-600 hover:bg-brand-50 rounded-lg border border-brand-200">
            <ExternalLink size={14} /> Ouvrir dans Stripe
          </a>
        )}
        <button onClick={onClose} className="px-3 py-2 text-sm bg-slate-900 text-white rounded-lg">Fermer</button>
      </div>
    </div>
  )
}

function emptyItem() { return { tempId: Math.random().toString(36).slice(2, 10), product_id: null, qty: 1, unit_price: 0, description: '' } }
