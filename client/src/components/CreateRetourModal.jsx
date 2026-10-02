import { useEffect, useMemo, useState } from 'react'
import { Modal } from './Modal.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import Spinner from './Spinner.jsx'
import api from '../lib/api.js'
import { useCustomFields } from '../lib/useCustomFields.js'
import { parseSelectChoices, colorForChoice, ChoiceBadge } from '../lib/customFieldDisplay.jsx'
import TableThumb, { TABLE_THUMB_CLASS } from './TableThumb.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { fmtAddress } from '../utils/formatters.js'
import { useToast } from '../contexts/ToastContext.jsx'

// « Créer un retour » depuis la fiche entreprise. Candidats : n° de série
// opérationnels de l'entreprise + articles sans n° de série qui lui ont été
// envoyés. Avec échange immédiat, chaque article choisi reçoit un produit de
// substitution qui part dans une commande (nouvelle ou existante) ; le serveur
// y inscrit le n° de série retourné comme « # de série remplacé ».

const IMMEDIATE = 'échange immédiat'
const isSerial = c => c.kind === 'serial'
const keyOf = c => (isSerial(c) ? `s:${c.id}` : `i:${c.id}`)
const Hint = ({ children, className = '' }) => <p className={`text-xs text-slate-500 ${className}`}>{children}</p>

