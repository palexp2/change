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

export default function StripeQueue() {
  const [invoices, setInvoices] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [selected, setSelected] = useState(null)
  const [counts, setCounts] = useState({})

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
          <span className="text-sm text-slate-500">{total} facture{total !== 1 ? 's' : ''}</span>
        </div>

        <StatusFilter value={statusFilter} onChange={setStatusFilter} counts={counts} />

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
    </Layout>
  )
}
