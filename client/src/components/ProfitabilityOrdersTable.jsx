import { fmtDate } from '../lib/formatDate.js'
import { fmtMoney as fmtMoneyBase } from '../utils/formatters.js'

/* Tableau des commandes expédiées de la section « Rentabilité » du dashboard,
   partagé avec la vue globale (clic sur un point du graphique de marge brute,
   en modale). Les commandes viennent de `recentShippedOrders` du dashboard. */

const fmtCad = (n) => fmtMoneyBase(n, 'CAD', { fallback: '$0', zeroIsEmpty: true, maximumFractionDigits: 0 })

const DAY = 86400000

// Fenêtre de 28 jours d'un point du graphique : `weekKey` = lundi (AAAA-MM-JJ)
// de la dernière semaine de la fenêtre. Renvoie les bornes [start, end[ et la
// date de fin (dimanche) pour l'étiquette.
export function rollingWindow(weekKey) {
  const [yr, mo, dy] = weekKey.split('-').map(Number)
  const monday = new Date(yr, mo - 1, dy)
  return {
    start: new Date(monday.getTime() - 21 * DAY),
    end: new Date(monday.getTime() + 7 * DAY),
    label: fmtDate(new Date(monday.getTime() + 6 * DAY)),
  }
}

export function ordersInWindow(orders, { start, end }) {
  return (orders || []).filter(o => {
    if (!o.last_shipped_at) return false
    const t = new Date(o.last_shipped_at).getTime()
    return t >= start.getTime() && t < end.getTime()
  })
}

const TH = 'px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide'

export function ProfitabilityOrdersTable({ orders, onOpen, emptyLabel = 'Aucune commande' }) {
  return (
    <table className="w-full text-sm" data-testid="profitability-orders-table">
      <thead>
        <tr className="border-b border-slate-100">
          <th className={`${TH} text-left`}>#</th>
          <th className={`${TH} text-left`}>Entreprise</th>
          <th className={`${TH} text-left`}>Type</th>
          <th className={`${TH} text-left`}>Dernier envoi</th>
          <th className={`${TH} text-right`}>Revenus</th>
          <th className={`${TH} text-right`}>Coûts</th>
          <th className={`${TH} text-right`}>Marge</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-50">
        {orders.map(order => {
          const margin = (order.revenue || 0) - (order.cogs || 0)
          const marginPct = order.revenue > 0 ? Math.round((margin / order.revenue) * 100) : null
          return (
            <tr key={order.id}
              onClick={() => onOpen(order)}
              className="hover:bg-slate-50 cursor-pointer transition-colors"
            >
              <td className="px-3 py-2.5 font-mono font-medium text-slate-900">#{order.order_number}</td>
              <td className="px-3 py-2.5 text-slate-700">{order.company_name || <span className="text-slate-400">—</span>}</td>
              <td className="px-3 py-2.5">
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${order.is_subscription ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-500'}`}>
                  {order.is_subscription ? 'Abonnement' : 'Achat'}
                </span>
              </td>
              <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{fmtDate(order.last_shipped_at, { year: undefined })}</td>
              <td className="px-3 py-2.5 text-right font-medium text-slate-700 tabular-nums">{fmtCad(order.revenue)}</td>
              <td className="px-3 py-2.5 text-right text-slate-500 tabular-nums">{fmtCad(order.cogs)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                <span className={`font-semibold ${marginPct === null ? 'text-slate-400' : marginPct >= 40 ? 'text-green-600' : marginPct >= 20 ? 'text-amber-500' : 'text-red-500'}`}>
                  {marginPct !== null ? `${marginPct}%` : '—'}
                </span>
              </td>
            </tr>
          )
        })}
        {orders.length === 0 && (
          <tr>
            <td colSpan={7} className="px-3 py-4 text-center text-slate-400 text-sm">{emptyLabel}</td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
