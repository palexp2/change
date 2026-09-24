import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { Modal } from '../components/Modal.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import Spinner from '../components/Spinner.jsx'

export default function ProductPurchaseModal({ productId, onClose, onCreated }) {
  const [prefill, setPrefill] = useState(null)
  const [quantity, setQuantity] = useState(1)
  const [supplierId, setSupplierId] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [createdId, setCreatedId] = useState(null)
  const submitting = useRef(false)

  useEffect(() => {
    let active = true
    api.products.purchasePrefill(productId).then(data => {
      if (!active) return
      setPrefill(data)
      setQuantity(data.quantity)
      setSupplierId(data.supplier_id)
    }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [productId])

  async function submit(e) {
    e.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      const purchase = createdId
        ? await api.products.syncPurchase(productId, createdId)
        : await api.products.createPurchase(productId, { quantity: Number(quantity), supplier_id: supplierId, notes })
      setCreatedId(purchase.id)
      onCreated(purchase)
      if (purchase.airtable.status === 'success') onClose()
      else setError(`Achat enregistré. Synchronisation Airtable à réessayer : ${purchase.airtable.error}`)
    } catch (e) {
      setError(e.message || 'Impossible d’ajouter l’achat.')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const selectedSupplier = prefill?.suppliers.find(s => s.id === supplierId)
  return (
    <Modal isOpen onClose={() => { if (!submitting.current) onClose() }} title="Ajouter un achat" size="sm">
      <form onSubmit={submit} className="space-y-4">
        {!prefill && !error && <Spinner />}
        {prefill && <>
          <div>
            <label htmlFor="purchase-quantity" className="block text-sm font-medium mb-1">Quantité</label>
            <input id="purchase-quantity" type="number" min="0.000001" step="any" required
              className="input-field w-full" value={quantity} disabled={busy || !!createdId}
              onChange={e => setQuantity(e.target.value)} />
          </div>
          <div>
            <div className="text-sm font-medium mb-1">Fournisseur</div>
            <SearchableSelect value={supplierId} options={prefill.suppliers} onChange={setSupplierId}
              getOptionValue={s => s.id} getOptionLabel={s => s.name} placeholder="Choisir un fournisseur"
              disabled={busy || !!createdId} size="sm" testId="product-purchase-supplier" />
            {selectedSupplier?.company_id && (
              <Link to={`/companies/${selectedSupplier.company_id}`} className="link-record text-xs"
                onClick={onClose}>{selectedSupplier.name}</Link>
            )}
            {!prefill.suppliers.length && <p className="text-sm text-amber-700 mt-1">Aucun fournisseur disponible. Synchronisez les achats depuis Airtable.</p>}
          </div>
          <div>
            <label htmlFor="purchase-note" className="block text-sm font-medium mb-1">Note</label>
            <textarea id="purchase-note" rows={3} className="input-field w-full" value={notes}
              disabled={busy || !!createdId} onChange={e => setNotes(e.target.value)} />
          </div>
        </>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>{createdId ? 'Fermer' : 'Annuler'}</button>
          <button type="submit" className="btn-primary" disabled={busy || !prefill || !supplierId || !(Number(quantity) > 0)}>
            {busy ? 'Enregistrement…' : createdId ? 'Réessayer la synchronisation' : 'Ajouter'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
