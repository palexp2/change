import { useState, useMemo } from 'react'
import { Search, Check } from 'lucide-react'
import { fmtMoney } from '../utils/formatters.js'

const inputCls = 'border border-slate-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500'

// Champ « description » doublé d'un sélecteur de produit recherchable : on tape
// librement, ou on choisit un produit du catalogue qui remplit description + prix.
// Partagé par la création de facture et la création d'abonnement.
export function ProductPicker({ products, value, description, onPick, onChangeDescription }) {
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
        placeholder={selected?.sku ? `${selected.sku} — ${selected.name_fr || ''}` : undefined}
      />
      {open && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-72 flex flex-col" onMouseLeave={() => setOpen(false)}>
          <div className="p-2 border-b border-slate-100 flex items-center gap-1.5">
            <Search size={14} className="text-slate-400" />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} className="flex-1 text-sm focus:outline-none" />
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
                  <div className="text-xs text-slate-500 font-mono">{p.sku} · {fmtMoney(p.price_cad, 'CAD', { nullIsZero: true })}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
