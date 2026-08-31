import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, AlertTriangle, Ban, RotateCcw, HelpCircle, ExternalLink } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { VendorTabs } from '../components/VendorTabs.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { Modal } from '../components/Modal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'

import { fmtMoney as fmtMoneyBase } from '../utils/formatters.js'

// Particularités du site : montant absent → null (pas '—'), et la devise
// Airtable « Euro » doit être mappée sur le code ISO 'EUR'.
const fmtMoney = (n, currency = 'CAD') => fmtMoneyBase(n, currency === 'Euro' ? 'EUR' : currency, { fallback: null })

function amountDisplay(row) {
  return row.amount_label || fmtMoney(row.amount, row.currency) || '—'
}

const RENDERS = {
  vendor:         row => <span className="font-medium text-slate-800">{row.vendor}</span>,
  plan:           row => <span className="text-slate-600">{row.plan || '—'}</span>,
  currency:       row => <span className="font-mono text-xs text-slate-600">{row.currency || 'CAD'}</span>,
  variable:       row => <span className="text-slate-600">{row.variable ? 'Variable' : 'Fixe'}</span>,
  amount:         row => <span className="tabular-nums text-slate-800">{amountDisplay(row)}</span>,
  taxes:          row => <span className="text-slate-600">{row.taxes || '—'}</span>,
  frequency:      row => <Badge color={row.frequency === 'Annuel' ? 'blue' : 'gray'}>{row.frequency}</Badge>,
  billing_label:  row => <span className="text-slate-600">{row.billing_label || '—'}</span>,
  period:         row => <span className="text-slate-600">{row.period || '—'}</span>,
  payment_method: row => <span className="text-slate-600">{row.payment_method || '—'}</span>,
  active:         row => row.active
    ? <Badge color="green">Actif</Badge>
    : <Badge color="red">Annulé</Badge>,
  comments:       row => <span className="text-slate-500 text-sm">{row.comments || '—'}</span>,
}

// Bascule actif ↔ annulé, partagée par le tableau, la fiche et le bandeau des
// charges non comptabilisées : mise à jour optimiste, rollback si le PATCH
// échoue, toast d'annulation (pas de confirm bloquant — l'undo suffit).
// Passe par une ref pour rester stable (colonnes du DataTable mémoïsées) tout
// en pouvant se rappeler elle-même depuis l'undo.
function useSubscriptionToggle({ onOptimistic, onSettled } = {}) {
  const { addToast } = useToast()
  const [busyId, setBusyId] = useState(null)
  const ref = useRef(null)
  const toggle = useCallback((sub, active) => ref.current(sub, active), [])
  ref.current = async (sub, active) => {
    setBusyId(sub.id)
    onOptimistic?.({ ...sub, active })
    try {
      const updated = await api.vendorSubscriptions.update(sub.id, { active })
      onSettled?.(updated)
      addToast({
        message: active
          ? `« ${sub.vendor} » réactivé`
          : `Désabonné de « ${sub.vendor} » — retiré des charges attendues`,
        type: active ? 'success' : 'undo',
        duration: 8000,
        action: active ? undefined : { label: 'Annuler', onClick: () => toggle(updated, 1) },
      })
      return updated
    } catch (e) {
      onOptimistic?.(sub) // rollback
      addToast({ message: `Échec : ${e.message}`, type: 'error' })
      return null
    } finally {
      setBusyId(null)
    }
  }
  // Désabonnement en deux temps : le clic ouvre la page de résiliation du
  // fournisseur (nouvel onglet) et n'annule RIEN. La ligne ne quitte la liste
  // qu'après confirmation explicite que l'annulation a été faite là-bas.
  // La réactivation, elle, reste un simple clic.
  const [pending, setPending] = useState(null)
  const request = useCallback((sub, active) => {
    if (active) return toggle(sub, 1)
    // Ouverture SYNCHRONE dans le handler de clic : un window.open différé
    // (useEffect, await, setTimeout) est bloqué comme popup par le navigateur.
    // Un clic = la page du fournisseur s'ouvre, rien d'autre à faire.
    const known = (sub.cancel_url || '').trim()
    const target = known || searchUrlFor(sub.vendor)
    window.open(target, '_blank', 'noopener')
    setPending({ ...sub, openedUrl: target, openedKnown: !!known })
    return null
  }, [toggle])

  const modal = pending ? (
    <UnsubscribeFlowModal
      sub={pending}
      onClose={() => setPending(null)}
      onConfirm={async () => {
        const updated = await toggle(pending, 0)
        setPending(null)
        return updated
      }}
    />
  ) : null

  return { toggle: request, busyId, modal }
}

