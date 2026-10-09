import { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'

// La fiche fournisseur, au survol, sans quitter la transaction (choix de Charles,
// 2026-09-29 : « je veux y accéder rapidement à partir de la section transaction »).
// La source est la fiche de /fournisseurs — le Google Doc « Fournisseurs_Particularités »
// y a été rapatrié, il n'est plus lu.
//
// Les fiches lues sont gardées pour la session : survoler la même ligne deux fois
// ne redemande rien au serveur, et un nom sans fiche est mémorisé aussi (null).
const cache = new Map()

function useProfile() {
  const [state, setState] = useState({ name: null, profile: undefined })
  const load = useCallback(async (name) => {
    if (cache.has(name)) { setState({ name, profile: cache.get(name) }); return }
    setState({ name, profile: undefined })
    try {
      const { data } = await api.vendorProfiles.lookup(name)
      cache.set(name, data || null)
      setState((s) => (s.name === name ? { name, profile: data || null } : s))
    } catch {
      setState((s) => (s.name === name ? { name, profile: null } : s))
    }
  }, [])
  return [state, load]
}

function Row({ label, value }) {
  if (!value) return null
  return (
    <div className="flex gap-2 border-t border-slate-100 py-1">
      <span className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-slate-400">{label}</span>
      <span className="text-slate-700">{value}</span>
    </div>
  )
}

function Card({ name, profile, accountName, taxName }) {
  if (profile === undefined) return <div className="text-slate-400">…</div>
  if (!profile) {
    return (
      <>
        <div className="font-semibold text-slate-800">{name}</div>
        <div className="py-1 text-slate-400">Pas de fiche.</div>
        <Link to="/fournisseurs" className="text-brand-600 hover:underline">Créer la fiche</Link>
      </>
    )
  }
  const tags = [profile.usual_currency, profile.payment_method, profile.qb_category].filter(Boolean)
  const tax = [profile.default_tax_code_id_cad && `CAD ${taxName(profile.default_tax_code_id_cad)}`,
    profile.default_tax_code_id_usd && `USD ${taxName(profile.default_tax_code_id_usd)}`].filter(Boolean).join(' · ')
  return (
    <>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="font-semibold text-slate-800">{profile.name}</span>
        <Link to="/fournisseurs" className="text-[11px] text-brand-600 hover:underline">fiche</Link>
      </div>
      {!!tags.length && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {tags.map((t) => (
            <span key={t} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{t}</span>
          ))}
        </div>
      )}
      {profile.description && <div className="mb-1 text-slate-600">{profile.description}</div>}
      {profile.particularites && (
        <div className="mb-1.5 whitespace-pre-line rounded-lg bg-amber-50 px-2 py-1.5 text-slate-700">{profile.particularites}</div>
      )}
      <Row label="Dépense" value={profile.default_expense_account_id && accountName(profile.default_expense_account_id)} />
      <Row label="Taxes" value={tax} />
      <Row label="Échéance" value={profile.payment_terms_days != null ? `Net ${profile.payment_terms_days}` : null} />
      <Row label="Paiement" value={profile.payment_note} />
      <Row label="Dernier reçu" value={profile.last_receipt_date} />
    </>
  )
}

/**
 * Pastille « i » qui ouvre la fiche du fournisseur au survol.
 *
 * Props :
 *   name        – nom du fournisseur saisi dans la ligne (rien affiché si vide)
 *   accountName – (id) => libellé du compte QuickBooks
 *   taxName     – (id) => libellé du code de taxe
 */
export function VendorProfileHint({ name, accountName = (i) => i, taxName = (i) => i }) {
  const [state, load] = useProfile()
  const [pos, setPos] = useState(null)
  const ref = useRef(null)
  const trimmed = String(name || '').trim()
  if (!trimmed) return null

  const open = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    // Au-dessus du champ quand la place manque dessous (la ligne dépliée est souvent
    // en bas de l'écran), et jamais à cheval sur le bord droit.
    const below = window.innerHeight - r.bottom > 260
    setPos({ left: Math.min(r.left, window.innerWidth - 340), top: below ? r.bottom + 6 : r.top - 6, below })
    load(trimmed)
  }

  return (
    <>
      <span ref={ref} onMouseEnter={open} onMouseLeave={() => setPos(null)}
        className="ml-1 inline-flex h-4 w-4 cursor-help items-center justify-center rounded border border-slate-300 text-[10px] font-semibold text-slate-400 hover:border-brand-500 hover:text-brand-600">
        i
      </span>
      {pos && createPortal(
        <div className="fixed z-50 w-80 rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-xl"
          style={{ left: pos.left, top: pos.top, transform: pos.below ? undefined : 'translateY(-100%)' }}>
          <Card name={trimmed} profile={state.name === trimmed ? state.profile : undefined}
            accountName={accountName} taxName={taxName} />
        </div>,
        document.body,
      )}
    </>
  )
}

