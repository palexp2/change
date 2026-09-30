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

export default VendorProfileHint