// Recherche web de la page d'annulation quand aucun lien n'est encore
// enregistré : la plupart des pages de résiliation sont derrière un login et
// n'ont pas d'URL devinable — mieux vaut une recherche honnête qu'un lien
// inventé. Le lien réel se mémorise ensuite sur l'abonnement.
function searchUrlFor(vendor) {
  return `https://www.google.com/search?q=${encodeURIComponent(`${vendor} annuler abonnement compte facturation`)}`
}

function UnsubscribeFlowModal({ sub, onClose, onConfirm }) {
  const [url, setUrl] = useState(sub.cancel_url || '')
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()

  // Ré-ouverture / correction du lien. La page a déjà été ouverte au clic ;
  // ce bouton ne sert qu'à retomber sur ses pieds si ce n'était pas la bonne.
  const openVendorPage = useCallback(async () => {
    const target = (url || '').trim()
    if (target && !/^https?:\/\/\S+$/i.test(target)) {
      addToast({ message: 'Lien invalide (doit commencer par http:// ou https://)', type: 'error' })
      return
    }
    window.open(target || searchUrlFor(sub.vendor), '_blank', 'noopener')
    // Mémorise le lien corrigé : le prochain désabonnement ira droit au but.
    if (target && target !== (sub.cancel_url || '')) {
      try { await api.vendorSubscriptions.update(sub.id, { cancel_url: target }) } catch { /* non bloquant */ }
    }
  }, [url, sub, addToast])

  return (
    <Modal isOpen onClose={onClose} title={`Se désabonner de « ${sub.vendor} »`} size="md">
      <p className="flex items-start gap-2 text-sm text-slate-700">
        <ExternalLink size={15} className="mt-0.5 shrink-0 text-brand-600" />
        <span>
          {sub.openedKnown
            ? <>La page d&apos;abonnement de <strong>{sub.vendor}</strong> vient de s&apos;ouvrir dans un nouvel onglet. Annule l&apos;abonnement là-bas, puis reviens confirmer ici.</>
            : <>Aucune page enregistrée pour <strong>{sub.vendor}</strong> : une recherche s&apos;est ouverte dans un nouvel onglet. Colle le bon lien ci-dessous — il sera mémorisé et ouvert directement la prochaine fois.</>}
        </span>
      </p>
      <div className="flex gap-2 mt-3">
        <input
          className={inputCls}
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://… page d'annulation du fournisseur"
          data-testid="unsub-url"
        />
        <button
          onClick={openVendorPage}
          data-testid="unsub-open-page"
          className="inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
        >
          <ExternalLink size={14} /> Rouvrir
        </button>
      </div>
      <p className="text-xs text-slate-500 mt-1.5">
        L&apos;abonnement ne quitte la liste et les charges attendues qu&apos;après ta confirmation.
      </p>
      <div className="flex items-center justify-end gap-2 mt-5">
        <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">
          Pas encore
        </button>
        {/* Action transactionnelle (annulable via le toast) : bouton explicite
            requis, l'autosave ne s'applique pas ici. */}
        <button
          onClick={async () => { setSaving(true); await onConfirm(); setSaving(false) }}
          disabled={saving}
          data-testid="unsub-confirm"
          className="px-3 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
        >
          {saving ? 'Retrait…' : 'C\'est annulé — retirer de la liste'}
        </button>
      </div>
    </Modal>
  )
}

