import { useState, useEffect, useMemo, useCallback } from 'react'
import { Plus, Trash2, ExternalLink, Search, AlertTriangle, Check } from 'lucide-react'
import api from '../lib/api.js'
import { Modal } from './Modal.jsx'
import { SendPaymentLinkModal } from './SendPaymentLinkModal.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { computeCanadaTaxes } from '../lib/taxes.js'

const inputCls = 'border border-slate-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500'

function fmtMoney(n, currency = 'CAD') {
  try { return new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(n) }
  catch { return `${Number(n).toFixed(2)} $` }
}

export function CreateInvoiceModal({ companyId, initialMode = 'new', isOpen, onClose, onCreated }) {
  const { addToast } = useToast()
  const [mode, setMode] = useState(initialMode)
  const [shipping, setShipping] = useState(null) // {province, country, line1, ...} or null
  const [shippingLoading, setShippingLoading] = useState(true)
  const [products, setProducts] = useState([])
  const [soumissions, setSoumissions] = useState([])
  const [selectedSoumissionId, setSelectedSoumissionId] = useState('')
  const [items, setItems] = useState([emptyItem()])
  const [dueDays, setDueDays] = useState(30)
  const [sendEmail, setSendEmail] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null) // { invoice_number, hosted_invoice_url, status, email }
  const [sendModalOpen, setSendModalOpen] = useState(false)

  useEffect(() => { setMode(initialMode) }, [initialMode, isOpen])

  // Load shipping + products + convertible soumissions in parallel
  useEffect(() => {
    if (!isOpen || !companyId) return
    setShippingLoading(true)
    setError(null)
    Promise.all([
      api.stripeInvoices.shippingProvince(companyId),
      api.products.list({ active: 'true', limit: 'all' }),
      api.stripeInvoices.convertibleSoumissions(companyId),
    ]).then(([shipResp, prodResp, sumResp]) => {
      setShipping(shipResp)
      const all = (prodResp.data || prodResp || [])
      setProducts(all.filter(p => p.is_sellable === 1 || p.is_sellable === true))
      setSoumissions(sumResp.data || [])
    }).catch(e => setError(e.message))
      .finally(() => setShippingLoading(false))
  }, [isOpen, companyId])

  // When user picks a soumission, load its items and replace current items
  const loadSoumission = useCallback(async (soumissionId) => {
    if (!soumissionId) { setItems([emptyItem()]); return }
    try {
      const r = await api.stripeInvoices.soumissionItems(soumissionId)
      const loaded = (r.data || []).map(it => ({
        tempId: tmpId(),
        product_id: it.product_id || null,
        qty: Number(it.qty) || 1,
        unit_price: Number(it.unit_price) || 0,
        description: it.description || (it.sku ? `${it.sku} — ${it.description || ''}`.trim() : 'Article'),
      }))
      setItems(loaded.length > 0 ? loaded : [emptyItem()])
    } catch (e) { setError(e.message) }
  }, [])

  useEffect(() => {
    if (mode === 'convert' && selectedSoumissionId) loadSoumission(selectedSoumissionId)
  }, [mode, selectedSoumissionId, loadSoumission])

  // Totals + taxes
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
  function addCustomLine() {
    setItems(arr => [...arr, emptyItem()])
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

  async function handleSubmit() {
    setError(null)
    if (!shipping?.province) {
      setError('Aucune adresse de livraison avec province trouvée. Créez une adresse de livraison sur la fiche entreprise avant de générer une facture.')
      return
    }
    const cleanItems = items
      .map(it => ({
        product_id: it.product_id || null,
        qty: Number(it.qty),
        unit_price: Number(it.unit_price),
        description: String(it.description || '').trim(),
      }))
      .filter(it => it.qty > 0 && it.description)
    if (cleanItems.length === 0) {
      setError('Ajoutez au moins une ligne valide (qty > 0 et description).')
      return
    }
    setSubmitting(true)
    try {
      // On crée toujours en draft. Si l'utilisateur a coché "Envoyer par email",
      // on ouvre la modale de personnalisation après la création.
      const r = await api.stripeInvoices.create({
        company_id: companyId,
        soumission_id: mode === 'convert' ? selectedSoumissionId || null : null,
        items: cleanItems,
        shipping_province: shipping.province,
        shipping_country: shipping.country || 'Canada',
        send_email: false,
        due_days: Number(dueDays) || 30,
      })
      setResult(r)
      onCreated?.(r)
      if (sendEmail) {
        setSendModalOpen(true)
      } else {
        addToast({ message: 'Facture créée en draft', type: 'success' })
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const noShippingProvince = !shippingLoading && !shipping?.province

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Nouvelle facture Stripe" size="xl">
      <div className="p-5 space-y-4 overflow-y-auto">
        {result ? (
          <SuccessView result={result} onClose={onClose} />
        ) : (
          <>
            {/* Mode tabs */}
            <div className="flex gap-2 border-b border-slate-200 -mt-2">
              <TabBtn active={mode === 'new'} onClick={() => setMode('new')}>Nouvelle facture</TabBtn>
              <TabBtn
                active={mode === 'convert'}
                disabled={soumissions.length === 0}
                onClick={() => setMode('convert')}
                title={soumissions.length === 0 ? 'Aucune soumission convertible (non expirée)' : ''}
              >
                Convertir une soumission ({soumissions.length})
              </TabBtn>
            </div>

            {mode === 'convert' && (
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Soumission</label>
                <select className={`${inputCls} w-full`} value={selectedSoumissionId} onChange={e => setSelectedSoumissionId(e.target.value)}>
                  <option value="">— Choisir une soumission —</option>
                  {soumissions.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.quote_number ? `#${s.quote_number} ` : ''}{s.title || '(sans titre)'} — {s.status} — {fmtMoney(s.subtotal || 0, s.currency || 'CAD')} — exp. {s.expiration_date || '∞'}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Shipping address summary */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Adresse de livraison (utilisée pour les taxes)</div>
              {shippingLoading ? (
                <span className="text-slate-400">Chargement…</span>
              ) : noShippingProvince ? (
                <div className="flex items-start gap-2 text-amber-700">
                  <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="font-medium">Aucune adresse de livraison avec province</div>
                    <div className="text-amber-600 text-xs mt-0.5">Créez une adresse de livraison sur la fiche entreprise avant de pouvoir générer une facture.</div>
                  </div>
                </div>
              ) : (
                <div className="text-slate-700">
                  {[shipping.line1, shipping.city, shipping.province, shipping.postal_code, shipping.country].filter(Boolean).join(', ')}
                </div>
              )}
            </div>

            {/* Items */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-slate-700">Lignes</h3>
                <button onClick={addCustomLine} className="inline-flex items-center gap-1 px-2 py-1 text-xs text-brand-600 hover:bg-brand-50 rounded">
                  <Plus size={12} /> Ligne custom
                </button>
              </div>
              <div className="space-y-2">
                {items.map(it => (
                  <ItemRow
                    key={it.tempId}
                    item={it}
                    products={products}
                    onChange={patch => updateItem(it.tempId, patch)}
                    onPickProduct={p => pickProduct(it.tempId, p)}
                    onRemove={() => removeItem(it.tempId)}
                  />
                ))}
              </div>
            </div>

            {/* Totals */}
            <div className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="flex justify-between"><span className="text-slate-600">Sous-total</span><span className="font-medium">{fmtMoney(subtotal)}</span></div>
              {taxes.map(t => (
                <div key={t.name + t.percentage} className="flex justify-between text-slate-600">
                  <span>{t.name} ({t.percentage}%)</span><span>{fmtMoney(t.amount)}</span>
                </div>
              ))}
              <div className="flex justify-between mt-1 pt-2 border-t border-slate-100 font-semibold text-slate-900">
                <span>Total</span><span>{fmtMoney(total)}</span>
              </div>
              {taxes.length === 0 && shipping?.province && (
                <div className="text-xs text-slate-400 mt-1">Aucune taxe ne s'applique à cette province.</div>
              )}
            </div>

            {/* Options */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Échéance (jours)</label>
                <input type="number" min={0} className={`${inputCls} w-full`} value={dueDays} onChange={e => setDueDays(e.target.value)} />
              </div>
              <div className="flex items-end">
                <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={sendEmail} onChange={e => setSendEmail(e.target.checked)} className="rounded" />
                  Envoyer par email Gmail (statut Stripe → ouvert si envoyé, sinon draft)
                </label>
              </div>
            </div>

            {error && (
              <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} className="px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 rounded-lg">Annuler</button>
              <button
                onClick={handleSubmit}
                disabled={submitting || noShippingProvince || shippingLoading}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50"
              >
                {submitting ? 'Création…' : 'Créer la facture'}
              </button>
            </div>
          </>
        )}
      </div>

      <SendPaymentLinkModal
        pendingInvoiceId={result?.pending_invoice_id}
        isOpen={sendModalOpen}
        onClose={() => setSendModalOpen(false)}
        onSent={r => {
          setResult(prev => ({ ...prev, status: 'sent', email: { sent_to: r.email?.sent_to, from: r.email?.from } }))
        }}
      />
    </Modal>
  )
}

function TabBtn({ active, disabled, onClick, children, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-3 py-2 text-sm border-b-2 -mb-px ${active ? 'border-brand-600 text-brand-600 font-medium' : 'border-transparent text-slate-500 hover:text-slate-700'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
    >{children}</button>
  )
}

function ItemRow({ item, products, onChange, onPickProduct, onRemove }) {
  return (
    <div className="grid grid-cols-12 gap-2 items-start">
      <div className="col-span-5">
        <ProductPicker products={products} value={item.product_id} description={item.description} onPick={onPickProduct} onChangeDescription={d => onChange({ description: d })} />
      </div>
      <input type="number" min={0} step={0.01} className={`${inputCls} col-span-2`} value={item.qty} onChange={e => onChange({ qty: e.target.value })} placeholder="Qté" />
      <input type="number" min={0} step={0.01} className={`${inputCls} col-span-2`} value={item.unit_price} onChange={e => onChange({ unit_price: e.target.value })} placeholder="Prix unit." />
      <div className="col-span-2 text-right pt-1.5 text-sm text-slate-700">{fmtMoney((Number(item.qty) || 0) * (Number(item.unit_price) || 0))}</div>
      <button onClick={onRemove} className="col-span-1 p-1.5 text-slate-300 hover:text-red-500" title="Retirer"><Trash2 size={14} /></button>
    </div>
  )
}

function ProductPicker({ products, value, description, onPick, onChangeDescription }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase()
    if (!qq) return products.slice(0, 50)
    return products.filter(p =>
      (p.sku || '').toLowerCase().includes(qq) ||
      (p.name_fr || '').toLowerCase().includes(qq) ||
      (p.name_en || '').toLowerCase().includes(qq)
    ).slice(0, 50)
  }, [products, q])
  const selected = useMemo(() => products.find(p => p.id === value), [products, value])

  return (
    <div className="relative">
      <input
        value={description}
        onChange={e => onChangeDescription(e.target.value)}
        onFocus={() => setOpen(true)}
        className={`${inputCls} w-full`}
        placeholder={selected?.sku ? `${selected.sku} — ${selected.name_fr || ''}` : 'Description ou produit…'}
      />
      {open && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-72 flex flex-col" onMouseLeave={() => setOpen(false)}>
          <div className="p-2 border-b border-slate-100 flex items-center gap-1.5">
            <Search size={14} className="text-slate-400" />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} className="flex-1 text-sm focus:outline-none" placeholder="Rechercher SKU ou nom…" />
          </div>
          <div className="overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-3 text-xs text-slate-400">Aucun produit</div>
            ) : filtered.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => { onPick(p); setOpen(false); setQ('') }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-brand-50 flex items-start gap-2 ${value === p.id ? 'bg-brand-50' : ''}`}
              >
                <Check size={14} className={`mt-0.5 ${value === p.id ? 'text-brand-600' : 'text-transparent'}`} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-900 truncate">{p.name_fr || p.name_en}</div>
                  <div className="text-xs text-slate-500 font-mono">{p.sku} · {fmtMoney(p.price_cad)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SuccessView({ result, onClose }) {
  const isSent = result.status === 'sent'
  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-green-50 border border-green-200 p-4">
        <div className="font-semibold text-green-900">{isSent ? 'Facture envoyée' : 'Facture en draft'}</div>
        <div className="text-sm text-green-800 mt-1">Statut : <span className="font-mono">{isSent ? 'En attente paiement' : 'Draft'}</span></div>
        {result.email?.sent_to && (
          <div className="text-sm text-green-800 mt-1">Email envoyé à <span className="font-medium">{result.email.sent_to}</span> depuis <span className="font-mono">{result.email.from}</span></div>
        )}
        {result.email?.reason && (
          <div className="text-sm text-amber-700 mt-1">Email non envoyé : {labelEmailReason(result.email.reason)}</div>
        )}
      </div>
      {result.pay_url && (
        <div className="rounded-lg border border-slate-200 p-3 text-sm">
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Lien de paiement permanent</div>
          <a href={result.pay_url} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline break-all font-mono text-xs">{result.pay_url}</a>
          <div className="text-xs text-slate-400 mt-1">Ce lien reste valide pour toujours — il génère une nouvelle session Stripe Checkout au besoin.</div>
        </div>
      )}
      <div className="flex justify-end gap-2">
        {result.pending_invoice_id && (
          <a href={`/erp/factures/${result.pending_invoice_id}`} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-brand-600 hover:bg-brand-50 rounded-lg border border-brand-200">
            <ExternalLink size={14} /> Voir la facture
          </a>
        )}
        <button onClick={onClose} className="px-3 py-2 text-sm bg-slate-900 text-white rounded-lg">Fermer</button>
      </div>
    </div>
  )
}

function labelEmailReason(r) {
  if (r === 'gmail_not_connected') return 'Aucun compte Gmail connecté pour votre utilisateur.'
  if (r === 'no_recipient_email') return "Aucune adresse email trouvée pour l'entreprise ou ses contacts."
  if (r === 'send_email=false') return 'Envoi décoché — facture restée en draft.'
  return r
}

function emptyItem() { return { tempId: tmpId(), product_id: null, qty: 1, unit_price: 0, description: '' } }
function tmpId() { return Math.random().toString(36).slice(2, 10) }
