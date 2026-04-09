import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'

const STATUS_COLORS = {
  pending: 'yellow',
  approved: 'blue',
  pushed: 'green',
  rejected: 'gray',
  error: 'red',
}
const STATUS_LABELS = {
  pending: 'En attente',
  approved: 'Approuvé',
  pushed: 'Publié QB',
  rejected: 'Rejeté',
  error: 'Erreur',
}

function fmtCents(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n / 100)
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { month: 'short', day: 'numeric', year: 'numeric' })
}

function StatusFilter({ value, onChange, counts }) {
  const statuses = ['all', 'pending', 'approved', 'pushed', 'rejected', 'error']
  const labels = { all: 'Tous', ...STATUS_LABELS }
  return (
    <div className="flex gap-1">
      {statuses.map(s => (
        <button
          key={s}
          onClick={() => onChange(s === 'all' ? '' : s)}
          className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
            (value || 'all') === (s === 'all' ? '' : s) || (s === 'all' && !value)
              ? 'bg-indigo-100 text-indigo-700'
              : 'text-slate-500 hover:bg-slate-100'
          }`}
        >
          {labels[s]}
          {counts[s] > 0 && <span className="ml-1 text-xs">({counts[s]})</span>}
        </button>
      ))}
    </div>
  )
}

function DetailModal({ invoice, onClose, onAction }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  if (!invoice) return null

  const lineItems = invoice.line_items || []
  const taxDetails = invoice.tax_details || []

  async function handleAction(action) {
    setLoading(true)
    setError('')
    try {
      if (action === 'approve') {
        await api.stripeQueue.approve(invoice.id)
      } else if (action === 'reject') {
        await api.stripeQueue.reject(invoice.id)
      } else if (action === 'reset') {
        await api.stripeQueue.reset(invoice.id)
      }
      onAction()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal isOpen={true} title={`Facture Stripe ${invoice.invoice_number || ''}`} onClose={onClose} size="xl">
      <div className="space-y-6">
        {error && <p className="text-red-600 text-sm bg-red-50 p-2 rounded">{error}</p>}

        {/* Header info */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-slate-500 uppercase">Client</p>
            <p className="font-medium">{invoice.customer_name || '—'}</p>
            {invoice.customer_email && <p className="text-sm text-slate-500">{invoice.customer_email}</p>}
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase">Date</p>
            <p className="font-medium">{fmtDate(invoice.invoice_date)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase">Statut</p>
            <Badge color={STATUS_COLORS[invoice.status]}>{STATUS_LABELS[invoice.status]}</Badge>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase">Devise</p>
            <p className="font-medium">{invoice.currency}</p>
          </div>
        </div>

        {/* Line items */}
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Articles</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="py-1 font-medium">Description</th>
                <th className="py-1 font-medium text-right">Qté</th>
                <th className="py-1 font-medium text-right">Montant</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((item, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-2">{item.description}</td>
                  <td className="py-2 text-right tabular-nums">{item.quantity}</td>
                  <td className="py-2 text-right tabular-nums">{fmtCents(item.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div className="bg-slate-50 rounded-lg p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-slate-600">Sous-total</span>
            <span className="tabular-nums">{fmtCents(invoice.subtotal)}</span>
          </div>
          {invoice.tax_amount > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-slate-600">
                Taxes
                {taxDetails.length > 0 && (
                  <span className="text-xs text-slate-400 ml-1">
                    ({taxDetails.map(t => t.tax_rate_id).join(', ')})
                  </span>
                )}
              </span>
              <span className="tabular-nums">{fmtCents(invoice.tax_amount)}</span>
            </div>
          )}
          <div className="flex justify-between font-semibold border-t pt-2">
            <span>Total</span>
            <span className="tabular-nums">{fmtCents(invoice.total)}</span>
          </div>
          {invoice.stripe_fee > 0 && (
            <div className="flex justify-between text-sm text-orange-600">
              <span>Frais Stripe</span>
              <span className="tabular-nums">-{fmtCents(invoice.stripe_fee)}</span>
            </div>
          )}
        </div>

        {/* QB info */}
        {invoice.quickbooks_id && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
            Publié sur QuickBooks — ID: {invoice.quickbooks_id}
          </div>
        )}

        {invoice.error_message && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
            {invoice.error_message}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 justify-end pt-2 border-t">
          {(invoice.status === 'pending' || invoice.status === 'error') && (
            <>
              <button
                onClick={() => handleAction('reject')}
                disabled={loading}
                className="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Rejeter
              </button>
              <button
                onClick={() => handleAction('approve')}
                disabled={loading}
                className="px-4 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {loading ? 'Publication...' : 'Approuver et publier QB'}
              </button>
            </>
          )}
          {invoice.status === 'rejected' && (
            <button
              onClick={() => handleAction('reset')}
              disabled={loading}
              className="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Remettre en attente
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}

function TaxMappingPanel({ open, onClose }) {
  const [mappings, setMappings] = useState([])
  const [uniqueRates, setUniqueRates] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ stripe_tax_id: '', stripe_tax_description: '', qb_tax_code: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [m, rates] = await Promise.all([
        api.stripeQueue.taxMappings(),
        api.stripeQueue.uniqueTaxRates(),
      ])
      setMappings(m)
      setUniqueRates(rates)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (open) load() }, [open, load])

  async function handleSave(e) {
    e.preventDefault()
    if (!form.stripe_tax_id || !form.qb_tax_code) return
    setSaving(true)
    try {
      await api.stripeQueue.saveTaxMapping(form)
      setForm({ stripe_tax_id: '', stripe_tax_description: '', qb_tax_code: '' })
      await load()
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id) {
    try {
      await api.stripeQueue.deleteTaxMapping(id)
      await load()
    } catch (e) {
      console.error(e)
    }
  }

  function selectRate(rate) {
    setForm(f => ({
      ...f,
      stripe_tax_id: rate.stripe_tax_id,
    }))
  }

  if (!open) return null

  const mappedIds = new Set(mappings.map(m => m.stripe_tax_id))
  const unmapped = uniqueRates.filter(r => !mappedIds.has(r.stripe_tax_id))

  return (
    <Modal isOpen={true} title="Configuration des taxes" onClose={onClose} size="lg">
      <div className="space-y-6">
        {/* Existing mappings */}
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Mappings actifs</h3>
          {loading ? (
            <p className="text-sm text-slate-400">Chargement...</p>
          ) : mappings.length === 0 ? (
            <p className="text-sm text-slate-400">Aucun mapping configuré</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="px-3 py-1 font-medium">ID Stripe</th>
                  <th className="px-3 py-1 font-medium">Description</th>
                  <th className="px-3 py-1 font-medium">Code QB</th>
                  <th className="py-1 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {mappings.map(m => (
                  <tr key={m.id} className="border-b border-slate-100">
                    <td className="px-3 py-2 font-mono text-xs">{m.stripe_tax_id}</td>
                    <td className="px-3 py-2 text-slate-500">{m.stripe_tax_description || ''}</td>
                    <td className="px-3 py-2 font-mono text-xs font-semibold">{m.qb_tax_code}</td>
                    <td className="py-2">
                      <button
                        onClick={() => handleDelete(m.id)}
                        className="text-red-400 hover:text-red-600 text-xs"
                        title="Supprimer"
                      >✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Unmapped tax rates found in invoices */}
        {unmapped.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Taux non mappés trouvés dans les factures</h3>
            <div className="flex flex-wrap gap-2">
              {unmapped.map(r => (
                <button
                  key={r.stripe_tax_id}
                  onClick={() => selectRate(r)}
                  className="px-3 py-1.5 text-xs font-mono bg-amber-50 border border-amber-200 text-amber-700 rounded-md hover:bg-amber-100 transition-colors"
                >
                  {r.stripe_tax_id}
                  {r.percentage ? ` (${r.percentage}%)` : ''}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Add form */}
        <form onSubmit={handleSave} className="bg-slate-50 rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold text-slate-700">Ajouter / modifier un mapping</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-500">ID Tax Rate Stripe *</label>
              <input
                type="text"
                value={form.stripe_tax_id}
                onChange={e => setForm(f => ({ ...f, stripe_tax_id: e.target.value }))}
                placeholder="txr_..."
                className="w-full mt-1 px-3 py-1.5 text-sm border border-slate-300 rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                required
              />
            </div>
            <div>
              <label className="text-xs text-slate-500">Code QB *</label>
              <input
                type="text"
                value={form.qb_tax_code}
                onChange={e => setForm(f => ({ ...f, qb_tax_code: e.target.value }))}
                placeholder="TAX, GST, NON..."
                className="w-full mt-1 px-3 py-1.5 text-sm border border-slate-300 rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                required
              />
            </div>
            <div>
              <label className="text-xs text-slate-500">Description</label>
              <input
                type="text"
                value={form.stripe_tax_description}
                onChange={e => setForm(f => ({ ...f, stripe_tax_description: e.target.value }))}
                placeholder="TPS+TVQ, HST..."
                className="w-full mt-1 px-3 py-1.5 text-sm border border-slate-300 rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving || !form.stripe_tax_id || !form.qb_tax_code}
              className="px-4 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Enregistrement...' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  )
}

export default function StripeQueue() {
  const [invoices, setInvoices] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [selected, setSelected] = useState(null)
  const [counts, setCounts] = useState({})
  const [taxPanelOpen, setTaxPanelOpen] = useState(false)
  const [batch, setBatch] = useState(null)
  const [batchPolling, setBatchPolling] = useState(false)

  const pollBatch = useCallback(async () => {
    try {
      const status = await api.stripeQueue.batchStatus()
      setBatch(status)
      if (!status.running) setBatchPolling(false)
    } catch {}
  }, [])

  useEffect(() => {
    if (!batchPolling) return
    const interval = setInterval(pollBatch, 2000)
    return () => clearInterval(interval)
  }, [batchPolling, pollBatch])

  async function startBatch() {
    try {
      await api.stripeQueue.batchEnrich()
      setBatchPolling(true)
      pollBatch()
    } catch (e) {
      console.error(e)
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = { limit: 100 }
      if (statusFilter) params.status = statusFilter
      const res = await api.stripeQueue.list(params)
      setInvoices(res.data)
      setTotal(res.total)
    } catch (e) {
      console.error('Load error:', e)
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  const loadCounts = useCallback(async () => {
    try {
      const all = await api.stripeQueue.list({ limit: 1 })
      const pending = await api.stripeQueue.list({ limit: 1, status: 'pending' })
      const pushed = await api.stripeQueue.list({ limit: 1, status: 'pushed' })
      const error = await api.stripeQueue.list({ limit: 1, status: 'error' })
      const rejected = await api.stripeQueue.list({ limit: 1, status: 'rejected' })
      setCounts({
        all: all.total,
        pending: pending.total,
        pushed: pushed.total,
        error: error.total,
        rejected: rejected.total,
      })
    } catch {}
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadCounts() }, [loadCounts])

  function handleAction() {
    setSelected(null)
    load()
    loadCounts()
  }

  return (
    <Layout title="Factures Stripe">
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-slate-800">Factures Stripe &rarr; QB</h1>
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-500">{total} facture{total !== 1 ? 's' : ''}</span>
            <button
              onClick={startBatch}
              disabled={batch?.running}
              className="px-3 py-1.5 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
              title="Synchroniser les factures depuis Stripe"
            >
              {batch?.running ? 'Sync en cours...' : 'Sync Stripe'}
            </button>
            <button
              onClick={() => setTaxPanelOpen(true)}
              className="p-2 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
              title="Configuration des taxes"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>

        <StatusFilter value={statusFilter} onChange={setStatusFilter} counts={counts} />

        {batch && (batch.running || batch.processed > 0) && (
          <div className="bg-white rounded-lg border border-slate-200 p-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-slate-700">
                {batch.running ? 'Synchronisation Stripe en cours...' : 'Synchronisation terminée'}
              </span>
              <span className="text-slate-500">
                {batch.processed}/{batch.total} factures
              </span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all ${batch.running ? 'bg-emerald-500' : 'bg-emerald-600'}`}
                style={{ width: batch.total ? `${(batch.processed / batch.total) * 100}%` : '0%' }}
              />
            </div>
            {!batch.running && (
              <div className="flex gap-4 text-xs text-slate-500">
                <span>{batch.updated} mises à jour</span>
                <span>{batch.created} créées</span>
                {batch.errors.length > 0 && (
                  <span className="text-red-500">{batch.errors.length} erreur(s)</span>
                )}
              </div>
            )}
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-slate-400">Chargement...</div>
        ) : invoices.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            {statusFilter ? 'Aucune facture avec ce statut' : 'Aucune facture en attente. Les factures Stripe apparaissent ici automatiquement.'}
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b text-left text-slate-600">
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">N&deg; Facture</th>
                  <th className="px-4 py-3 font-medium">Client</th>
                  <th className="px-4 py-3 font-medium text-right">Total</th>
                  <th className="px-4 py-3 font-medium text-right">Frais Stripe</th>
                  <th className="px-4 py-3 font-medium">Statut</th>
                  <th className="px-4 py-3 font-medium">QB</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map(inv => (
                  <tr
                    key={inv.id}
                    onClick={() => setSelected(inv)}
                    className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 text-slate-500">{fmtDate(inv.invoice_date)}</td>
                    <td className="px-4 py-3 font-mono text-xs">{inv.invoice_number || '—'}</td>
                    <td className="px-4 py-3">
                      <span className="font-medium">{inv.customer_name || '—'}</span>
                      {inv.customer_email && (
                        <span className="text-xs text-slate-400 ml-2">{inv.customer_email}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium">{fmtCents(inv.total)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-orange-500">
                      {inv.stripe_fee ? `-${fmtCents(inv.stripe_fee)}` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge color={STATUS_COLORS[inv.status]}>{STATUS_LABELS[inv.status]}</Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">
                      {inv.quickbooks_id ? `#${inv.quickbooks_id}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <DetailModal
        invoice={selected}
        onClose={() => setSelected(null)}
        onAction={handleAction}
      />

      <TaxMappingPanel
        open={taxPanelOpen}
        onClose={() => setTaxPanelOpen(false)}
      />
    </Layout>
  )
}