// Bouton de désabonnement — discret (ghost, texte xs) mais toujours affiché,
// pas seulement au survol. Un clic ouvre la page d'annulation du fournisseur ;
// le retrait de la liste demande ensuite une confirmation. Réutilisé dans la
// ligne du tableau, la fiche et le bandeau des charges non comptabilisées.
function UnsubscribeButton({ sub, onToggle, busy, size = 'sm', idPrefix = '' }) {
  const active = !!sub.active
  const base = size === 'sm'
    ? 'gap-1 px-1.5 py-1 text-xs'
    : 'gap-1.5 px-2.5 py-1.5 text-sm'
  return (
    <button
      onClick={() => onToggle(sub, active ? 0 : 1)}
      disabled={busy}
      data-testid={`${idPrefix}${active ? 'unsub' : 'resub'}-${sub.id}`}
      title={active
        ? `Se désabonner de « ${sub.vendor} » — ouvre la page d'annulation du fournisseur`
        : `Réactiver l'abonnement « ${sub.vendor} »`}
      className={`inline-flex items-center whitespace-nowrap rounded-md border font-medium transition-colors disabled:opacity-50 ${base} ${
        active
          ? 'border-slate-200 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600'
          : 'border-slate-200 text-slate-500 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700'
      }`}
    >
      {active ? <Ban size={size === 'sm' ? 12 : 14} /> : <RotateCcw size={size === 'sm' ? 12 : 14} />}
      {active ? 'Se désabonner' : 'Réactiver'}
    </button>
  )
}

const CURRENCIES = ['CAD', 'USD', 'Euro']
const TAXES = ['', 'TPS/TVQ', 'TPS', 'TVQ', 'Hors-champ']
const FREQUENCIES = ['Mensuel', 'Annuel']
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'
const labelCls = 'block text-xs font-medium text-slate-500 mb-1'

