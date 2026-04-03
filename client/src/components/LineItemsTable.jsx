function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

export function LineItemsTable({ lines }) {
  const items = (() => { try { return JSON.parse(lines || '[]') } catch { return [] } })()
  if (!items.length) return null

  return (
    <div>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Lignes de détail</p>
      <div className="rounded-lg border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500">Description</th>
              <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500 hidden sm:table-cell">Compte</th>
              <th className="text-right px-3 py-2 text-xs font-semibold text-slate-500">Montant</th>
            </tr>
          </thead>
          <tbody>
            {items.map((line, i) => (
              <tr key={i} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-2 text-slate-700">{line.description || line.item_name || '—'}</td>
                <td className="px-3 py-2 hidden sm:table-cell text-slate-500 text-xs">{line.account_name || line.item_name || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCad(line.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
