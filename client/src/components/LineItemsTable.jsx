import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fmtCad } from '../utils/formatters.js'
import { fmtDate } from '../lib/formatDate.js'
import { api } from '../lib/api.js'

const liaOf = desc => (/^\s*(lia-\d+)/i.exec(String(desc || '')) || [])[1]?.toUpperCase() || null

// Achat désigné par le code LIA de la ligne : sa date de commande, et un avertissement
// quand l'achat n'était plus « À recevoir » (déjà reçu) ou qu'il est relié ailleurs.
function LinkedPurchase({ info }) {
  const out = info.pending_at_expense === false
  const others = info.other_links?.length || 0
  return (
    <div className="text-[11px] mt-0.5 flex gap-1.5 flex-wrap items-baseline">
      <Link to={`/purchases/${info.purchase_id}`} className="link-record">{info.lia_ref}</Link>
      <span
        className={out ? 'text-amber-700 font-medium' : 'text-slate-400'}
        title={out ? 'Déjà reçu — hors « À recevoir »' : undefined}
      >
        {out && '⚠ '}cmd {info.order_date ? fmtDate(info.order_date) : '?'}
      </span>
      {others > 0 && (
        <span
          className="text-amber-700"
          title={info.other_links.map(o => [o.reference, o.date, o.vendor].filter(Boolean).join(' · ')).join('\n')}
        >
          ⚠ relié {others}× ailleurs
        </span>
      )}
    </div>
  )
}

// `date` + `txnKey` (optionnels) : la dépense à laquelle appartiennent les lignes — sert à
// juger la date de commande des achats désignés par un code LIA.
export function LineItemsTable({ lines, date = null, txnKey = null }) {
  const items = (() => { try { return JSON.parse(lines || '[]') } catch { return [] } })()
  const refs = [...new Set(items.map(l => liaOf(l.description)).filter(Boolean))]
  const refsKey = refs.join(',')
  const [links, setLinks] = useState({})

  useEffect(() => {
    if (!refsKey) return
    let alive = true
    api.purchases.liaLinks({ refs: refsKey, ...(date ? { date } : {}), ...(txnKey ? { txn: txnKey } : {}) })
      .then(r => { if (alive) setLinks(r || {}) })
      .catch(() => {})
    return () => { alive = false }
  }, [refsKey, date, txnKey])

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
            {items.map((line, i) => {
              const info = links[liaOf(line.description)]
              return (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 text-slate-700">
                    {line.description || line.item_name || '—'}
                    {info && <LinkedPurchase info={info} />}
                  </td>
                  <td className="px-3 py-2 hidden sm:table-cell text-slate-500 text-xs">{line.account_name || line.item_name || '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCad(line.amount)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