// Fiche d'un abonnement existant — autosave champ par champ (PATCH au blur /
// au changement pour les selects), pas de bouton Enregistrer.
function EditModal({ sub, onClose, onSaved, onDeleted, onToggleActive }) {
  const [form, setForm] = useState(sub)
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // Le désabonnement passe par la modale de la page (ouverture de la page
  // fournisseur + confirmation) : on resynchronise le statut quand il change.
  useEffect(() => {
    setForm(f => ({ ...f, active: sub.active, cancelled_at: sub.cancelled_at, cancel_url: sub.cancel_url }))
  }, [sub.active, sub.cancelled_at, sub.cancel_url])

  const save = async (k, v) => {
    if ((sub[k] ?? '') === (v ?? '')) return
    setSaving(true)
    try {
      const updated = await api.vendorSubscriptions.update(sub.id, { [k]: v === '' ? null : v })
      onSaved(updated)
    } catch (e) {
      addToast({ message: `Sauvegarde échouée : ${e.message}`, type: 'error' })
      setForm(f => ({ ...f, [k]: sub[k] }))
    } finally {
      setSaving(false)
    }
  }

  const text = (k, label, props = {}) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        className={inputCls}
        value={form[k] ?? ''}
        onChange={e => set(k, e.target.value)}
        onBlur={e => save(k, e.target.value.trim() === '' ? null : e.target.value)}
        {...props}
      />
    </div>
  )
  const select = (k, label, options, { asNumber = false, render = o => (o === '' ? '—' : o) } = {}) => (
    <div>
      <label className={labelCls}>{label}</label>
      <select
        className={inputCls}
        value={form[k] ?? ''}
        onChange={e => {
          const v = e.target.value === '' ? null : (asNumber ? Number(e.target.value) : e.target.value)
          set(k, v)
          save(k, v)
        }}
      >
        {options.map(o => <option key={String(o.value ?? o)} value={o.value ?? o}>{o.label ?? render(o)}</option>)}
      </select>
    </div>
  )

  return (
    <Modal isOpen onClose={onClose} title={form.vendor} size="lg">
      <div className="grid grid-cols-2 gap-3">
        {text('vendor', 'Fournisseur')}
        {text('plan', 'Plan / Forfait', { 'data-testid': 'sub-plan' })}
        {select('currency', 'Devise', CURRENCIES)}
        {select('variable', 'Fixe / Variable', [{ value: 0, label: 'Fixe' }, { value: 1, label: 'Variable' }], { asNumber: true })}
        {text('amount', 'Montant avant taxes', { type: 'number', step: '0.01', min: '0' })}
        {text('amount_label', 'Montant affiché (si variable, ex. « 125 à 150 »)')}
        {select('taxes', 'Taxes', TAXES)}
        {select('frequency', 'Fréquence', FREQUENCIES)}
        {select('billing_day', 'Jour de facturation', ['', ...Array.from({ length: 31 }, (_, i) => i + 1)], { asNumber: true })}
        {select('billing_month', 'Mois (si annuel)', ['', ...MONTHS.map((m, i) => ({ value: i + 1, label: m }))], { asNumber: true })}
        {text('billing_label', 'Date affichée dans le sheet (ex. « 12 du mois », « 20 août »)')}
        {text('period', 'Période (« Mois à venir »… )')}
        {text('payment_method', 'Mode de paiement')}
        {select('active', 'Statut', [{ value: 1, label: 'Actif' }, { value: 0, label: 'Annulé' }], { asNumber: true })}
        <div className="col-span-2">
          {text('cancel_url', "Page d'annulation chez le fournisseur (ouverte par « Se désabonner »)", { placeholder: 'https://…' })}
        </div>
        <div className="col-span-2">
          <label className={labelCls}>Commentaires</label>
          <textarea
            className={inputCls}
            rows={2}
            value={form.comments ?? ''}
            onChange={e => set('comments', e.target.value)}
            onBlur={e => save('comments', e.target.value.trim() === '' ? null : e.target.value)}
          />
        </div>
      </div>
      <div className="flex items-center justify-between mt-4">
        <div className="flex items-center gap-3">
          <button
            onClick={async () => {
              if (!confirm(`Supprimer l'abonnement « ${sub.vendor} » ?`)) return
              try {
                await api.vendorSubscriptions.delete(sub.id)
                onDeleted(sub.id)
                onClose()
              } catch (e) { addToast({ message: e.message, type: 'error' }) }
            }}
            className="text-sm text-red-600 hover:underline"
          >
            Supprimer
          </button>
          <UnsubscribeButton
            sub={form}
            busy={saving}
            onToggle={(_s, active) => onToggleActive({ ...sub, ...form }, active)}
          />
          {!form.active && form.cancelled_at && (
            <span className="text-xs text-slate-400">Désabonné le {fmtDate(form.cancelled_at)}</span>
          )}
        </div>
        <span className="text-xs text-slate-400">{saving ? 'Sauvegarde…' : 'Modifications sauvegardées automatiquement'}</span>
      </div>
    </Modal>
  )
}

