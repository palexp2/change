import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { fmtNumber } from '../utils/formatters.js'
import Spinner from './Spinner.jsx'

// Module « Stock » de la fiche produit / pièce : montre d'où vient chaque
// quantité calculée par Boréal (inventaire, sera disponible, seuil dynamique,
// quantité à commander). Deux variantes :
//  - pièce achetée : le pourquoi de la quantité à commander ;
//  - produit fabriqué / drop ship : seuils minimaux + # de série disponibles.

const n = v => fmtNumber(v ?? 0)
const cmp = (a, b) => a < b ? '<' : a > b ? '>' : '='

function Tile({ label, value, tone = 'slate', testId, raw, onSave }) {
  const tones = {
    slate: 'text-slate-800', red: 'text-red-600', green: 'text-emerald-600', amber: 'text-amber-600',
  }
  const [draft, setDraft] = useState(raw ?? '')
  useEffect(() => { setDraft(raw ?? '') }, [raw])
  const commit = () => {
    if (String(draft) !== String(raw ?? '')) onSave(draft === '' ? null : Number(draft))
  }
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 min-w-0" data-testid={testId}>
      <div className="text-xs text-slate-400 truncate">{label}</div>
      {onSave ? (
        <input type="number" step="1" value={draft} aria-label={label}
          onChange={e => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setDraft(raw ?? '') }}
          className={`w-full bg-transparent text-xl font-semibold tabular-nums ${tones[tone]} rounded -mx-1 px-1 hover:bg-slate-50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300`} />
      ) : (
        <div className={`text-xl font-semibold tabular-nums ${tones[tone]}`}>{value}</div>
      )}
    </div>
  )
}

// Ligne d'une équation : « + Reçu 12 ».
function Term({ sign, label, value, strong, keep }) {
  if (!strong && !keep && !value) return null
  return (
    <div className={`flex justify-between gap-3 text-sm ${strong ? 'border-t border-slate-200 mt-1 pt-1 font-semibold text-slate-800' : 'text-slate-600'}`}>
      <span><span className="inline-block w-3 text-slate-400">{sign}</span>{label}</span>
      <span className="tabular-nums">{n(value)}</span>
    </div>
  )
}

function Block({ title, children }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 min-w-0">
      <div className="text-xs font-semibold text-slate-500 mb-1.5">{title}</div>
      {children}
    </div>
  )
}

function InventoryBlock({ data }) {
  const s = data.stock
  return (
    <Block title="Inventaire">
      {data.serialized ? (
        <Term sign="=" label="# de série Disponible - Vente" value={s.series_disponibles_vente} strong />
      ) : (
        <>
          <Term sign="" label="Départ" value={s.inventaire_de_depart} />
          <Term sign="+" label="Reçu" value={s.recu} />
          <Term sign="+" label="Fabriqué" value={s.fabriques} />
          <Term sign="+" label="Ajustements" value={s.ajustements_positifs} />
          <Term sign="−" label="Envoyé" value={s.envoye} />
          <Term sign="−" label="Utilisé en fabrication" value={s.utilisees} />
          <Term sign="−" label="Ajustements" value={s.ajustements_negatifs} />
          <Term sign="=" label="Inventaire" value={s.inventaire} strong />
        </>
      )}
    </Block>
  )
}

function AvailableBlock({ data }) {
  const s = data.stock
  return (
    <Block title="Sera disponible">
      <Term sign="" label="Inventaire" value={s.inventaire} keep />
      <Term sign="−" label="À envoyer (commandes)" value={s.a_envoyer} />
      <Term sign="+" label="À recevoir (achats)" value={s.a_recevoir} />
      <Term sign="=" label="Sera disponible" value={s.sera_disponible} strong />
    </Block>
  )
}