export function CreateRetourModal({ isOpen, onClose, companyId, tickets = [], adresses = [], orders = [], onCreated }) {
  const { addToast } = useToast()
  const { fields } = useCustomFields('return_items')
  const reasons = useMemo(() => {
    const f = fields.find(x => x.column_name === 'return_reason')
    return parseSelectChoices(f).map(c => c.label).filter(l => !/DEPRECATED/i.test(l))
  }, [fields])
  const { fields: serialFields } = useCustomFields('serial_numbers')
  const statusChoices = useMemo(() => parseSelectChoices(serialFields.find(f => f.column_name === 'status')), [serialFields])

  const [candidates, setCandidates] = useState(null)
  const [products, setProducts] = useState([])
  const [ticketId, setTicketId] = useState('')
  const [picked, setPicked] = useState({}) // key → { qty, reason, notes, sub }
  const [search, setSearch] = useState('')
  const [allReason, setAllReason] = useState('')
  const [allNotes, setAllNotes] = useState('')
  const [exchange, setExchange] = useState(false)
  const [orderMode, setOrderMode] = useState('new')
  const [orderId, setOrderId] = useState('')
  const [addressId, setAddressId] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    setCandidates(null); setPicked({}); setTicketId(''); setSearch(''); setAllReason(''); setAllNotes('')
    setExchange(false); setOrderMode('new'); setOrderId('')
    const principal = adresses.find(a => a.address_type === 'Livraison' && a.address_rank === 'Principale')
      || adresses.find(a => a.address_type === 'Livraison') || adresses[0]
    setAddressId(principal?.id || '')
    api.retours.companyCandidates(companyId)
      .then(r => setCandidates([
        ...(r.serials || []).map(s => ({ ...s, kind: 'serial' })),
        ...(r.items || []),
      ]))
      .catch(e => { setCandidates([]); addToast({ message: e.message, type: 'error' }) })
    if (!products.length) api.products.list({ limit: 'all', active: true }).then(r => setProducts(r.data || [])).catch(() => {})
  }, [isOpen, companyId]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!candidates) return []
    if (!q) return candidates
    return candidates.filter(c => [c.serial, c.product_name, c.sku, c.order_number]
      .some(v => v != null && String(v).toLowerCase().includes(q)))
  }, [candidates, search])

  const byKey = useMemo(() => new Map((candidates || []).map(c => [keyOf(c), c])), [candidates])
  const pickedKeys = Object.keys(picked)

  const toggle = (c) => setPicked(p => {
    const k = keyOf(c)
    if (p[k]) { const n = { ...p }; delete n[k]; return n }
    return { ...p, [k]: { qty: 1, reason: allReason, notes: allNotes, sub: c.product_id || '' } }
  })
  const shownPicked = shown.filter(c => picked[keyOf(c)]).length
  const allShownPicked = shown.length > 0 && shownPicked === shown.length
  const toggleAll = () => setPicked(p => {
    const n = { ...p }
    for (const c of shown) {
      const k = keyOf(c)
      if (allShownPicked) delete n[k]
      else if (!n[k]) n[k] = { qty: 1, reason: allReason, notes: allNotes, sub: c.product_id || '' }
    }
    return n
  })
  const setLine = (k, patch) => {
    setPicked(p => ({ ...p, [k]: { ...p[k], ...patch } }))
    if (patch.reason?.includes(IMMEDIATE)) setExchange(true)
  }
  const applyAll = () => {
    setPicked(p => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { ...v, reason: allReason, notes: allNotes }])))
    if (allReason.includes(IMMEDIATE)) setExchange(true)
  }

  const openOrders = orders.filter(o => o.status !== 'Envoyé')
  const valid = pickedKeys.length > 0
    && pickedKeys.every(k => picked[k].reason)
    && (!exchange || orderMode === 'new' || orderId)

  async function submit() {
    setSubmitting(true)
    try {
      const items = pickedKeys.map(k => {
        const c = byKey.get(k)
        const l = picked[k]
        return {
          ...(isSerial(c) ? { serial_id: c.id } : { order_item_id: c.id, qty: Number(l.qty) || 1 }),
          reason: l.reason,
          notes: l.notes || null,
          substitute_product_id: exchange ? (l.sub || null) : null,
        }
      })
      const r = await api.retours.create({
        company_id: companyId,
        ticket_id: ticketId || null,
        items,
        exchange: exchange ? { order_id: orderMode === 'existing' ? orderId : null, address_id: addressId || null } : null,
      })
      addToast({ message: r.order ? `Retour créé · commande #${r.order.order_number}` : 'Retour créé', type: 'success' })
      onCreated?.(r)
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSubmitting(false)
    }
  }

  const reasonSelect = (value, onChange, testId) => (
    <select className="input text-sm" value={value} onChange={e => onChange(e.target.value)} data-testid={testId}>
      <option value="">—</option>
      {reasons.map(r => <option key={r} value={r}>{r}</option>)}
    </select>
  )
  const productOptions = useMemo(() => products.map(p => ({ value: p.id, label: [p.name_fr || p.name_en, p.sku].filter(Boolean).join(' · ') })), [products])

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Nouveau retour" size="xl">
      <div className="space-y-5" data-testid="create-retour-modal">
        <div>
          <label className="label">Billet</label>
          <SearchableSelect
            value={ticketId}
            onChange={setTicketId}
            emptyOption="Aucun"
            size="sm"
            className="input text-sm w-full"
            options={tickets.map(t => ({ value: t.id, label: [t.cf_billet || 'Billet', t.titre].filter(Boolean).join(' · ') }))}
            testId="retour-ticket"
          />
          <Hint className="mt-1">Facultatif — le billet de support à l'origine du retour.</Hint>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-2">
            <input
              type="checkbox"
              className="ml-3"
              checked={allShownPicked}
              ref={el => { if (el) el.indeterminate = shownPicked > 0 && !allShownPicked }}
              disabled={!shown.length}
              onChange={toggleAll}
              title="Tout sélectionner"
              aria-label="Tout sélectionner"
              data-testid="retour-select-all"
            />
            <label className="label mb-0">Articles</label>
            <input className="input text-sm flex-1" value={search} onChange={e => setSearch(e.target.value)} aria-label="Rechercher" />
          </div>
          <Hint className="mb-2">Cochez ce qui revient, puis donnez une raison à chaque article. Le bandeau gris applique la même raison et précision à tous les articles cochés.</Hint>
          <div className="flex flex-wrap items-center gap-2 mb-2 p-2 rounded-lg bg-slate-50">
            {reasonSelect(allReason, setAllReason, 'retour-all-reason')}
            <input className="input text-sm flex-1 min-w-[160px]" value={allNotes} onChange={e => setAllNotes(e.target.value)} aria-label="Précision" title="Précision" />
            <button type="button" className="btn-secondary text-sm" disabled={!pickedKeys.length} onClick={applyAll}>Appliquer à tous</button>
          </div>
          <div className="border border-slate-200 rounded-lg max-h-[40vh] overflow-y-auto divide-y divide-slate-100">
            {candidates === null ? (
              <div className="p-4 flex justify-center"><Spinner /></div>
            ) : shown.length === 0 ? (
              <div className="p-3 text-sm text-slate-400">Aucun</div>
            ) : shown.map(c => {
              const k = keyOf(c)
              const l = picked[k]
              return (
                <div key={k} className={`px-3 py-2 ${l ? 'bg-brand-50/40' : ''}`} data-testid={`retour-candidate-${k}`}>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={!!l} onChange={() => toggle(c)} />
                    {c.image_url
                      ? <TableThumb src={c.image_url} alt={c.product_name || ''} fit="contain" className="shrink-0 border border-slate-200" />
                      : <div className={`${TABLE_THUMB_CLASS} shrink-0 rounded border border-dashed border-slate-200`} />}
                    {isSerial(c)
                      ? <span className="font-mono font-medium text-slate-900">{c.serial}</span>
                      : <span className="text-xs text-slate-500">#{c.order_number} · {fmtDate(c.shipped_at)} · ×{c.qty}</span>}
                    <span className="text-slate-700 truncate">{c.product_name || c.sku || '—'}</span>
                    {isSerial(c) && (
                      <span className="ml-auto flex items-center gap-2 shrink-0">
                        {c.address != null && c.address !== '' && (
                          <span className="font-mono text-xs text-slate-500" title="Adresse">@{String(c.address).replace(/\.0$/, '')}</span>
                        )}
                        {c.status && <ChoiceBadge color={colorForChoice(statusChoices, c.status)}>{c.status}</ChoiceBadge>}
                      </span>
                    )}
                  </label>
                  {l && (
                    <div className="mt-2 ml-6 grid grid-cols-1 md:grid-cols-[auto_1fr_1fr] gap-2 items-center">
                      <div className="flex items-center gap-2">
                        {!isSerial(c) && (
                          <input type="number" min={1} max={c.qty || 1} className="input text-sm w-16" value={l.qty}
                            onChange={e => setLine(k, { qty: Math.max(1, Math.min(Number(c.qty) || 1, Number(e.target.value) || 1)) })}
                            aria-label="Quantité" title="Quantité" />
                        )}
                        {reasonSelect(l.reason, v => setLine(k, { reason: v }), `retour-reason-${k}`)}
                      </div>
                      <input className="input text-sm" value={l.notes} onChange={e => setLine(k, { notes: e.target.value })} aria-label="Précision" title="Précision" />
                      {exchange && (
                        <SearchableSelect
                          value={l.sub}
                          onChange={v => setLine(k, { sub: v })}
                          options={productOptions}
                          emptyOption="Aucun remplacement"
                          size="sm"
                          className="input text-sm w-full"
                          testId={`retour-sub-${k}`}
                        />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input type="checkbox" checked={exchange} onChange={e => setExchange(e.target.checked)} data-testid="retour-exchange" />
          Échange immédiat
        </label>
        <Hint className="-mt-3 ml-6">Le remplacement part tout de suite, sans attendre la réception du retour. Choisissez le produit de remplacement sur chaque article.</Hint>

        {exchange && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-3 rounded-lg border border-slate-200">
            <div>
              <div className="flex gap-4 text-sm mb-2">
                <label className="flex items-center gap-1.5"><input type="radio" checked={orderMode === 'new'} onChange={() => setOrderMode('new')} />Nouvelle commande</label>
                <label className="flex items-center gap-1.5"><input type="radio" checked={orderMode === 'existing'} onChange={() => setOrderMode('existing')} disabled={!openOrders.length} />Commande existante</label>
              </div>
              {orderMode === 'existing' && (
                <SearchableSelect
                  value={orderId}
                  onChange={setOrderId}
                  size="sm"
                  className="input text-sm w-full"
                  options={openOrders.map(o => ({ value: o.id, label: `#${o.order_number} · ${o.status}` }))}
                  testId="retour-order"
                />
              )}
            </div>
            <div>
              <label className="label">Adresse de livraison</label>
              <SearchableSelect
                value={addressId}
                onChange={setAddressId}
                emptyOption="—"
                size="sm"
                className="input text-sm w-full"
                options={adresses.map(a => ({ value: a.id, label: [a.address_type, fmtAddress(a)].filter(Boolean).join(' · ') }))}
                testId="retour-address"
              />
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-1">
          {!valid && (
            <Hint className="mr-auto">
              {!pickedKeys.length ? 'Cochez au moins un article.'
                : pickedKeys.some(k => !picked[k].reason) ? 'Raison manquante sur un article.'
                : 'Choisissez la commande existante.'}
            </Hint>
          )}
          <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
          <button type="button" disabled={!valid || submitting} onClick={submit} className="btn-primary" data-testid="retour-submit">
            {submitting ? 'Création…' : `Créer${pickedKeys.length ? ` (${pickedKeys.length})` : ''}`}
          </button>
        </div>
      </div>
    </Modal>
  )
}