// Création d'un nouvel abonnement — bouton Créer requis : pas encore d'id,
// l'autosave est impraticable avant l'INSERT.
function CreateModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ currency: 'CAD', frequency: 'Mensuel', variable: 0, active: 1 })
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function create() {
    if (!form.vendor?.trim()) { addToast({ message: 'Nom du fournisseur requis', type: 'error' }); return }
    setSaving(true)
    try {
      const created = await api.vendorSubscriptions.create(form)
      onCreated(created)
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="Nouvel abonnement fournisseur" size="lg">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Fournisseur *</label>
          <input className={inputCls} data-testid="new-sub-vendor" value={form.vendor ?? ''} onChange={e => set('vendor', e.target.value)} autoFocus />
        </div>
        <div>
          <label className={labelCls}>Plan / Forfait</label>
          <input className={inputCls} value={form.plan ?? ''} onChange={e => set('plan', e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Devise</label>
          <select className={inputCls} value={form.currency} onChange={e => set('currency', e.target.value)}>
            {CURRENCIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Montant avant taxes</label>
          <input className={inputCls} type="number" step="0.01" min="0" value={form.amount ?? ''} onChange={e => set('amount', e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Taxes</label>
          <select className={inputCls} value={form.taxes ?? ''} onChange={e => set('taxes', e.target.value || null)}>
            {TAXES.map(t => <option key={t} value={t}>{t === '' ? '—' : t}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Fréquence</label>
          <select className={inputCls} value={form.frequency} onChange={e => set('frequency', e.target.value)}>
            {FREQUENCIES.map(f => <option key={f}>{f}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Jour de facturation</label>
          <select className={inputCls} value={form.billing_day ?? ''} onChange={e => set('billing_day', e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">—</option>
            {Array.from({ length: 31 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Mois (si annuel)</label>
          <select className={inputCls} value={form.billing_month ?? ''} onChange={e => set('billing_month', e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">—</option>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Mode de paiement</label>
          <input className={inputCls} value={form.payment_method ?? ''} onChange={e => set('payment_method', e.target.value)} placeholder="Mastercard, Visa USD, Venn – USD…" />
        </div>
        <div>
          <label className={labelCls}>Date affichée (sheet)</label>
          <input className={inputCls} value={form.billing_label ?? ''} onChange={e => set('billing_label', e.target.value)} placeholder="« 12 du mois », « 20 août »…" />
        </div>
      </div>
      {/* Bouton requis : création d'un nouvel enregistrement (pas encore d'id → autosave impossible) */}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
        <button
          onClick={create}
          disabled={saving}
          data-testid="new-sub-create"
          className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50"
        >
          {saving ? 'Création…' : 'Créer'}
        </button>
      </div>
    </Modal>
  )
}

// Explication en clair de la pièce trouvée par le rapprochement approfondi,
// pour que la confirmation soit un jugement humain éclairé et non un acte de foi.
// Une même charge attendue est identifiée par son abonnement + sa date prévue.
const rowKey = m => `${m.subscription_id}-${m.expected_date}`

function EvidenceLine({ evidence }) {
  const e = evidence
  const why = [
    e.amount_match === 'exact' ? 'montant identique'
      : e.amount_match === 'taxes' ? 'montant + taxes'
        : e.amount_match === 'change' ? 'montant au change près'
          : e.amount_match === 'change+taxes' ? 'montant au change et aux taxes près'
            : null,
    e.reason === 'off_window'
      ? `${e.days_off} j après la date prévue`
      : (e.days_off === 0 ? 'date exacte' : `à ${e.days_off} j de la date prévue`),
  ].filter(Boolean).join(' · ')
  return (
    <span className="text-xs text-emerald-700">
      {e.vendor} · {fmtDate(e.date)} · {fmtMoney(e.amount, e.currency) || '—'}
      <span className="text-emerald-600/70"> ({why})</span>
    </span>
  )
}

// Charges d'abonnement sans dépense comptabilisée. Le croisement côté serveur
// (services/vendorSubscriptions.js) regarde à la fois les reçus ingérés ET le
// miroir QuickBooks des achats fournisseurs, en rapprochant les noms via les
// profils fournisseurs. Quand rien ne sort du rapprochement strict, une seconde
// passe plus fouillée cherche la même dépense sous un AUTRE nom QuickBooks
// (jeton commun, orthographe voisine, montant aux taxes/au change près) ou juste
// hors de la fenêtre attendue — d'où trois statuts distincts affichés ici.
export function MissingReceiptsSection({ refreshKey = 0, onSubscriptionChanged }) {
  const { addToast } = useToast()
  const [data, setData] = useState(null)
  const [linkingId, setLinkingId] = useState(null)
  const [hidden, setHidden] = useState(() => new Set()) // désabonnés à l'instant

  const load = useCallback(() => {
    api.vendorSubscriptions.missingReceipts().then(setData).catch(() => setData({ missing: [] }))
  }, [])
  useEffect(() => { load() }, [load, refreshKey])

  const { toggle, busyId, modal } = useSubscriptionToggle({
    onOptimistic: sub => setHidden(h => {
      const next = new Set(h)
      if (sub.active) next.delete(sub.id); else next.add(sub.id)
      return next
    }),
    onSettled: updated => { onSubscriptionChanged?.(updated); load() },
  })

  const seen = new Set()
  const missing = (data?.missing || [])
    .filter(m => !hidden.has(m.subscription_id))
    .map(m => {
      const first = !seen.has(m.subscription_id)
      seen.add(m.subscription_id)
      return { ...m, first_of_sub: first }
    })
  if (!data || !missing.length) return null
  const nToBook = missing.filter(m => m.status === 'to_book').length
  const nLikely = missing.filter(m => m.status === 'likely_booked').length
  const nMissing = missing.length - nToBook - nLikely

  // Deux corrections possibles, selon la NATURE du constat — c'est ce qui
  // manquait : poser un alias sur une charge « même fournisseur, autre date »
  // ne changeait rien, et la ligne restait obstinément affichée.
  //
  // 1. Autre nom QuickBooks → on retient le nom comme alias du profil fournisseur.
  const confirmSame = async m => {
    setLinkingId(rowKey(m))
    try {
      await api.vendorSubscriptions.linkVendor(m.subscription_id, m.evidence.vendor)
      addToast({ type: 'success', message: `« ${m.evidence.vendor} » retenu comme nom QuickBooks de ${m.vendor}` })
      load()
    } catch (e) {
      addToast({ type: 'error', message: e.message || 'Échec de la liaison' })
    } finally {
      setLinkingId(null)
    }
  }

  // 2. Même fournisseur, facturé à une autre date → on cale la cédule sur la
  //    date réellement constatée (jour, et mois si l'abonnement est annuel).
  const fixSchedule = async m => {
    const [, month, day] = m.evidence.date.split('-')
    setLinkingId(rowKey(m))
    try {
      const patch = { billing_day: Number(day) }
      if (m.frequency === 'Annuel') patch.billing_month = Number(month)
      const updated = await api.vendorSubscriptions.update(m.subscription_id, patch)
      onSubscriptionChanged?.(updated)
      addToast({ type: 'success', message: `Cédule de ${m.vendor} calée sur le ${fmtDate(m.evidence.date)}` })
      load()
    } catch (e) {
      addToast({ type: 'error', message: e.message || 'Échec de la mise à jour' })
    } finally {
      setLinkingId(null)
    }
  }

  return (
    <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4" data-testid="missing-receipts">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle size={16} className="text-amber-600" />
        <h2 className="text-sm font-semibold text-amber-800">
          {missing.length} charge(s) d'abonnement sans dépense comptabilisée
          {nToBook > 0 && ` — dont ${nToBook} avec une pièce déjà reçue`}
          {nLikely > 0 && ` — dont ${nLikely} probablement comptabilisée(s) sous un autre nom`}
        </h2>
      </div>
      <p className="text-xs text-amber-700 mb-3">
        Croisement avec les reçus ingérés <em>et</em> les achats QuickBooks (Bills / Purchases) du même fournisseur.
        {nMissing > 0 && ' Aucune trace : réclamer le reçu, puis le transférer à factures@orisha.io.'}
        {' '}Un abonnement qui n'existe plus se règle avec « Se désabonner » — il sort aussitôt de cette liste.
      </p>
      {nLikely > 0 && (
        <p className="text-xs text-emerald-700 mb-3" data-testid="likely-booked-hint">
          Le rapprochement approfondi a retrouvé {nLikely} dépense(s) déjà dans QuickBooks. Sous un
          <em> autre nom</em> : « C'est le même fournisseur » retient ce nom sur le profil, et les prochaines
          analyses le reconnaîtront d'elles-mêmes. À une <em>autre date</em> (même fournisseur) : c'est la
          cédule qui est mal réglée — un clic la cale sur la date réellement facturée.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-amber-700/70">
              <th className="py-1 pr-4 font-medium">Fournisseur</th>
              <th className="py-1 pr-4 font-medium">Constat</th>
              <th className="py-1 pr-4 font-medium">Charge attendue le</th>
              <th className="py-1 pr-4 font-medium text-right">Montant</th>
              <th className="py-1 pr-4 font-medium">Paiement</th>
              <th className="py-1 pr-4 font-medium">Dernière comptabilisée</th>
              <th className="py-1 font-medium text-right">Toujours abonné ?</th>
            </tr>
          </thead>
          <tbody>
            {missing.map((m, i) => (
              <tr key={`${m.subscription_id}-${m.expected_date}-${i}`} className="border-t border-amber-100 text-amber-900">
                <td className="py-1.5 pr-4 font-medium">
                  <span className="inline-flex items-center gap-1">
                    {m.vendor}
                    {m.profile_matched === false && (
                      <HelpCircle
                        size={12}
                        className="text-amber-500"
                        aria-label="Aucun profil fournisseur"
                        title="Aucun profil fournisseur ne porte ce nom : le rapprochement ne repose que sur la ressemblance des noms. Ajouter un alias dans Fournisseurs → Profils fiabilise le croisement."
                      />
                    )}
                  </span>
                </td>
                <td className="py-1.5 pr-4">
                  {m.status === 'to_book' && (
                    <Badge color="blue">{m.pending_kind === 'achat' ? 'Achat non publié' : 'Reçu non comptabilisé'}</Badge>
                  )}
                  {m.status === 'likely_booked' && (
                    <div className="flex flex-col gap-0.5" data-testid="likely-booked-row">
                      <Badge color="green">
                        {m.evidence.reason === 'off_window'
                          ? 'Comptabilisé à une autre date'
                          : 'Comptabilisé sous un autre nom'}
                      </Badge>
                      <EvidenceLine evidence={m.evidence} />
                      {/* Boutons requis : trancher l'identité d'un fournisseur ou
                          la date réelle de facturation est un jugement humain. */}
                      {m.evidence.reason === 'off_window' ? (
                        <button
                          onClick={() => fixSchedule(m)}
                          disabled={linkingId === rowKey(m)}
                          data-testid={`fix-schedule-${m.subscription_id}`}
                          className="self-start text-xs font-medium text-emerald-700 hover:text-emerald-900 underline underline-offset-2 disabled:opacity-50"
                        >
                          {linkingId === rowKey(m) ? 'Mise à jour…' : `Caler la cédule sur le ${fmtDate(m.evidence.date)}`}
                        </button>
                      ) : (
                        <button
                          onClick={() => confirmSame(m)}
                          disabled={linkingId === rowKey(m)}
                          data-testid={`link-vendor-${m.subscription_id}`}
                          className="self-start text-xs font-medium text-emerald-700 hover:text-emerald-900 underline underline-offset-2 disabled:opacity-50"
                        >
                          {linkingId === rowKey(m) ? 'Liaison…' : "C'est le même fournisseur"}
                        </button>
                      )}
                    </div>
                  )}
                  {m.status === 'missing' && <Badge color="yellow">Aucune trace</Badge>}
                </td>
                <td className="py-1.5 pr-4">{fmtDate(m.expected_date)}</td>
                <td className="py-1.5 pr-4 text-right tabular-nums">{m.amount_label || fmtMoney(m.amount, m.currency) || '—'}</td>
                <td className="py-1.5 pr-4">{m.payment_method || '—'}</td>
                {/* Dernière dépense réellement dans QuickBooks (reçu poussé ou achat QB). */}
                <td className="py-1.5 pr-4">{m.last_booked_date ? fmtDate(m.last_booked_date) : 'jamais'}</td>
                <td className="py-1.5 text-right">
                  {/* Un seul bouton par abonnement, même s'il compte plusieurs charges en retard. */}
                  {m.first_of_sub && (
                    <UnsubscribeButton
                      sub={{ id: m.subscription_id, vendor: m.vendor, active: 1, cancel_url: m.cancel_url }}
                      onToggle={toggle}
                      busy={busyId === m.subscription_id}
                      idPrefix="mr-"
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {modal}
    </div>
  )
}

export default function VendorSubscriptions() {
  const [subs, setSubs] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  // Rechargement du bandeau des charges non comptabilisées après un
  // désabonnement fait depuis le tableau ou la fiche.
  const [missingKey, setMissingKey] = useState(0)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const [searchParams, setSearchParams] = useSearchParams()

  const applyUpdate = useCallback(updated => {
    setSubs(list => list.map(s => (s.id === updated.id ? { ...s, ...updated } : s)))
    setEditing(e => (e && e.id === updated.id ? { ...e, ...updated } : e))
  }, [])

  const { toggle: toggleActive, busyId, modal } = useSubscriptionToggle({
    onOptimistic: applyUpdate,
    onSettled: updated => { applyUpdate(updated); setMissingKey(k => k + 1) },
  })

  const columns = useMemo(() => TABLE_COLUMN_META.vendor_subscriptions.map(meta => ({
    ...meta,
    render: meta.id === 'actions'
      ? row => (
        <div className="flex" onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
          <UnsubscribeButton sub={row} onToggle={toggleActive} busy={busyId === row.id} />
        </div>
      )
      : RENDERS[meta.id],
  })), [toggleActive, busyId])

  const load = useCallback(async () => {
    try {
      const rows = await api.vendorSubscriptions.list()
      if (mounted.current) setSubs(rows)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Ouverture directe d'une fiche depuis la recherche globale (?open=<id>) —
  // consommé une fois puis retiré de l'URL pour ne pas rouvrir au retour arrière.
  useEffect(() => {
    const openId = searchParams.get('open')
    if (!openId || !subs.length) return
    const found = subs.find(s => s.id === openId)
    if (found) setEditing(found)
    setSearchParams(params => { params.delete('open'); return params }, { replace: true })
  }, [searchParams, subs, setSearchParams])

  return (
    <Layout>
      <div className="p-6">
        <VendorTabs active="abonnements" />
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Abonnements fournisseurs</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Registre de référence des charges récurrentes (SaaS, télécom…) et calendrier des reçus attendus.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg"
            >
              <Plus size={14} /> Nouvel abonnement
            </button>
          </div>
        </div>

        <MissingReceiptsSection refreshKey={missingKey} onSubscriptionChanged={applyUpdate} />

        <DataTable
          table="vendor_subscriptions"
          manageViews
          columns={columns}
          data={subs}
          loading={loading}
          searchFields={['vendor', 'plan', 'payment_method', 'comments']}
          onRowClick={row => setEditing(row)}
        />

        {editing && (
          <EditModal
            sub={editing}
            onClose={() => setEditing(null)}
            onSaved={updated => {
              setSubs(list => list.map(s => (s.id === updated.id ? updated : s)))
              setEditing(e => (e && e.id === updated.id ? { ...e, ...updated } : e))
            }}
            onDeleted={id => setSubs(list => list.filter(s => s.id !== id))}
            onToggleActive={toggleActive}
          />
        )}
        {creating && (
          <CreateModal
            onClose={() => setCreating(false)}
            onCreated={created => setSubs(list => [created, ...list])}
          />
        )}
        {/* En dernier : la modale de désabonnement se superpose à la fiche. */}
        {modal}
      </div>
    </Layout>
  )
}