// ── Survol du nom dans la liste des transactions (choix F2 de Charles,
// 2026-10-06) : après ~1 s sur le nom, l'essentiel de la fiche — où trouver la
// facture, les taxes, et ce qui est à surveiller en orange.
const LABELS = /(Facture à payer|Facture|Taxes et QB|Taxes|Notes?|Remboursement|Livraison partielle|Abonnement mensuel|Dext|Crédit|Compte)\s*:/g
const WARN = /délai|surveiller|ne correspond|attention|cas par cas|difficile|inscrire en cad|après le paiement|ne fonctionne plus|à payer/i

// « Facture: sur le web Taxes: TPS seulement » → [['Facture', 'sur le web'], ['Taxes', 'TPS seulement']]
export function splitParticularites(text) {
  const t = String(text || '')
  const out = []
  let m, last = null, idx = 0
  LABELS.lastIndex = 0
  while ((m = LABELS.exec(t))) {
    if (last) out.push([last, t.slice(idx, m.index).trim()])
    else if (m.index > 0 && t.slice(0, m.index).trim()) out.push(['Note', t.slice(0, m.index).trim()])
    last = m[1]; idx = m.index + m[0].length
  }
  if (last) out.push([last, t.slice(idx).trim()])
  else if (t.trim()) out.push(['Note', t.trim()])
  return out.map(([k, v]) => [k === 'Notes' ? 'Note' : k === 'Taxes et QB' ? 'Taxes' : k, v.replace(/\s*\.$/, '')]).filter(([, v]) => v)
}

