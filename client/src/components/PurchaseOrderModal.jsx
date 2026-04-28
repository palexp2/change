import { useState, useEffect, useMemo, useRef } from 'react'
import { Mail, Download, Plus, Trash2, RefreshCw, CheckCircle, Search } from 'lucide-react'
import { api } from '../lib/api.js'
import { Modal } from './Modal.jsx'

const inp = 'w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:border-indigo-400 bg-white'

function AddressFields({ label, value, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v })
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</h3>
      <input className={inp} placeholder="Société" value={value.company || ''} onChange={e => set('company', e.target.value)} />
      <input className={inp} placeholder="Adresse ligne 1" value={value.address1 || ''} onChange={e => set('address1', e.target.value)} />
      <input className={inp} placeholder="Adresse ligne 2" value={value.address2 || ''} onChange={e => set('address2', e.target.value)} />
      <input className={inp} placeholder="Nom du contact" value={value.contact || ''} onChange={e => set('contact', e.target.value)} />
      <input className={inp} placeholder="Téléphone" value={value.phone || ''} onChange={e => set('phone', e.target.value)} />
      <input className={inp} placeholder="Courriel" value={value.email || ''} onChange={e => set('email', e.target.value)} />
    </div>
  )
}

export function PurchaseOrderModal({ productId, isOpen, onClose }) {
  const [loading, setLoading] = useState(false)
  const [po, setPo] = useState(null)
  const [_supplierEmail, setSupplierEmail] = useState('')
  const [supplierContacts, setSupplierContacts] = useState([])
  const [supplierProducts, setSupplierProducts] = useState([])
  const [pdfUrl, setPdfUrl] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [showSend, setShowSend] = useState(false)
  const [emailTo, setEmailTo] = useState('')
  const [emailToMode, setEmailToMode] = useState('select') // 'select' | 'custom'
  const [emailCc, setEmailCc] = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  const [emailBody, setEmailBody] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [fromAccount, setFromAccount] = useState('')
  const [gmailAccounts, setGmailAccounts] = useState([])

  useEffect(() => {
    if (!isOpen) return
    setLoading(true)
    setError('')
    setSent(false)
    setShowSend(false)
    setPdfUrl(null)
    setFromAccount('')
    api.connectors.gmailAccounts().then(accts => {
      setGmailAccounts(accts)
      const mine = accts.find(a => a.is_current_user)
      if (mine) setFromAccount(mine.account_email)
    }).catch(() => setGmailAccounts([]))
    api.products.poPrefill(productId)
      .then(data => {
        setPo(data)
        setSupplierEmail(data.supplier_email || '')
        const contacts = data.supplier_contacts || []
        setSupplierContacts(contacts)
        setSupplierProducts(data.supplier_products || [])
        const defaultTo = data.supplier_email || (contacts[0]?.email || '')
        setEmailTo(defaultTo)
        const isKnown = contacts.some(c => c.email === defaultTo)
        setEmailToMode(isKnown || !defaultTo ? 'select' : 'custom')
        const t = emailTemplate(data.lang, data.po_number)
        setEmailSubject(t.subject)
        setEmailBody(t.body)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, productId])

  function setField(k, v) {
    setPo(p => {
      const next = { ...p, [k]: v }
      if (k === 'lang' || k === 'po_number') {
        const prev = emailTemplate(p.lang, p.po_number)
        if (emailSubject === prev.subject) setEmailSubject(emailTemplate(next.lang, next.po_number).subject)
        if (emailBody === prev.body) setEmailBody(emailTemplate(next.lang, next.po_number).body)
      }
      return next
    })
  }

  function setItem(i, k, v) {
    setPo(p => {
      const items = [...p.items]
      items[i] = { ...items[i], [k]: k === 'product' ? v : (parseFloat(v) || 0) }
      return { ...p, items }
    })
  }

  function addItem() {
    setPo(p => ({ ...p, items: [...p.items, { product: '', qty: 1, rate: 0 }] }))
  }

  function addSupplierProduct(sp) {
    setPo(p => ({
      ...p,
      items: [...p.items, {
        product_id: sp.id,
        product: sp.label || '',
        qty: Number(sp.order_qty) > 0 ? Number(sp.order_qty) : 1,
        rate: Number(sp.unit_cost) || 0,
      }],
    }))
  }

  function removeItem(i) {
    setPo(p => ({ ...p, items: p.items.filter((_, idx) => idx !== i) }))
  }

  async function previewPdf() {
    setGenerating(true)
    setError('')
    try {
      const blob = await api.products.poPdfBlob(productId, po)
      if (pdfUrl) URL.revokeObjectURL(pdfUrl)
      setPdfUrl(URL.createObjectURL(blob))
    } catch (e) {
      setError(e.message)
    } finally {
      setGenerating(false)
    }
  }

  async function downloadPdf() {
    setGenerating(true)
    setError('')
    try {
      const blob = await api.products.poPdfBlob(productId, po)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${po.po_number}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e.message)
    } finally {
      setGenerating(false)
    }
  }

  async function handleSend() {
    if (!emailTo || !emailTo.includes('@')) { setError('Adresse courriel invalide'); return }
    setSending(true)
    setError('')
    try {
      await api.products.poSendEmail(productId, {
        to: emailTo,
        cc: emailCc || undefined,
        subject: emailSubject,
        body_html: emailBody.split('\n').map(l => `<p>${escapeHtml(l)}</p>`).join(''),
        from_account: fromAccount || undefined,
        po,
      })
      setSent(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setSending(false)
    }
  }

  const total = (po?.items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0)

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Bon de commande" size="xl">
      {loading || !po ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" />
        </div>
      ) : sent ? (
        <div className="space-y-4 text-center py-8">
          <div className="flex flex-col items-center gap-3">
            <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle size={28} className="text-green-600" />
            </div>
            <h3 className="font-semibold text-slate-900 text-lg">Bon de commande envoyé</h3>
            <p className="text-sm text-slate-500">Envoyé à <span className="font-medium text-slate-700">{emailTo}</span>.</p>
          </div>
          <button onClick={onClose} className="btn-secondary">Fermer</button>
        </div>
      ) : showSend ? (
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase mb-1">Envoyer depuis</label>
            <select className={inp} value={fromAccount} onChange={e => setFromAccount(e.target.value)}>
              <option value="">— choisir un compte —</option>
              {gmailAccounts.map(a => (
                <option key={a.account_email} value={a.account_email}>
                  {a.account_email}{a.is_current_user ? ' (vous)' : ''}
                </option>
              ))}
            </select>
            {!gmailAccounts.some(a => a.is_current_user) && (
              <p className="text-xs text-amber-700 mt-1">
                Votre compte Gmail n'est pas connecté. Connectez-le dans Connectors, ou sélectionnez un autre compte pour envoyer.
              </p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase mb-1">Destinataire</label>
            {emailToMode === 'select' && supplierContacts.length > 0 ? (
              <select
                className={inp}
                value={emailTo}
                onChange={e => {
                  if (e.target.value === '__custom__') {
                    setEmailToMode('custom')
                    setEmailTo('')
                  } else {
                    setEmailTo(e.target.value)
                  }
                }}
              >
                {supplierContacts.map(c => (
                  <option key={c.id} value={c.email}>
                    {[c.first_name, c.last_name].filter(Boolean).join(' ')} — {c.email}
                  </option>
                ))}
                <option value="__custom__">Autre / Saisir manuellement…</option>
              </select>
            ) : (
              <>
                <input className={inp} value={emailTo} onChange={e => setEmailTo(e.target.value)} placeholder="fournisseur@exemple.com" />
                {supplierContacts.length > 0 && (
                  <button
                    onClick={() => {
                      setEmailToMode('select')
                      setEmailTo(supplierContacts[0].email)
                    }}
                    className="text-xs text-indigo-600 hover:underline mt-1"
                  >
                    ← Choisir dans la liste des contacts
                  </button>
                )}
              </>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase mb-1">Cc</label>
            <input className={inp} value={emailCc} onChange={e => setEmailCc(e.target.value)} placeholder="optionnel" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase mb-1">Sujet</label>
            <input className={inp} value={emailSubject} onChange={e => setEmailSubject(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase mb-1">Message</label>
            <textarea className={inp} rows={6} value={emailBody} onChange={e => setEmailBody(e.target.value)} />
          </div>
          <p className="text-xs text-slate-500">
            Le PDF <span className="font-mono">{po.po_number}.pdf</span> sera attaché automatiquement.
          </p>
          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>}
          <div className="flex justify-between gap-3 pt-2">
            <button onClick={() => setShowSend(false)} className="btn-secondary">Retour</button>
            <button onClick={handleSend} disabled={sending || !emailTo || !fromAccount} className="btn-primary flex items-center gap-1.5">
              {sending
                ? <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> Envoi…</>
                : <><Mail size={14} /> Envoyer</>
              }
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Header fields */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase mb-1">N° PO</label>
              <input className={inp} value={po.po_number} onChange={e => setField('po_number', e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase mb-1">Date</label>
              <input type="date" className={inp} value={po.date} onChange={e => setField('date', e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase mb-1">Devise</label>
              <select className={inp} value={po.currency} onChange={e => setField('currency', e.target.value)}>
                <option value="CAD">CAD</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase mb-1">Langue</label>
              <select className={inp} value={po.lang} onChange={e => setField('lang', e.target.value)}>
                <option value="fr">Français</option>
                <option value="en">English</option>
              </select>
            </div>
            <div className="col-span-2 md:col-span-4">
              <label className="block text-xs font-medium text-slate-500 uppercase mb-1">Fournisseur</label>
              <input className={inp} value={po.supplier} onChange={e => setField('supplier', e.target.value)} />
            </div>
            <div className="col-span-2 md:col-span-4">
              <label className="block text-xs font-medium text-slate-500 uppercase mb-1">Détails</label>
              <input className={inp} value={po.details || ''} onChange={e => setField('details', e.target.value)} placeholder="optionnel" />
            </div>
          </div>

          {/* Addresses */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <AddressFields label="Facturer à" value={po.bill_to} onChange={v => setField('bill_to', v)} />
            <AddressFields label="Expédier à" value={po.ship_to} onChange={v => setField('ship_to', v)} />
          </div>

          {/* Items */}
          <div>
            <div className="flex items-center justify-between mb-2 gap-3">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Articles</h3>
              <div className="flex items-center gap-3">
                <SupplierProductPicker
                  products={supplierProducts}
                  existingIds={new Set((po.items || []).map(it => it.product_id).filter(Boolean))}
                  onPick={addSupplierProduct}
                />
                <button onClick={addItem} className="text-xs text-indigo-600 hover:underline flex items-center gap-1">
                  <Plus size={12} /> Ligne vide
                </button>
              </div>
            </div>
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500">Produit</th>
                    <th className="text-right px-3 py-2 text-xs font-semibold text-slate-500 w-24">Qté</th>
                    <th className="text-right px-3 py-2 text-xs font-semibold text-slate-500 w-28">Tarif</th>
                    <th className="text-right px-3 py-2 text-xs font-semibold text-slate-500 w-28">Montant</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {po.items.map((it, i) => {
                    const amt = (Number(it.qty) || 0) * (Number(it.rate) || 0)
                    return (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="px-2 py-1.5">
                          <input className={inp} value={it.product} onChange={e => setItem(i, 'product', e.target.value)} />
                        </td>
                        <td className="px-2 py-1.5">
                          <input type="number" min="0" step="1" className={`${inp} text-right`} value={it.qty} onChange={e => setItem(i, 'qty', e.target.value)} />
                        </td>
                        <td className="px-2 py-1.5">
                          <input type="number" min="0" step="0.01" className={`${inp} text-right`} value={it.rate} onChange={e => setItem(i, 'rate', e.target.value)} />
                        </td>
                        <td className="px-3 py-1.5 text-right text-slate-700 font-medium">{amt.toFixed(2)}</td>
                        <td className="px-1">
                          <button onClick={() => removeItem(i)} className="p-1 text-slate-400 hover:text-red-500" title="Retirer">
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 border-t border-slate-200">
                    <td colSpan={3} className="px-3 py-2 text-right text-xs font-semibold text-slate-500 uppercase">Total</td>
                    <td className="px-3 py-2 text-right font-bold text-slate-900">{total.toFixed(2)} {po.currency}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* PDF preview */}
          {pdfUrl && (
            <div className="border border-slate-200 rounded-lg overflow-hidden" style={{ height: 500 }}>
              <iframe src={pdfUrl} className="w-full h-full" title="Aperçu PO" />
            </div>
          )}

          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>}

          <div className="flex flex-wrap justify-between gap-3 pt-2">
            <div className="flex gap-2">
              <button onClick={previewPdf} disabled={generating} className="btn-secondary flex items-center gap-1.5">
                <RefreshCw size={14} /> {pdfUrl ? 'Régénérer l\'aperçu' : 'Aperçu PDF'}
              </button>
              <button onClick={downloadPdf} disabled={generating} className="btn-secondary flex items-center gap-1.5">
                <Download size={14} /> Télécharger
              </button>
            </div>
            <button onClick={() => setShowSend(true)} className="btn-primary flex items-center gap-1.5">
              <Mail size={14} /> Envoyer au fournisseur
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function SupplierProductPicker({ products, existingIds, onPick }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0) }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = products || []
    if (!q) return list.slice(0, 50)
    return list.filter(p =>
      (p.label || '').toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q)
    ).slice(0, 50)
  }, [products, query])

  if (!products || products.length === 0) return null

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen(o => !o)}
        className="text-xs text-indigo-600 hover:underline flex items-center gap-1"
        type="button"
      >
        <Plus size={12} /> Ajouter une pièce du fournisseur
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-80 bg-white border border-slate-200 rounded-lg shadow-lg z-20">
          <div className="p-2 border-b border-slate-100 flex items-center gap-2">
            <Search size={14} className="text-slate-400" />
            <input
              ref={inputRef}
              className="w-full text-sm focus:outline-none"
              placeholder="Rechercher une pièce…"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-slate-500">Aucun résultat</div>
            ) : filtered.map(p => {
              const already = existingIds.has(p.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={already}
                  onClick={() => { onPick(p); setOpen(false); setQuery('') }}
                  className={`w-full text-left px-3 py-1.5 text-sm flex items-center justify-between gap-2 ${already ? 'text-slate-400 cursor-not-allowed' : 'hover:bg-slate-50 text-slate-700'}`}
                >
                  <span className="truncate">
                    {p.label || p.sku || '—'}
                    {p.sku && p.label && <span className="text-slate-400"> · {p.sku}</span>}
                  </span>
                  {already
                    ? <span className="text-[10px] uppercase text-slate-400">déjà ajouté</span>
                    : (p.order_qty > 0 && <span className="text-[10px] text-amber-600">à cmdr: {p.order_qty}</span>)
                  }
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function emailTemplate(lang, poNumber) {
  if (lang === 'en') {
    return {
      subject: `Purchase order ${poNumber}`,
      body: `Hello,\n\nPlease find attached our purchase order ${poNumber}.\n\nThank you,\nAutomatisation Orisha inc.`,
    }
  }
  return {
    subject: `Bon de commande ${poNumber}`,
    body: `Bonjour,\n\nVous trouverez ci-joint notre bon de commande ${poNumber}.\n\nMerci,\nAutomatisation Orisha inc.`,
  }
}
