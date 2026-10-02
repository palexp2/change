import { useState, useEffect, useMemo } from 'react'
import { Plus, Pencil, ChevronDown, ChevronRight, X } from 'lucide-react'
import { api } from '../lib/api.js'
import { CountStepper } from './DiscoveryFormOptions.jsx'
import { fmtMoney } from '../utils/formatters.js'
import { fmtDate } from '../lib/formatDate.js'
import { purchasePct } from '../lib/soumissionDiscount.js'

// Saisie d'une soumission, mise en page de la modale System builder (images
// des produits en plus) : totaux, compteurs Chef de culture / Assistant,
// « Extra » repliable (par serre, puis pour le site), rabais.
// Partagée par la page de création et la fiche d'une soumission.
// Chaque ligne part avec sa serre (group_name) et son prix mensuel.

// Forfait de chaque serre (Chef de culture ou Assistant) ; tout le reste du
// catalogue va dans « Extra ». Un service se coche (0/1), un équipement se compte ;
// pour le site, tout se compte.
const BASE_ROLES = new Set(['helper', 'chief_grower'])
const isService = p => p.type === 'Service'
// Bloc « Pour toute la ferme » : produits cochés « Soumission : pour toute la
// ferme » sur leur fiche ; l'accès internet mobile en tête, le reste en Extras.
const FARM_LABEL = 'Pour toute la ferme'
const FARM_BASE_ROLES = new Set(['mobile_controller'])
const isFarm = p => p.quote_farm_wide === 1

// Retirés des soumissions (Pierre-Alexandre, 2026-09-29) : « Orisha dans la
// serre » et « Prévention des maladies » ; le contrôleur central, sans objet
// au niveau d'une serre ; le « Kit de prolongation de la portée ».
const HIDDEN_SKUS = new Set(['SVC-004', 'SVC-005', '1479', 'SVC-017'])

// Le catalogue porte des doublons par SKU (anciennes copies à 0 $) : on garde
// celui qui a un prix.
function dedupeCatalog(list) {
  const bySku = new Map()
  for (const p of list) {
    if (/legacy/i.test(p.type || '') || HIDDEN_SKUS.has(p.sku)) continue
    const key = p.sku || p.id
    const cur = bySku.get(key)
    const worth = x => (x.price_cad || 0) + (x.monthly_price_cad || 0)
    if (!cur || worth(p) > worth(cur)) bySku.set(key, p)
  }
  return [...bySku.values()]
}

let uid = 0
const blankCustom = () => ({ key: ++uid, description: '', qty: 1, monthly: 0, price: 0 })
// Rabais nommé : un % et un montant fixe par colonne (`pct`/`monthly` =
// abonnement, `pct_purchase`/`amount` = achat).
// `until` : date de fin d'application (ex. 100 % jusqu'au 1er mars 2027).
const blankDiscount = () => ({ key: ++uid, name: 'Rabais', pct: 0, pct_purchase: 0, monthly: 0, amount: 0, until: '' })
// Rabais standards : une case à cocher les ajoute tels quels (`only: 'monthly'` = % sur l'abonnement seul).
const PRESET_DISCOUNTS = [
  { preset: 'head_start', name: 'Head start plan', pct: 100, only: 'monthly', until: '2027-03-01' },
]

// Rabais enregistrés (liste nommée, sinon rabais global d'avant) → lignes de l'éditeur.
function initialDiscounts(s) {
  let list = null
  try { list = s.discounts ? JSON.parse(s.discounts) : null } catch { /* repli global */ }
  if (!Array.isArray(list)) {
    list = s.discount_pct || s.discount_amount
      ? [{ name: 'Rabais', pct: s.discount_pct || 0, monthly: 0, amount: s.discount_amount || 0, until: s.discount_valid_until }] : []
  }
  return list.map(d => ({ ...blankDiscount(), ...d, pct_purchase: purchasePct(d), until: d.until || '' }))
}

// Rabais tels qu'envoyés au serveur.
export const discountsPayload = discounts =>
  discounts.map(({ name, pct, pct_purchase, monthly, amount, until, only, preset }) => ({ name, pct, pct_purchase, monthly, amount, until: until || null, only, preset }))

// Les images du catalogue ont un fond blanc opaque : « multiply » l'efface sur
// le fond clair de la page (le mode nuit garde le rendu normal).
const Thumb = ({ src }) => src
  ? <img src={src} alt="" className="w-7 h-7 object-contain flex-shrink-0 mix-blend-multiply dark:mix-blend-normal" />
  : <span className="w-7 h-7 flex-shrink-0" />