function Essentials({ name, profile }) {
  if (profile === undefined) return <div className="text-slate-400">…</div>
  if (!profile) {
    return (
      <>
        <div className="font-semibold text-slate-800">{name}</div>
        <Link to="/fournisseurs" className="text-brand-600 hover:underline">Créer la fiche</Link>
      </>
    )
  }
  const kv = splitParticularites(profile.particularites)
  const get = (k) => kv.find(([a]) => a === k)?.[1]
  const facture = get('Facture'), taxes = get('Taxes')
  const warns = [
    ...kv.filter(([k, v]) => k !== 'Facture' && k !== 'Taxes' && WARN.test(v)).map(([k, v]) => (v.length < 20 ? `${k} : ${v.toLowerCase()}` : v)),
    ...(profile.description && WARN.test(profile.description) ? [profile.description] : []),
    ...[facture, taxes].filter((v) => v && WARN.test(v)),
  ].slice(0, 2)
  const line = (ic, text, warn) => (
    <div key={text} className={`flex items-start gap-2 ${warn ? '-mx-1.5 rounded-md bg-amber-50 px-1.5 py-1 text-amber-800' : 'text-slate-700'}`}>
      <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-bold ${warn ? 'text-amber-600' : 'bg-slate-100 text-slate-500'}`}>{ic}</span>
      <span>{text}</span>
    </div>
  )
  const tags = [profile.usual_currency, profile.qb_category?.split(' ')[0]].filter(Boolean)
  return (
    <>
      <div className="mb-2 border-b border-slate-100 pb-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[14px] font-bold text-slate-800">{profile.name}</span>
          <Link to="/fournisseurs" className="text-[11px] text-brand-600 hover:underline">fiche</Link>
        </div>
        {!!tags.length && (
          <div className="mt-1 flex flex-wrap gap-1">
            {tags.map((t) => (
              <span key={t} className={`rounded-full px-2 py-0.5 text-[11px] ${t === 'USD' ? 'bg-blue-50 font-semibold text-blue-700' : 'bg-slate-100 text-slate-600'}`}>{t}</span>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {facture && line('F', facture.split(/ mais |\. /)[0])}
        {taxes && line('%', taxes.split(',')[0])}
        {warns.map((w) => line('!', w, true))}
        {!facture && !taxes && !warns.length && <span className="text-slate-400">Aucune particularité.</span>}
      </div>
    </>
  )
}

// ── Variante « paiements » (Charles, 2026-10-06 : « la seule info que j'ai
// besoin, c'est de savoir si c'est un paiement ou un virement, où je le paye ») :
// le commentaire du dernier paiement émis (historique Pmt_Suivi compris), sinon
// la note de la fiche, et le compte d'où l'on paie.
let hintsPromise = null
const loadHints = () => (hintsPromise ||= api.treasury.payments.vendorHints()
  .then((list) => new Map(list.map((h) => [h.key, h])))
  .catch(() => { hintsPromise = null; return new Map() }))
const hintKey = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Nom exact, sinon le seul fournisseur connu dont le nom contient l'autre
// (« Novo Express » ↔ « Novo Express inc. ») — jamais de choix ambigu.
function findHint(map, name) {
  const k = hintKey(name)
  if (map.has(k)) return map.get(k)
  if (k.length < 4) return null
  const hits = [...new Set([...map.values()].filter((h) => h.key.length >= 4 && (h.key.includes(k) || k.includes(h.key))))]
  return hits.length === 1 ? hits[0] : null
}

export function payHow(h) {
  const t = `${h?.note || ''} ${h?.account_note || ''}`
  if (h?.method === 'interac' || /interac/i.test(t)) return 'Virement Interac'
  if (h?.method === 'transfert' || /virement (entre|à )|transfert/i.test(t)) return 'Virement entre comptes'
  if (/t[ée]l[ée]virement/i.test(t)) return 'Télévirement'
  if (h?.method === 'carte' || /master|visa|venn|carte|\bmc\b/i.test(t)) return 'Carte de crédit'
  if (h?.method === 'code_paiement' || /code de paiement/i.test(t)) return 'Paiement avec code'
  if (h?.method === 'autre' || /paiement|bnc/i.test(t)) return 'Paiement de facture'
  return null
}

function PayHow({ name, hint }) {
  if (hint === undefined) return <div className="text-slate-400">…</div>
  const how = payHow(hint)
  const note = hint?.note && hint.note.replace(/\s+/g, ' ').trim()
  const where = hint?.account_note || hint?.account
  return (
    <>
      <div className="mb-1 font-semibold text-slate-800">{hint?.name || name}</div>
      {how
        ? <div className="text-[14px] font-bold text-slate-800">{how}</div>
        : <div className="text-slate-400">Aucune info de paiement.</div>}
      {note && note.toLowerCase() !== how?.toLowerCase() && <div className="mt-0.5 text-slate-600">{note}</div>}
      {where && <div className="mt-1.5"><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{where}</span></div>}
    </>
  )
}

/** Enveloppe un nom : la fiche apparaît après un temps d'arrêt de la souris.
 *  variant="payment" : seulement comment et d'où on paie ce fournisseur. */
export function VendorHover({ name, children, delay = 900, className = 'min-w-0 truncate', variant }) {
  const [state, load] = useProfile()
  const [hint, setHint] = useState(undefined)
  const [pos, setPos] = useState(null)
  const ref = useRef(null)
  const timer = useRef(null)
  const inside = useRef(false)
  const trimmed = String(name || '').trim()
  if (!trimmed) return children

  const close = () => { clearTimeout(timer.current); setTimeout(() => { if (!inside.current) setPos(null) }, 150) }
  const enter = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      const below = window.innerHeight - r.bottom > 220
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 340)), top: below ? r.bottom + 6 : r.top - 6, below })
      if (variant === 'payment') loadHints().then((m) => setHint(findHint(m, trimmed)))
      else load(trimmed)
    }, delay)
  }
  return (
    <>
      <span ref={ref} onMouseEnter={enter} onMouseLeave={close} className={className}>{children}</span>
      {pos && createPortal(
        <div className="fixed z-50 w-80 rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-xl"
          onMouseEnter={() => { inside.current = true }} onMouseLeave={() => { inside.current = false; setPos(null) }}
          onClick={(e) => e.stopPropagation()}
          style={{ left: pos.left, top: pos.top, transform: pos.below ? undefined : 'translateY(-100%)' }}>
          {variant === 'payment'
            ? <PayHow name={trimmed} hint={hint} />
            : <Essentials name={trimmed} profile={state.name === trimmed ? state.profile : undefined} />}
        </div>,
        document.body,
      )}
    </>
  )
}

export default VendorProfileHint