function ParentsBlock({ data }) {
  const t = data.threshold
  if (!data.parents.length) return (
    <Block title="Besoin pour les produits"><div className="text-sm text-slate-400">Aucun produit parent</div></Block>
  )
  return (
    <Block title="Besoin pour les produits">
      <table className="w-full text-sm" data-testid="stock-state-parents">
        <thead>
          <tr className="text-[11px] text-slate-400 text-right">
            <th className="text-left font-normal">Utilisé dans</th>
            <th className="font-normal">Qté</th>
            <th className="font-normal">Seuil min</th>
            <th className="font-normal">Dispo</th>
            <th className="font-normal">Besoin</th>
          </tr>
        </thead>
        <tbody>
          {data.parents.map(p => {
            const need = (p.seuil_min - p.sera_disponible) * p.qty
            return (
              <tr key={p.id} className="text-right tabular-nums text-slate-600">
                <td className="text-left py-0.5 pr-2 max-w-0 w-1/2">
                  <Link to={`/products/${p.id}`} className="link-record truncate block" title={p.name}>{p.name}</Link>
                </td>
                <td>×{n(p.qty)}</td>
                <td title={p.kanban ? 'Kanban : seuil calculé' : undefined}>{n(p.seuil_min)}{p.kanban && '*'}</td>
                <td>{n(p.sera_disponible)}</td>
                <td className={need > 0 ? 'text-slate-800 font-medium' : 'text-slate-400'}>{n(need)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <Term sign="=" label="Besoin pour les produits" value={t.seuil_dynamique} strong />
      {t.cycle && <div className="text-xs text-amber-600 mt-1">Nomenclature circulaire</div>}
    </Block>
  )
}

function RuleRow({ active, label, cond, formula, value }) {
  return (
    <div className={`rounded-md px-2 py-1.5 text-sm ${value > 0 && active ? 'bg-red-50 text-red-700' : 'text-slate-500'}`}>
      <div className="flex justify-between gap-3">
        <span>{label}</span>
        <span className="tabular-nums font-semibold">{n(Math.ceil(value))}</span>
      </div>
      <div className="text-[11px] opacity-80 tabular-nums">{cond} {value > 0 ? `: ${formula}` : ''}</div>
    </div>
  )
}

function OrderBlock({ data }) {
  const t = data.threshold
  const d = t.sera_disponible
  const ruleProducts = d - t.seuil_dynamique < 0 ? t.seuil_min_produits * 2 - d - t.qte_dans_les_produits : 0
  const ruleMin = d < t.inventaire_minimum ? t.inventaire_minimum * 2 - d : 0
  const win = ruleProducts >= ruleMin ? 'p' : 'm'
  return (
    <Block title="À commander = le plus grand">
      <RuleRow active={win === 'p'} label="Besoin pour les produits"
        cond={`dispo ${n(d)} ${cmp(d, t.seuil_dynamique)} seuil dyn. ${n(t.seuil_dynamique)}`}
        formula={`${n(t.seuil_min_produits)}×2 − ${n(d)} − ${n(t.qte_dans_les_produits)}`}
        value={ruleProducts} />
      <RuleRow active={win === 'm'} label="Inventaire minimum"
        cond={`dispo ${n(d)} ${cmp(d, t.inventaire_minimum)} min ${n(t.inventaire_minimum)}`}
        formula={`${n(t.inventaire_minimum)}×2 − ${n(d)}`}
        value={ruleMin} />
    </Block>
  )
}

const SERIAL_GROUPS = [
  ['Disponible - Vente', 'Disponible - Vente', 'green'],
  ['Disponible - Location', 'Disponible - Location', 'slate'],
  ['À reconditionner', 'À reconditionner', 'amber'],
]

function SerialsBlock({ data }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {SERIAL_GROUPS.map(([status, label, tone]) => {
        const list = data.serials.filter(s => s.status === status)
        return (
          <div key={status} className="rounded-lg border border-slate-200 p-3 min-w-0" data-testid={`stock-serials-${label}`}>
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold text-slate-500">{label}</span>
              <span className={`text-xl font-semibold tabular-nums ${list.length ? { green: 'text-emerald-600', amber: 'text-amber-600', slate: 'text-slate-800' }[tone] : 'text-slate-300'}`}>{list.length}</span>
            </div>
            {!!list.length && (
              <div className="flex flex-wrap gap-1 mt-1.5 max-h-28 overflow-y-auto">
                {list.map(s => (
                  <Link key={s.id} to={`/serials/${s.id}`} className="link-record font-mono text-[11px] px-1.5 py-0.5 rounded bg-slate-50">{s.serial}</Link>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function ProductStockState({ productId, procurementType, refreshKey, onSaveSeuilMin, onSaveInvMin }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let off = false
    setError(null)
    api.products.stockState(productId)
      .then(r => { if (!off) setData(r) })
      .catch(e => { if (!off) setError(e.message || 'Erreur') })
    return () => { off = true }
  }, [productId, refreshKey])

  if (error) return <div className="card p-4 text-sm text-red-600">{error}</div>
  if (!data) return <div className="card p-6 flex justify-center"><Spinner /></div>
  if (!data.stock || !data.threshold) return <div className="card p-4 text-sm text-slate-400">Non stocké</div>

  const t = data.threshold
  const made = procurementType === 'Fabriqué' || procurementType === 'Drop ship'
  const toOrder = t.quantite_a_commander
  // Même règle que l'étape Production de la priorité d'assemblage.
  const fabricated = procurementType === 'Fabriqué'
  const toMake = Math.max(0, Math.ceil(t.seuil_min_produits_finis - t.sera_disponible))
  const below = (v, min) => min > 0 && v < min

  if (made) {
    return (
      <div className="card p-4 space-y-3" data-testid="product-stock-state">
        {/* Produits finis : seul le seuil min produits finis compte (pas d'inventaire minimum). */}
        <div className={`grid gap-3 ${fabricated ? 'grid-cols-4' : 'grid-cols-3'}`}>
          <Tile label="Inventaire" value={n(data.stock.inventaire)} testId="stock-inventaire" />
          <Tile label="Sera disponible" value={n(t.sera_disponible)}
            tone={below(t.sera_disponible, t.seuil_min_produits_finis) ? 'red' : 'slate'} testId="stock-sera-disponible" />
          {/* Kanban : seuil calculé par Boréal, donc en lecture seule. */}
          <Tile label={data.kanban ? 'Seuil min (kanban)' : 'Inventaire minimum Produit fini'} value={n(t.seuil_min_produits_finis)} testId="stock-seuil-min"
            raw={t.seuil_min_produits_finis} onSave={!data.kanban ? onSaveSeuilMin : undefined} />
          {fabricated && <Tile label="À fabriquer" value={n(toMake)} tone={toMake > 0 ? 'red' : 'slate'} testId="stock-a-fabriquer" />}
        </div>
        <SerialsBlock data={data} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <AvailableBlock data={data} />
          {/* Sérialisé : le compte « Disponible - Vente » est déjà dans les cartes de # de série. */}
          {!data.serialized && <InventoryBlock data={data} />}
        </div>
      </div>
    )
  }

  return (
    <div className="card p-4 space-y-3" data-testid="product-stock-state">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Tile label="Inventaire" value={n(data.stock.inventaire)} testId="stock-inventaire" />
        <Tile label="Sera disponible" value={n(t.sera_disponible)} testId="stock-sera-disponible" />
        <Tile label="Besoin pour les produits" value={n(t.seuil_dynamique)} testId="stock-seuil-dynamique" />
        <Tile label="Inventaire minimum" value={n(t.inventaire_minimum)} testId="stock-inventaire-min"
          raw={t.inventaire_minimum} onSave={onSaveInvMin} />
        <Tile label="À commander" value={n(toOrder)} tone={toOrder > 0 ? 'red' : 'green'} testId="stock-a-commander" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <OrderBlock data={data} />
        <ParentsBlock data={data} />
        <AvailableBlock data={data} />
        <InventoryBlock data={data} />
      </div>
    </div>
  )
}
