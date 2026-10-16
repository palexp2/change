import { fmtDate } from '../lib/formatDate.js'
import { fmtMoney as fmtMoneyBase } from '../utils/formatters.js'

/* Lignes « Remplacement » envoyées (`replacementRate.items` du dashboard) :
   colonnes partagées entre la section « Taux de remplacement » et la vue
   globale (clic sur un mois du graphique, en modale). */

const fmtCad = (n) => fmtMoneyBase(n, 'CAD', { fallback: '$0', zeroIsEmpty: true, maximumFractionDigits: 0 })

export const REPLACEMENT_COLS = [
  { key: 'order',   label: 'Commande',     width: 110, align: 'text-left',
    cellClass: 'text-slate-700 font-mono text-xs', render: it => `#${it.order_number}` },
  { key: 'company', label: 'Client',       width: 200, align: 'text-left',
    cellClass: 'text-slate-700', render: it => it.company_name || '—' },
  { key: 'product', label: 'Produit',      width: 260, align: 'text-left',
    cellClass: 'text-slate-700', render: it => it.product_name || '—' },
  { key: 'qty',     label: 'Qté',          width: 60,  align: 'text-center',
    cellClass: 'text-slate-600', render: it => it.qty },
  // Pas de « Coût unit. » : le champ « Coût unitaire » des articles de commande
  // a été retiré (2026-09-03), le coût d'une ligne se lit à son total.
  { key: 'total',   label: 'Total',        width: 100, align: 'text-right',
    cellClass: 'font-medium text-amber-700', render: it => fmtCad(it.total_cost) },
  { key: 'shipped', label: "Date d'envoi", width: 120, align: 'text-right',
    cellClass: 'text-slate-500', render: it => (it.shipped_at ? fmtDate(it.shipped_at) : '—') },
]

// Mois de la date affichée (et des points, calculés côté serveur) :
// new Date('2026-10-01') = 30 sept. 20h à Montréal → mauvais mois.
export function replacementItemsInMonth(items, monthKey) {
  return (items || []).filter(it => it.shipped_at && fmtDate(it.shipped_at).slice(0, 7) === monthKey)
}

export function ReplacementItemsTable({ items, onOpen, emptyLabel = 'Aucun remplacement' }) {
  return (
    <table className="w-full text-sm" data-testid="replacement-items-modal-table">
      <thead>
        <tr className="border-b border-slate-100">
          {REPLACEMENT_COLS.map(c => (
            <th key={c.key} className={`px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide ${c.align}`}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-50">
        {items.map((it, idx) => (
          <tr key={idx}
            onClick={it.order_id ? () => onOpen(it) : undefined}
            className={it.order_id ? 'hover:bg-slate-50 cursor-pointer transition-colors' : ''}
          >
            {REPLACEMENT_COLS.map(c => (
              <td key={c.key} className={`px-3 py-2 ${c.align} ${c.cellClass}`}>{c.render(it)}</td>
            ))}
          </tr>
        ))}
        {items.length === 0 && (
          <tr>
            <td colSpan={REPLACEMENT_COLS.length} className="px-3 py-4 text-center text-slate-400 text-sm">{emptyLabel}</td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