const toQty = v => Math.max(0, parseInt(v) || 0)

// `initial` : soumission existante — ses lignes redeviennent serres, compteurs
// et extras une fois le catalogue connu (hors liste → ligne sur mesure, prix
// gardés). `readOnly` : même mise en page, rien de modifiable.
// Renvoie les lignes et rabais courants, et `body` à placer dans la page.
export function useSoumissionBuilder({ initial, language, currency, readOnly = false }) {
  const [catalog, setCatalog] = useState([])
  const [discounts, setDiscounts] = useState(() => (initial ? initialDiscounts(initial) : []))
  const [chiefCount, setChiefCount] = useState(0)
  const [helperCount, setHelperCount] = useState(0)
  // Saisie par serre, clé stable par type (c0, h0…) comme la modale System
  // builder : survit à un changement du nombre de serres de l'autre type.
  const [serreData, setSerreData] = useState({})
  const [farm, setFarm] = useState({ qty: {}, custom: [] })
  const [advanced, setAdvanced] = useState(false)
  const [renaming, setRenaming] = useState(null)

  const [ready, setReady] = useState(!initial)
  const hydrate = (raw, list) => {
    const skuOf = new Map(raw.map(p => [p.id, p.sku || p.id]))
    const bySku = new Map(list.map(p => [p.sku || p.id, p]))
    const productOf = it => it.catalog_product_id && bySku.get(skuOf.get(it.catalog_product_id))
    const groups = new Map()
    for (const it of initial.items || []) {
      const g = it.group_name || FARM_LABEL
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g).push(it)
    }
    const custom = it => ({
      ...blankCustom(), qty: it.qty || 1, monthly: it.unit_monthly_price || 0, price: it.unit_price_cad || 0,
      description: (initial.language === 'English' ? it.description_en || it.description_fr : it.description_fr || it.description_en) || it.name_fr || '',
    })
    const fill = (block, its, allowed) => {
      for (const it of its) {
        const p = productOf(it)
        if (p && allowed(p)) block.qty[p.id] = (block.qty[p.id] || 0) + (it.qty || 1)
        else block.custom.push(custom(it))
      }
      return block
    }
    const farmBlock = { qty: {}, custom: [] }
    const chiefsOut = [], helpersOut = []
    for (const [name, its] of groups) {
      const baseIdx = name === FARM_LABEL ? -1 : its.findIndex(it => BASE_ROLES.has(productOf(it)?.role))
      if (baseIdx < 0) { fill(farmBlock, its, isFarm); continue }
      const block = fill({ name, qty: {}, custom: [] }, its.filter((_, i) => i !== baseIdx), p => !isFarm(p) && !BASE_ROLES.has(p.role))
      ;(productOf(its[baseIdx]).role === 'helper' ? helpersOut : chiefsOut).push(block)
    }
    const data = {}
    chiefsOut.forEach((b, i) => { data[`c${i}`] = b })
    helpersOut.forEach((b, i) => { data[`h${i}`] = b })
    setChiefCount(chiefsOut.length)
    setHelperCount(helpersOut.length)
    setSerreData(data)
    setFarm(farmBlock)
    if (farmBlock.custom.length || Object.keys(farmBlock.qty).length || Object.values(data).some(b => b.custom.length || Object.keys(b.qty).length)) setAdvanced(true)
    setReady(true)
  }

  useEffect(() => {
    api.catalog.list().then(l => {
      const list = dedupeCatalog(l || [])
      if (initial) hydrate(l || [], list)
      setCatalog(list)
    }).catch(console.error)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const isFr = language !== 'English'
  const usd = currency === 'USD'
  const priceOf = p => (usd ? p.price_usd : p.price_cad) || 0
  const monthlyOf = p => (usd ? p.monthly_price_usd : p.monthly_price_cad) || 0
  const nameOf = p => (isFr ? p.name_fr : (p.name_en || p.name_fr)) || p.sku
  const fmtP = n => fmtMoney(n || 0, currency, { locale: usd ? 'en-US' : 'fr-CA', maximumFractionDigits: 0 })

  const lists = useMemo(() => {
    const bySvc = (a, b) => isService(b) - isService(a)
    const serre = catalog.filter(p => !isFarm(p))
    const farmList = catalog.filter(isFarm)
    return {
      chief: serre.find(p => p.role === 'chief_grower'),
      helper: serre.find(p => p.role === 'helper'),
      serre: serre.filter(p => !BASE_ROLES.has(p.role)).sort(bySvc),
      farm: [...farmList.filter(p => FARM_BASE_ROLES.has(p.role)), ...farmList.filter(p => !FARM_BASE_ROLES.has(p.role)).sort(bySvc)],
    }
  }, [catalog])

  const chiefs = toQty(chiefCount)
  const cards = Array.from({ length: chiefs + toQty(helperCount) }, (_, i) => (i < chiefs
    ? { key: `c${i}`, helper: false } : { key: `h${i - chiefs}`, helper: true }))
  const serreOf = key => serreData[key] || { qty: {}, custom: [] }
  const serreName = (card, i) => serreOf(card.key).name?.trim() || `Serre ${i + 1}`
  const patchSerre = (key, fn) => setSerreData(d => ({ ...d, [key]: fn(d[key] || { qty: {}, custom: [] }) }))
  // Même interface pour une serre et pour le site.
  const blocks = {
    serre: key => ({ data: serreOf(key), patch: fn => patchSerre(key, fn) }),
    farm: () => ({ data: farm, patch: setFarm }),
  }

  const line = (group, p, qty) => ({
    group_name: group, catalog_product_id: p.id, qty,
    unit_price_cad: priceOf(p), unit_monthly_price: monthlyOf(p),
    description_fr: p.name_fr || '', description_en: p.name_en || '',
  })
  const blockLines = (group, data, products) => [
    ...products.filter(p => data.qty[p.id] > 0).map(p => line(group, p, data.qty[p.id])),
    ...data.custom.filter(c => c.description.trim()).map(c => ({
      group_name: group, catalog_product_id: null, qty: c.qty || 1,
      unit_price_cad: c.price || 0, unit_monthly_price: c.monthly || 0,
      description_fr: c.description.trim(), description_en: c.description.trim(),
    })),
  ]

  // Lignes envoyées au serveur, dans l'ordre d'affichage.
  const cardsKey = cards.map(c => c.key).join()
  const items = useMemo(() => [
    ...cards.flatMap((card, i) => {
      const name = serreName(card, i)
      const base = card.helper ? lists.helper : lists.chief
      return [...(base ? [line(name, base, 1)] : []), ...blockLines(name, serreOf(card.key), lists.serre)]
    }),
    ...blockLines(FARM_LABEL, farm, lists.farm),
  ], [cardsKey, serreData, farm, lists, currency]) // eslint-disable-line react-hooks/exhaustive-deps

  const subtotal = items.reduce((t, it) => t + it.qty * it.unit_price_cad, 0)
  const monthlyTotal = items.reduce((t, it) => t + it.qty * it.unit_monthly_price, 0)
  // Même calcul que le PDF (serveur, discountTotals).
  const discountLines = discounts.map(d => ({
    ...d,
    offMonthly: monthlyTotal * (d.pct || 0) / 100 + (d.monthly || 0),
    offAmount: subtotal * purchasePct(d) / 100 + (d.amount || 0),
  }))
  const netMonthly = Math.max(0, monthlyTotal - discountLines.reduce((t, d) => t + d.offMonthly, 0))
  const netTotal = Math.max(0, subtotal - discountLines.reduce((t, d) => t + d.offAmount, 0))
  const patchDiscount = (key, patch) => setDiscounts(prev => prev.map(d => d.key === key ? { ...d, ...patch } : d))
  const togglePreset = (p, on) => setDiscounts(prev => on
    ? [...prev, { ...blankDiscount(), ...p }] : prev.filter(d => d.preset !== p.preset))
  const customDiscounts = discounts.filter(d => !d.preset)

  const num = 'input w-20 text-right tabular-nums'

  // En-tête des cases de prix, aligné sur les colonnes des lignes ($/mois, $).
  const priceHeader = lead => (
    <div aria-hidden className="flex items-center gap-2 text-xs text-slate-500">
      <span className="flex-1" />{lead}
      <span className="w-20 text-right">Abonnement</span>
      <span className="w-20 text-right">Achat</span>
      <span className="w-3.5" />
    </div>
  )

  // Produit : image + nom, case (service) ou compteur (équipement).
  // `counted` : compteur même pour un service (bloc du site, Pierre-Alexandre 2026-09-29).
  const productLine = ({ data, patch }, p, context, counted = false) => {
    const q = data.qty[p.id] || 0
    const setQ = v => patch(s => ({ ...s, qty: { ...s.qty, [p.id]: toQty(v) } }))
    return isService(p) && !counted ? (
      <label key={p.id} className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={q > 0} onChange={e => setQ(e.target.checked ? 1 : 0)} />
        <Thumb src={p.image_url} />{nameOf(p)}
      </label>
    ) : (
      <div key={p.id} className="flex items-center justify-between gap-3 text-sm text-slate-700">
        <span className="flex items-center gap-2 min-w-0"><Thumb src={p.image_url} /><span className="truncate">{nameOf(p)}</span></span>
        <CountStepper label={`${context} · ${nameOf(p)}`} max={100} value={q} onChange={setQ} />
      </div>
    )
  }

  // Équipement sur mesure : lignes libres (description, qté, $/mois, $).
  const customLines = ({ data, patch }) => {
    const set = (ck, change) => patch(s => ({ ...s, custom: s.custom.map(c => c.key === ck ? { ...c, ...change } : c) }))
    return (
      <div className="space-y-1.5">
        {data.custom.length > 0 && priceHeader(<span className="w-14" />)}
        {data.custom.map(c => (
          <div key={c.key} className="flex items-center gap-2">
            <input autoFocus={!c.description} aria-label="Description" className="input flex-1"
              value={c.description} onChange={e => set(c.key, { description: e.target.value })} />
            <input type="number" min="1" aria-label="Quantité" className="input w-14 text-center" value={c.qty}
              onChange={e => set(c.key, { qty: parseInt(e.target.value) || 1 })} />
            <input type="number" min="0" aria-label="$/mois" title="$/mois" className={num} value={c.monthly}
              onChange={e => set(c.key, { monthly: parseFloat(e.target.value) || 0 })} />
            <input type="number" min="0" aria-label="$" title="$" className={num} value={c.price}
              onChange={e => set(c.key, { price: parseFloat(e.target.value) || 0 })} />
            <button type="button" aria-label="Retirer" onClick={() => patch(s => ({ ...s, custom: s.custom.filter(y => y.key !== c.key) }))}
              className="text-slate-300 hover:text-red-500"><X size={14} /></button>
          </div>
        ))}
        {!readOnly && (
          <button type="button" onClick={() => patch(s => ({ ...s, custom: [...s.custom, blankCustom()] }))}
            className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-800 font-medium">
            <Plus size={12} /> Sur mesure
          </button>
        )}
      </div>
    )
  }

  const serreTitle = (card, i) => {
    const name = serreName(card, i)
    return (
      <div className="flex items-center gap-2 text-sm text-slate-700">
        {renaming === card.key ? (
          <input autoFocus className="input py-0.5 w-40" value={name}
            onChange={e => patchSerre(card.key, s => ({ ...s, name: e.target.value }))}
            onBlur={() => setRenaming(null)}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
        ) : (
          <button type="button" onClick={() => setRenaming(card.key)} className="flex items-center gap-1.5">
            {name} {!readOnly && <Pencil size={12} className="text-slate-400" />}
          </button>
        )}
        <span className="text-xs text-slate-400">{card.helper ? 'Assistant' : 'Chef'}</span>
      </div>
    )
  }

  // `disabled` d'un fieldset éteint toute la saisie qu'il contient ; le
  // bouton « Extra » reste dehors pour pouvoir déplier en lecture seule.
  const body = (
    <>
      {/* Totaux figés en haut : restent visibles pendant la saisie des extras. */}
      <div className="sticky top-0 z-10 -mx-6 px-6 py-2 bg-white/95 backdrop-blur-sm border-b border-slate-200">
        <table className="text-sm tabular-nums">
          <thead>
            <tr className="font-semibold text-slate-800">
              <th /><th className="pl-10 text-left">Service</th><th className="pl-10 text-left">Achat</th>
            </tr>
          </thead>
          <tbody>
            <tr><td className="py-1.5 pr-4 text-slate-800">Prix du système</td>
              <td className="pl-10">{fmtP(monthlyTotal)}</td><td className="pl-10">{fmtP(subtotal)}</td></tr>
            {discountLines.map(d => (
              <tr key={d.key} className="font-semibold">
                <td className="py-1.5 pr-4 text-rose-700">{d.name || 'Rabais'}
                  {d.until && <span className="ml-1 text-xs font-normal">→ {fmtDate(d.until)}</span>}</td>
                <td className="pl-10">{fmtP(d.offMonthly)}</td><td className="pl-10">{fmtP(d.offAmount)}</td>
              </tr>
            ))}
            <tr className="text-slate-900"><td className="py-1.5 pr-4">Total</td>
              <td className="pl-10">{fmtP(netMonthly)}</td><td className="pl-10">{fmtP(netTotal)}</td></tr>
          </tbody>
        </table>
      </div>

      <fieldset disabled={readOnly} className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="soumission-chief-count" className="label">Nombre de Chef de culture</label>
          <CountStepper id="soumission-chief-count" label="Chef de culture" max={50} value={chiefCount} onChange={setChiefCount} />
        </div>
        <div>
          <label htmlFor="soumission-helper-count" className="label">Nombre d'Assistant</label>
          <CountStepper id="soumission-helper-count" label="Assistant" max={50} value={helperCount} onChange={setHelperCount} />
        </div>
      </fieldset>

      <div className="border-t border-slate-200 pt-4">
        <button type="button" aria-expanded={advanced} onClick={() => setAdvanced(o => !o)} className="flex items-center gap-1 text-sm font-semibold text-slate-900">
          {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}Extra
        </button>
        {advanced && <fieldset disabled={readOnly} className="mt-4 space-y-4">
          {cards.length > 0 && <fieldset className="space-y-4 border-t border-slate-200 pt-4">
            <legend className="text-sm font-semibold text-slate-900">Extra par serre</legend>
            {cards.map((card, i) => {
              const block = blocks.serre(card.key)
              return (
                <div key={card.key} className="space-y-2">
                  {serreTitle(card, i)}
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                    {lists.serre.map(p => productLine(block, p, serreName(card, i)))}
                  </div>
                  {customLines(block)}
                </div>
              )
            })}
          </fieldset>}
          <fieldset className="space-y-2 border-t border-slate-200 pt-4">
            <legend className="text-sm font-semibold text-slate-900">Extra pour le site</legend>
            {lists.farm.map(p => productLine(blocks.farm(), p, FARM_LABEL, true))}
            {customLines(blocks.farm())}
          </fieldset>
        </fieldset>}
      </div>

      <fieldset disabled={readOnly} className="space-y-2 border-t border-slate-200 pt-4">
        <legend className="w-full flex items-center justify-between text-sm font-semibold text-slate-900">
          Rabais
          {!readOnly && (
            <button type="button" aria-label="Ajouter un rabais" onClick={() => setDiscounts(prev => [...prev, blankDiscount()])}
              className="text-brand-600 hover:text-brand-800"><Plus size={16} /></button>
          )}
        </legend>
        {PRESET_DISCOUNTS.map(p => (
          <label key={p.preset} className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={discounts.some(d => d.preset === p.preset)} onChange={e => togglePreset(p, e.target.checked)} />
            {p.name}<span className="text-xs text-slate-400">{p.pct} % abonnement → {fmtDate(p.until)}</span>
          </label>
        ))}
        {customDiscounts.length > 0 && (
          <div aria-hidden className="flex items-center gap-2 text-xs text-slate-500">
            <span className="flex-1" /><span className="w-36">Jusqu'au</span>
            <span className="w-[10.5rem] text-center">Abonnement</span>
            <span className="w-[10.5rem] text-center">Achat</span>
            <span className="w-3.5" />
          </div>
        )}
        {customDiscounts.map(d => (
          <div key={d.key} className="flex items-center gap-2">
            <input aria-label="Nom du rabais" className="input flex-1 min-w-0" value={d.name}
              onChange={e => patchDiscount(d.key, { name: e.target.value })} onFocus={e => e.target.select()} />
            <input type="date" aria-label="Jusqu'au" title="Jusqu'au" className="input w-36" value={d.until || ''}
              onChange={e => patchDiscount(d.key, { until: e.target.value })} />
            {[['Abonnement', 'pct', 'monthly', '$/mois'], ['Achat', 'pct_purchase', 'amount', '$']].map(([col, pk, ak, unit]) => (
              <span key={col} className="w-[10.5rem] inline-flex items-center gap-1 text-sm text-slate-500">
                <input type="number" min="0" max="100" step="0.1" aria-label={`% ${col}`} title={`% ${col}`} className="input w-16 text-right" value={d[pk]}
                  onChange={e => patchDiscount(d.key, { [pk]: parseFloat(e.target.value) || 0 })} />%
                <input type="number" min="0" aria-label={`${unit} ${col}`} title={`${unit} ${col}`} className={num} value={d[ak]}
                  onChange={e => patchDiscount(d.key, { [ak]: parseFloat(e.target.value) || 0 })} />
              </span>
            ))}
            <button type="button" aria-label="Retirer" onClick={() => setDiscounts(prev => prev.filter(x => x.key !== d.key))}
              className="text-slate-300 hover:text-red-500"><X size={14} /></button>
          </div>
        ))}
      </fieldset>
    </>
  )

  return { ready, items, discounts, body }
}
