import { EQUIPMENT_PRODUCT_GROUPS, EQUIPMENT_OUTPUTS, isJwtProduct } from '../lib/discoveryEquipmentCatalog.js'
import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import Spinner from '../components/Spinner.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { SaveStatus, useSaveStatus } from '../components/SaveStatus.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { emptyOverrides } from '../lib/discoveryFormSchema.js'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import TableThumb, { TABLE_THUMB_CLASS } from '../components/TableThumb.jsx'

// Produits associés du System builder : le produit du catalogue envoyé pour
// chaque équipement, et les sorties V2 que prend chaque appareil. Les textes du
// formulaire client vivent dans le code ; le calque enregistré est renvoyé
// tel quel, seule sa partie « équipements » change ici.

// Pause de frappe avant l'envoi automatique (règle de design : autosave partout).
const AUTOSAVE_MS = 700

// Vignette du produit choisi : un clic ouvre sa fiche.
function ProductThumbLink({ product, id }) {
  return (
    <Link to={`/products/${id}`} title={product?.name_fr || 'Fiche'} className="shrink-0">
      {product?.image_url
        ? <TableThumb src={product.image_url} alt={product.name_fr || ''} fit="contain" className="border border-slate-200 p-1 bg-fixed-white" />
        : <div className={`${TABLE_THUMB_CLASS} rounded border border-dashed border-slate-300`} />}
    </Link>
  )
}

export default function DiscoveryFormEditor() {
  const [schema, setSchema] = useState(null)
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [meta, setMeta] = useState({ updated_at: null, updated_by: null })
  const { status: saveState, save: runSave } = useSaveStatus()
  const savedJson = useRef(null)
  const flush = useRef(null)
  const inFlight = useRef(false)

  useEffect(() => {
    api.discoveryFormSchema.get()
      .then(d => {
        const loaded = { ...emptyOverrides(), ...(d.schema || {}) }
        savedJson.current = JSON.stringify(loaded)
        setSchema(loaded)
        setMeta({ updated_at: d.updated_at, updated_by: d.updated_by })
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { api.products.list({ limit: 'all' }).then(r => setProducts(r.data || [])).catch(() => {}) }, [])

  const schemaJson = useMemo(() => (schema ? JSON.stringify(schema) : null), [schema])
  useEffect(() => {
    if (schemaJson == null || schemaJson === savedJson.current) {
      flush.current = null
      return
    }
    const send = async () => {
      flush.current = null
      savedJson.current = schemaJson
      inFlight.current = true
      const ok = await runSave(async () => {
        const res = await api.discoveryFormSchema.save(JSON.parse(schemaJson))
        setMeta({ updated_at: res.updated_at || null, updated_by: res.updated_by || null })
      })
      inFlight.current = false
      if (!ok) savedJson.current = null
    }
    flush.current = send
    const timer = setTimeout(send, AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [schemaJson, runSave])
  // Un changement encore en attente part en quittant la page.
  useEffect(() => () => { flush.current?.() }, [])
  useEffect(() => {
    const onUnload = (e) => {
      if (!flush.current && !inFlight.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  const patch = fn => setSchema(s => fn(structuredClone(s)))
  const setEquipmentProduct = (role, productId) => patch(s => {
    s.equipment ||= { products: {} }; s.equipment.products ||= {}
    if (productId) s.equipment.products[role] = productId
    else delete s.equipment.products[role]
    return s
  })
  const setEquipmentOutput = (role, value) => patch(s => {
    s.equipment ||= { products: {} }
    s.equipment.outputs ||= {}
    if (value === '') delete s.equipment.outputs[role]
    else s.equipment.outputs[role] = Number(value)
    return s
  })

  if (loading) return <Layout><Spinner label="Chargement…" /></Layout>
  if (error) return <Layout><div className="p-6"><ErrorBanner>{error}</ErrorBanner></div></Layout>

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-3xl mx-auto">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-6 pb-5 border-b border-slate-200">
          <div>
            <PageTitle className="mb-1">Produits associés</PageTitle>
            <p className="text-xs text-slate-500">
              {meta.updated_at && `Modifié le ${fmtDate(meta.updated_at)}${meta.updated_by ? ` par ${meta.updated_by}` : ''} · `}
              <Link to="/discovery-forms" className="link-record">System builder</Link>
            </p>
          </div>
          <SaveStatus status={saveState} />
        </div>
        <div className="card p-4">
          <fieldset className="border-b border-slate-200 pb-5 mb-5 space-y-3"><legend className="text-sm font-semibold mb-2">Sorties V2 par appareil</legend>
            {EQUIPMENT_OUTPUTS.map(([role, label]) => <label key={role} className="flex items-center justify-between gap-3 text-sm text-slate-700"><span>{label}</span><select className="input w-28" value={schema.equipment?.outputs?.[role] ?? ''} onChange={e => setEquipmentOutput(role, e.target.value)}><option value="">À définir</option>{Array.from({ length: 9 }, (_, i) => <option key={i} value={i}>{i}</option>)}</select></label>)}
          </fieldset>
          <div className="grid grid-cols-1 gap-3">
            {EQUIPMENT_PRODUCT_GROUPS.map(group => <div key={group.label} className="space-y-3 border-t border-slate-100 pt-4 first:border-0 first:pt-0"><h3 className="text-sm font-semibold text-slate-900">{group.label}</h3>{group.help && <p className="text-xs text-slate-500">{group.help}</p>}{group.products.map(([role, label]) => {
              const selected = schema.equipment?.products?.[role] || ''
              return <div key={role} className="grid grid-cols-1 sm:grid-cols-[11rem_minmax(0,1fr)] gap-2 sm:gap-3 items-center"><span className="text-sm text-slate-600">{label}</span><div className="flex items-center gap-2"><SearchableSelect value={selected} options={group.productType === 'JWT' ? products.filter(isJwtProduct) : products} onChange={v => setEquipmentProduct(role, v)} emptyOption="Aucun produit" placeholder="Choisir un produit" size="sm" getOptionValue={p => p.id} getOptionLabel={p => p.name_fr} filterOption={(p, q) => `${p.name_fr} ${p.sku || ''}`.toLowerCase().includes(q)} />{selected && <ProductThumbLink product={products.find(p => String(p.id) === String(selected))} id={selected} />}</div></div>
            })}</div>)}
          </div>
        </div>
      </div>
    </Layout>
  )
}
