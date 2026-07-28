import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { Plus, RefreshCw, Landmark, ShieldAlert, ArrowRightLeft, CheckCircle2, HeartHandshake, Receipt, ExternalLink, Paperclip, Wallet, List, CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Modal } from '../components/Modal.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { MissingReceiptsSection } from './VendorSubscriptions.jsx'

function fmtCad(n, digits = 0) {
  if (n == null) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n)
}

function Card({ title, description, icon: Icon, iconClass = 'bg-slate-100 text-slate-500', actions, children, testId, className = '' }) {
  return (
    <section className={`bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col ${className}`} data-testid={testId}>
      <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          {Icon && (
            <span className={`shrink-0 mt-0.5 h-8 w-8 rounded-lg flex items-center justify-center ${iconClass}`}>
              <Icon size={16} />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-slate-900 leading-tight">{title}</h2>
            {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
          </div>
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      <div className="p-5 flex-1">{children}</div>
    </section>
  )
}

// ── Projection BNC ───────────────────────────────────────────────────────────

function RecurringModal({ item, onClose, onChanged }) {
  const isNew = !item?.id
  const [form, setForm] = useState(item || { frequency: 'monthly', active: 1 })
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // Édition d'une récurrente existante : autosave au blur / changement.
  const save = async (k, v) => {
    if (isNew) return
    setSaving(true)
    try {
      await api.treasury.recurring.update(item.id, { [k]: v === '' ? null : v })
      onChanged()
    } catch (e) {
      addToast({ message: `Sauvegarde échouée : ${e.message}`, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function create() {
    if (!form.label?.trim()) { addToast({ message: 'Libellé requis', type: 'error' }); return }
    setSaving(true)
    try {
      await api.treasury.recurring.create(form)
      onChanged()
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30'
  const labelCls = 'block text-xs font-medium text-slate-500 mb-1'
  const field = (k, label, props = {}) => (
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

  return (
    <Modal isOpen onClose={onClose} title={isNew ? 'Nouvelle sortie récurrente' : form.label} size="md">
      <div className="grid grid-cols-2 gap-3">
        {field('label', 'Libellé', { 'data-testid': 'recurring-label' })}
        {field('amount', 'Montant (CAD)', { type: 'number', step: '0.01', min: '0' })}
        <div>
          <label className={labelCls}>Type de montant</label>
          <select
            className={inputCls}
            data-testid="recurring-variable"
            value={form.variable_amount ? 1 : 0}
            onChange={e => { const v = Number(e.target.value); set('variable_amount', v); save('variable_amount', v) }}
          >
            <option value={0}>Fixe — même montant à chaque occurrence</option>
            <option value={1}>Variable — à ressaisir à chaque occurrence</option>
          </select>
          {!!form.variable_amount && (
            <p className="text-[11px] text-slate-400 mt-1">
              Le montant saisi ne s'applique qu'à la prochaine occurrence (ex. relevé Mastercard). Une fois la date passée, il faudra le ressaisir.
            </p>
          )}
        </div>
        <div>
          <label className={labelCls}>Fréquence</label>
          <select
            className={inputCls}
            value={form.frequency ?? 'monthly'}
            onChange={e => { set('frequency', e.target.value); save('frequency', e.target.value) }}
          >
            <option value="weekly">Hebdomadaire</option>
            <option value="biweekly">Aux 2 semaines</option>
            <option value="monthly">Mensuelle</option>
            <option value="quarterly">Trimestrielle</option>
          </select>
        </div>
        {(form.frequency === 'monthly')
          ? field('day_of_month', 'Jour du mois (1-31)', { type: 'number', min: 1, max: 31 })
          : field('anchor_date', 'Date d\'ancrage (une occurrence connue)', { type: 'date' })}
        <div>
          <label className={labelCls}>Statut</label>
          <select
            className={inputCls}
            value={form.active ?? 1}
            onChange={e => { const v = Number(e.target.value); set('active', v); save('active', v) }}
          >
            <option value={1}>Active</option>
            <option value={0}>Suspendue</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className={labelCls}>Notes</label>
          <textarea
            className={inputCls} rows={2}
            value={form.notes ?? ''}
            onChange={e => set('notes', e.target.value)}
            onBlur={e => save('notes', e.target.value.trim() === '' ? null : e.target.value)}
          />
        </div>
      </div>
      <div className="flex items-center justify-between mt-4">
        {isNew ? (
          // Bouton requis : pas encore d'id, autosave impossible avant l'INSERT.
          <div className="flex gap-2 ml-auto">
            <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
            <button onClick={create} disabled={saving} data-testid="recurring-create"
              className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
              {saving ? 'Création…' : 'Créer'}
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={async () => {
                if (!confirm(`Supprimer « ${form.label} » ?`)) return
                try { await api.treasury.recurring.delete(item.id); onChanged(); onClose() }
                catch (e) { addToast({ message: e.message, type: 'error' }) }
              }}
              className="text-sm text-red-600 hover:underline"
            >
              Supprimer
            </button>
            <span className="text-xs text-slate-400">{saving ? 'Sauvegarde…' : 'Modifications sauvegardées automatiquement'}</span>
          </>
        )}
      </div>
    </Modal>
  )
}

const FREQ_LABELS = { weekly: 'Hebdo', biweekly: 'Aux 2 sem.', monthly: 'Mensuelle', quarterly: 'Trimestrielle' }

function KpiTile({ label, value, sub, icon: Icon, tone = 'slate', testId }) {
  const tones = {
    slate:   { icon: 'bg-slate-100 text-slate-500', value: 'text-slate-900' },
    emerald: { icon: 'bg-emerald-50 text-emerald-600', value: 'text-emerald-700' },
    rose:    { icon: 'bg-rose-50 text-rose-600', value: 'text-rose-600' },
    amber:   { icon: 'bg-amber-50 text-amber-600', value: 'text-amber-600' },
  }
  const t = tones[tone] || tones.slate
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-4 py-3.5 flex items-start gap-3" data-testid={testId}>
      <span className={`shrink-0 h-9 w-9 rounded-lg flex items-center justify-center ${t.icon}`}>
        <Icon size={17} />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400 truncate">{label}</p>
        <p className={`text-xl font-semibold tabular-nums leading-tight ${t.value}`}>{value}</p>
        {sub && <p className="text-[11px] text-slate-400 mt-0.5 truncate">{sub}</p>}
      </div>
    </div>
  )
}

// Fiche résumée d'une facture fournisseur, ouverte depuis un mouvement de la
// projection — l'essentiel seulement (montant à sortir, échéance, lignes, PDF),
// sans quitter le dashboard. Lien vers la fiche complète pour le reste.
function BillPeekModal({ peek, onClose }) {
  const [achat, setAchat] = useState(null)
  const [attachments, setAttachments] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    setAchat(null); setAttachments([]); setError(null)
    if (!peek) return
    api.achatsFournisseurs.get(peek.id).then(setAchat).catch(e => setError(e.message))
    api.achatsFournisseurs.attachments.list(peek.id).then(setAttachments).catch(() => {})
  }, [peek])

  async function download(att) {
    try {
      const { blob, filename } = await api.achatsFournisseurs.attachments.download(peek.id, att.id)
      const url = URL.createObjectURL(blob)
      const a = Object.assign(document.createElement('a'), { href: url, download: filename })
      a.click()
      URL.revokeObjectURL(url)
    } catch {}
  }

  let lines = []
  try { lines = JSON.parse(achat?.lines || '[]') } catch {}
  if (!Array.isArray(lines)) lines = []

  // À la fermeture, `peek` repasse à null avant que l'effet ne vide `achat` :
  // ne rien rendre plutôt que de lire peek.date sur null.
  if (!peek) return null

  return (
    <Modal isOpen={!!peek} title="Mouvement projeté — facture fournisseur" onClose={onClose}>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!achat && !error && <div className="h-24 flex items-center justify-center text-sm text-slate-400">Chargement…</div>}
      {achat && (
        <div className="space-y-4">
          <div>
            <p className="text-lg font-semibold text-slate-900">{achat.vendor || 'Fournisseur inconnu'}</p>
            <p className="text-sm text-slate-500">
              {achat.vendor_invoice_number || achat.bill_number ? `Facture ${achat.vendor_invoice_number || achat.bill_number} · ` : ''}
              statut {achat.status}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Sortie projetée</p>
              <p className="font-semibold text-slate-900 tabular-nums">{fmtCad(achat.balance_due_cad, 2)}</p>
              {peek.date && <p className="text-xs text-slate-500">paiement prévu le {fmtDate(peek.date)}</p>}
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Échéance</p>
              <p className="font-semibold text-slate-900">{achat.due_date ? fmtDate(achat.due_date) : '—'}</p>
              <p className="text-xs text-slate-500">total {fmtCad(achat.total_cad, 2)}{Number(achat.amount_paid_cad) > 0 ? ` · payé ${fmtCad(achat.amount_paid_cad, 2)}` : ''}</p>
            </div>
          </div>

          {lines.length > 0 && (
            <div className="rounded-lg border border-slate-100 divide-y divide-slate-100 text-sm">
              {lines.map((l, i) => (
                <div key={i} className="px-3 py-1.5 flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-slate-700">{l.description || l.account_name || `Ligne ${i + 1}`}</span>
                  <span className="shrink-0 tabular-nums text-slate-600">{fmtCad(l.amount, 2)}</span>
                </div>
              ))}
            </div>
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map(att => (
                <button key={att.id} onClick={() => download(att)}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
                  <Paperclip size={13} /> {att.file_name || 'Pièce jointe'}
                </button>
              ))}
            </div>
          )}

          <div className="flex justify-end items-center gap-4 pt-1 border-t border-slate-100">
            {peek.qbUrl && (
              <a href={peek.qbUrl} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 hover:underline">
                Ouvrir dans QuickBooks <ExternalLink size={14} />
              </a>
            )}
            <Link to={`/fournisseurs/achats?id=${achat.id}`}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline">
              Ouvrir la fiche complète <ExternalLink size={14} />
            </Link>
          </div>
        </div>
      )}
    </Modal>
  )
}

// Vue calendrier mensuelle de la projection : chaque jour de l'horizon affiche
// son solde projeté (coloré selon le seuil) et ses mouvements en pastilles
// cliquables — mêmes cibles que la vue liste (facture, payout, récurrente).
function ProjectionCalendar({ days, threshold, renderEvent }) {
  const todayStr = new Date().toLocaleDateString('en-CA')
  const [month, setMonth] = useState(todayStr.slice(0, 7)) // 'YYYY-MM'
  const byDate = useMemo(() => new Map(days.map(d => [d.date, d])), [days])

  const [y, m] = month.split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  // Grille alignée sur dimanche ; les semaines entièrement hors mois sont omises.
  const start = new Date(y, m - 1, 1 - first.getDay())
  const weeks = []
  for (let w = 0; w < 6; w++) {
    const week = []
    for (let i = 0; i < 7; i++) {
      const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i)
      week.push({ date: dt.toLocaleDateString('en-CA'), inMonth: dt.getMonth() === m - 1, dayNum: dt.getDate() })
    }
    if (week.some(c => c.inMonth)) weeks.push(week)
  }
  const nav = delta => setMonth(new Date(y, m - 1 + delta, 1).toLocaleDateString('en-CA').slice(0, 7))
  const monthLabel = first.toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })
  const navBtn = 'h-6 w-6 rounded-md flex items-center justify-center text-slate-500 hover:bg-slate-100'

  return (
    <div className="rounded-lg border border-slate-100 overflow-hidden" data-testid="treasury-calendar">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100">
        <span className="text-sm font-semibold text-slate-800 capitalize">{monthLabel}</span>
        <div className="flex items-center gap-1">
          {month !== todayStr.slice(0, 7) && (
            <button type="button" onClick={() => setMonth(todayStr.slice(0, 7))}
              className="text-xs font-medium text-brand-600 hover:underline mr-1.5">
              Aujourd&apos;hui
            </button>
          )}
          <button type="button" onClick={() => nav(-1)} className={navBtn} title="Mois précédent"><ChevronLeft size={15} /></button>
          <button type="button" onClick={() => nav(1)} className={navBtn} title="Mois suivant"><ChevronRight size={15} /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[10px] font-medium uppercase tracking-wide text-slate-400 border-b border-slate-100">
        {['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'].map(d => <div key={d} className="py-1">{d}</div>)}
      </div>
      {weeks.map((week, wi) => (
        <div key={wi} className={`grid grid-cols-7 ${wi > 0 ? 'border-t border-slate-100' : ''}`}>
          {week.map(cell => {
            const day = byDate.get(cell.date)
            const isToday = cell.date === todayStr
            const balCls = day == null ? '' : day.balance < 0 ? 'text-rose-600' : day.balance < threshold ? 'text-amber-600' : 'text-slate-400'
            return (
              <div key={cell.date}
                className={`min-h-[4.5rem] p-1 border-l border-slate-100 first:border-l-0 ${cell.inMonth ? '' : 'bg-slate-50/70'}`}>
                <div className="flex items-center justify-between gap-1 mb-0.5">
                  <span className={`text-[11px] tabular-nums leading-none ${isToday
                    ? 'h-[1.125rem] min-w-[1.125rem] px-0.5 rounded-full bg-brand-600 text-white font-semibold flex items-center justify-center'
                    : cell.inMonth ? 'text-slate-500' : 'text-slate-300'}`}>
                    {cell.dayNum}
                  </span>
                  {day != null && (
                    <span className={`text-[10px] tabular-nums font-medium truncate ${balCls}`} title={`Solde projeté : ${fmtCad(day.balance)}`}>
                      {fmtCad(day.balance)}
                    </span>
                  )}
                </div>
                <div className="space-y-0.5">
                  {(day?.events || []).map((e, i) => renderEvent(e, cell.date, i, true))}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export function TreasuryProjectionSection() {
  const [proj, setProj] = useState(null)
  const [recurring, setRecurring] = useState([])
  const [balanceInput, setBalanceInput] = useState('')
  const [noting, setNoting] = useState(false)
  const [editing, setEditing] = useState(null) // {} = nouveau, {id...} = édition
  const [billPeek, setBillPeek] = useState(null) // {id, date} = facture fournisseur cliquée
  // Vue des mouvements : liste chronologique ou calendrier mensuel (mémorisé).
  const [projView, setProjView] = useState(() => localStorage.getItem('treasury_proj_view') || 'list')
  const switchView = v => { setProjView(v); localStorage.setItem('treasury_proj_view', v) }
  const { addToast } = useToast()

  const load = useCallback(() => {
    api.treasury.projection().then(setProj).catch(() => {})
    api.treasury.recurring.list().then(setRecurring).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  async function noteBalance() {
    // Accepte la virgule décimale ("12345,67") et les espaces de milliers.
    const n = Number(balanceInput.replace(/\s/g, '').replace(',', '.'))
    if (!Number.isFinite(n)) { addToast({ message: 'Entrer un montant valide', type: 'error' }); return }
    setNoting(true)
    try {
      await api.treasury.noteBalance(n)
      setBalanceInput('')
      addToast({ message: 'Solde noté — projection mise à jour', type: 'success' })
      load()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setNoting(false)
    }
  }

  const entry = proj?.balance_entry
  const eventDays = (proj?.days || []).filter(d => d.events.length > 0)
  // À saisir : montant manquant, ou montant variable dont l'occurrence est passée.
  const needsAmount = recurring.filter(r => r.active && (!(Number(r.amount) > 0) || r.amount_stale))
  // Fenêtre d'action : la trésorerie est gérée au fur et à mesure — seuls les
  // prochains jours sont décisionnels, le reste de l'horizon est indicatif.
  const aw = proj?.action_window
  const awEndDate = aw && proj?.days?.[Math.min(aw.days, proj.days.length - 1)]?.date
  const belowAction = aw && aw.min_balance < proj.threshold

  // Pastille d'un mouvement — partagée entre la vue liste et le calendrier
  // (compact) : chaque mouvement mène à sa source (facture fournisseur en
  // modale, payout Stripe en fiche, récurrente en modale ici).
  const renderEvent = (e, date, i, compact = false) => {
    const tone = e.amount >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
    const cls = compact
      ? `block w-full text-left truncate text-[10px] leading-4 px-1 py-px rounded ${tone}`
      : `inline-block mr-1.5 mb-0.5 text-xs px-2 py-0.5 rounded-full ${tone}`
    const amountTxt = `${e.amount >= 0 ? '+' : '−'}${fmtCad(Math.abs(e.amount))}`
    const text = compact ? <>{amountTxt} {e.label}</> : <>{e.label} {amountTxt}</>
    const title = compact ? `${e.label} · ${amountTxt}` : undefined
    if (e.kind === 'bill' && e.ref) {
      if (compact) return (
        <button key={i} type="button" onClick={() => setBillPeek({ id: e.ref, date, qbUrl: e.qb_url })}
          className={`${cls} hover:ring-1 hover:ring-slate-300`} title={`${title} — voir la facture fournisseur`}>{text}</button>
      )
      return (
        <span key={i} className="inline-flex items-center mr-1.5 mb-0.5">
          <button type="button" onClick={() => setBillPeek({ id: e.ref, date, qbUrl: e.qb_url })}
            className={`${cls} !mr-0 !mb-0 ${e.qb_url ? '!rounded-r-none' : ''} hover:ring-1 hover:ring-slate-300`}
            title="Voir la facture fournisseur">{text}</button>
          {e.qb_url && (
            <a href={e.qb_url} target="_blank" rel="noreferrer"
              className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-r-full border-l border-white bg-slate-100 text-slate-500 hover:bg-emerald-50 hover:text-emerald-700"
              title="Ouvrir l'écriture dans QuickBooks">QB</a>
          )}
        </span>
      )
    }
    if (e.kind === 'payout' && e.ref) return (
      <Link key={i} to={`/stripe-payouts/${e.ref}`} className={`${cls} hover:ring-1 hover:ring-emerald-300`}
        title={compact ? `${title} — voir le payout Stripe` : 'Voir le payout Stripe'}>{text}</Link>
    )
    if (e.kind === 'recurring' && e.ref) {
      const rec = recurring.find(r => r.id === e.ref)
      if (rec) return (
        <button key={i} type="button" onClick={() => setEditing(rec)} className={`${cls} hover:ring-1 hover:ring-slate-300`}
          title={compact ? `${title} — voir la sortie récurrente` : 'Voir la sortie récurrente'}>{text}</button>
      )
    }
    return <span key={i} className={cls} title={title}>{text}</span>
  }

  return (
    <div data-testid="treasury-section">
      {/* KPIs trésorerie */}
      {proj && (
        <div className="grid grid-cols-2 xl:grid-cols-3 gap-4 mb-6">
          <KpiTile
            label="Solde BNC noté"
            value={entry ? fmtCad(entry.balance, 2) : '—'}
            sub={entry
              ? `le ${fmtDate(entry.noted_at)} (il y a ${proj.balance_age_days} j)${proj.balance_stale ? ' — à mettre à jour' : ''}`
              : 'aucune saisie — projection à 0 $'}
            icon={Landmark}
            tone={entry && !proj.balance_stale ? 'slate' : 'amber'}
          />
          {/* Première date de passage sous le seuil (tout l'horizon) — plus
              actionnable qu'un point bas sur fenêtre fixe. */}
          {proj.first_below_threshold ? (
            <KpiTile
              label={proj.first_negative ? 'Solde négatif projeté' : 'Passage sous le seuil'}
              value={<span data-testid="treasury-min-balance">{fmtCad((proj.first_negative || proj.first_below_threshold).balance)}</span>}
              sub={`le ${fmtDate((proj.first_negative || proj.first_below_threshold).date)} · seuil ${fmtCad(proj.threshold)}`}
              icon={ShieldAlert}
              tone={proj.first_negative ? 'rose' : 'amber'}
            />
          ) : (
            <KpiTile
              label={`Solde sous ${fmtCad(proj.threshold)}`}
              value={<span data-testid="treasury-min-balance">Jamais</span>}
              sub={`sur ${proj.horizon_days} jours · point bas ${fmtCad(proj.min_balance)} le ${fmtDate(proj.min_date)}`}
              icon={ShieldAlert}
              tone="emerald"
            />
          )}
          {aw?.suggested_transfer > 0 ? (
            <KpiTile
              label={`Virement suggéré d'ici ${aw.days} j`}
              value={fmtCad(aw.suggested_transfer)}
              sub="Venn → BNC (Interac) · garder 15 000 USD min"
              icon={ArrowRightLeft}
              tone="rose"
              testId="treasury-transfer-suggestion"
            />
          ) : (
            <KpiTile
              label="Virement"
              value="Aucun requis"
              sub={`solde au-dessus du seuil d'ici ${aw?.days ?? 14} jours`}
              icon={CheckCircle2}
              tone="emerald"
            />
          )}
        </div>
      )}

      <Card
        title="Projection du solde BNC (CAD)"
        description="Solde saisi + payouts Stripe − factures à leur échéance − sorties récurrentes."
        icon={Landmark}
        iconClass="bg-brand-50 text-brand-600"
        actions={
          <div className="flex items-center gap-2">
            <input
              type="text" inputMode="decimal"
              value={balanceInput}
              onChange={e => setBalanceInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') noteBalance() }}
              placeholder={entry ? `Solde réel (dernier : ${entry.balance})` : 'Solde réel (site BNC)'}
              className="w-52 px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              data-testid="treasury-balance-input"
            />
            {/* Action transactionnelle : chaque saisie crée une entrée horodatée */}
            <button onClick={noteBalance} disabled={noting} data-testid="treasury-balance-save"
              className="px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50 whitespace-nowrap">
              {noting ? '…' : 'Noter le solde'}
            </button>
          </div>
        }
        className="mb-6"
      >
        {!proj && <div className="h-24 flex items-center justify-center text-sm text-slate-400">Chargement de la projection…</div>}

        {proj && (
          <div className="grid gap-6 xl:grid-cols-3">
            {/* Mouvements à venir */}
            <div className="xl:col-span-2 min-w-0">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Mouvements à venir</h3>
                <div className="flex items-center rounded-lg border border-slate-200 p-0.5" role="tablist" aria-label="Vue des mouvements">
                  {[{ v: 'list', icon: List, label: 'Liste' }, { v: 'calendar', icon: CalendarDays, label: 'Calendrier' }].map(({ v, icon: Icon, label }) => (
                    <button key={v} type="button" onClick={() => switchView(v)} title={label}
                      role="tab" aria-selected={projView === v} data-testid={`treasury-view-${v}`}
                      className={`h-6 w-7 rounded-md flex items-center justify-center transition-colors ${projView === v ? 'bg-slate-100 text-slate-700' : 'text-slate-400 hover:text-slate-600'}`}>
                      <Icon size={14} />
                    </button>
                  ))}
                </div>
              </div>
              {projView === 'calendar' ? (
                <ProjectionCalendar days={proj.days || []} threshold={proj.threshold} renderEvent={renderEvent} />
              ) : (
              <div className="overflow-x-auto overflow-y-auto max-h-96 rounded-lg border border-slate-100">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white shadow-[0_1px_0_#e2e8f0]">
                    <tr className="text-left text-xs text-slate-500">
                      <th className="py-2 px-3 font-medium">Date</th>
                      <th className="py-2 px-3 font-medium">Mouvements</th>
                      <th className="py-2 pl-3 pr-2 font-medium text-right">Δ jour</th>
                      <th className="py-2 pl-3 pr-3 font-medium text-right">Solde projeté</th>
                    </tr>
                  </thead>
                  <tbody>
                    {eventDays.map((d, idx) => {
                      // Au-delà de la fenêtre d'action : rangées estompées, sous un
                      // séparateur — c'est de l'information, pas une urgence.
                      const beyond = awEndDate && d.date > awEndDate
                      const firstBeyond = beyond && (idx === 0 || !(eventDays[idx - 1].date > awEndDate))
                      return (
                        <Fragment key={d.date}>
                          {firstBeyond && (
                            <tr className="border-t border-slate-100 bg-slate-50/80">
                              <td colSpan={4} className="py-1.5 px-3 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                                Au-delà de {aw.days} jours — à titre indicatif
                              </td>
                            </tr>
                          )}
                          <tr className={`border-t border-slate-100 align-top hover:bg-slate-50/60 ${beyond ? 'opacity-50' : ''}`}>
                            <td className="py-2 px-3 whitespace-nowrap text-slate-600">{fmtDate(d.date)}</td>
                            <td className="py-2 px-3">
                              {d.events.map((e, i) => renderEvent(e, d.date, i))}
                            </td>
                            <td className={`py-2 pl-3 pr-2 text-right tabular-nums whitespace-nowrap ${d.delta < 0 ? 'text-slate-500' : 'text-emerald-700'}`}>
                              {d.delta >= 0 ? '+' : ''}{fmtCad(d.delta)}
                            </td>
                            <td className={`py-2 pl-3 pr-3 text-right tabular-nums font-semibold whitespace-nowrap ${d.balance < 0 ? 'text-rose-600' : d.balance < proj.threshold ? 'text-amber-600' : 'text-slate-800'}`}>
                              {fmtCad(d.balance)}
                            </td>
                          </tr>
                        </Fragment>
                      )
                    })}
                    {!eventDays.length && (
                      <tr><td colSpan={4} className="py-4 px-3 text-sm text-slate-500">Aucun mouvement prévu sur l'horizon.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              )}
            </div>

            {/* Sorties récurrentes */}
            <div className="min-w-0">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Sorties récurrentes</h3>
                <button onClick={() => setEditing({})} data-testid="recurring-add"
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
                  <Plus size={13} /> Ajouter
                </button>
              </div>
              {needsAmount.length > 0 && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5 mb-2">
                  ⚠️ {needsAmount.map(r => r.label).join(', ')} : montant à saisir — exclu(s) de la projection d'ici là.
                </p>
              )}
              <div className="rounded-lg border border-slate-100 divide-y divide-slate-100 overflow-hidden">
                {recurring.map(r => (
                  <button key={r.id} onClick={() => setEditing(r)}
                    className={`w-full text-left px-3 py-2 flex items-center justify-between gap-3 hover:bg-slate-50 ${r.active ? '' : 'opacity-50'}`}>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-800 truncate">{r.label}</span>
                      <span className="block text-[11px] text-slate-400">
                        {FREQ_LABELS[r.frequency] || r.frequency}
                        {r.frequency === 'monthly' && r.day_of_month ? ` · le ${r.day_of_month}` : ''}
                        {r.variable_amount ? ' · variable' : ''}
                        {r.variable_amount && r.amount_applies_to ? ` · s'applique le ${fmtDate(r.amount_applies_to)}` : ''}
                        {!r.active ? ' · suspendue' : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm tabular-nums font-medium text-slate-700">
                      {!(Number(r.amount) > 0) || (r.variable_amount && r.amount_stale)
                        ? <span className="text-amber-600 font-medium">à saisir</span>
                        : fmtCad(r.amount, 2)}
                    </span>
                  </button>
                ))}
                {!recurring.length && (
                  <p className="px-3 py-3 text-sm text-slate-400">Aucune sortie récurrente.</p>
                )}
              </div>
            </div>
          </div>
        )}

        {editing !== null && (
          <RecurringModal
            item={editing.id ? editing : null}
            onClose={() => setEditing(null)}
            onChanged={load}
          />
        )}

        <BillPeekModal peek={billPeek} onClose={() => setBillPeek(null)} />
      </Card>
    </div>
  )
}

// Comptabilisation de la paie — réplique la section « SALAIRES » de l'onglet
// Paie & Ass. coll. du CTB - Suivi : on saisit le montant passé au compte BNC,
// les remboursements de dépenses (items de la paie) et le téléphone Martin sont
// déduits, le reste est réparti au prorata entre les départements, puis la
// dépense QB (fournisseur « Salaires ») est publiée au modèle des transactions
// historiques, avec la période de paie en mémo et en description.
// Paies à comptabiliser : période terminée (le débit bancaire suit la fin de
// période) et pas encore de dépense QB associée.
function todoPaies(paies) {
  const today = new Date().toISOString().slice(0, 10)
  return paies.filter(p => p.period_end && p.period_end <= today && !p.salary_purchase_id)
}

function PaieComptabilisationCard() {
  const [paies, setPaies] = useState([])
  const [paieId, setPaieId] = useState('')
  const [loaded, setLoaded] = useState(false)
  // Montant saisi à la main = le débit réellement vu au compte BNC (pas de
  // pré-remplissage, demande utilisateur — le total Airtable/l'estimation ne
  // servent que de repère). Seule la date est pré-remplie (« Débité » Airtable).
  const [bankAmount, setBankAmount] = useState('')
  const [txnDate, setTxnDate] = useState(() => new Date().toISOString().slice(0, 10))
  // Téléphone Martin : détecté dans les items de la paie (remboursement de
  // dépense de 25 $ de Martin, une fois par mois) — jamais saisi ici, jamais
  // compté en double avec les remboursements.
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)
  const [pushing, setPushing] = useState(false)
  const [pushed, setPushed] = useState(null)
  const { addToast } = useToast()

  useEffect(() => {
    // Réconciliation d'abord : marque les paies dont la dépense « Paie – X au Y »
    // existe déjà dans QB (comptabilisées à la main / avant l'ERP), pour ne
    // proposer que les périodes réellement à faire.
    api.paies.salaryExpenseReconcile().catch(() => {}).then(() =>
      api.paies.list({ limit: 12 }).then(({ data }) => {
        setPaies(data)
        setLoaded(true)
        // Présélection : la plus ancienne paie passée pas encore comptabilisée
        // (on comptabilise dans l'ordre chronologique).
        const todo = todoPaies(data)
        if (todo.length) selectPaie(todo[todo.length - 1])
      })
    ).catch(() => setLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const paie = paies.find(p => p.id === paieId)
  const todos = todoPaies(paies)
  // Le total Airtable n'existe qu'une fois les remises aux organismes saisies
  // (avant ça, la formule Airtable est ≤ 0 et le sync laisse le champ vide).
  const airtableTotal = Number(paie?.total_with_charges_and_reimb) > 0 ? Number(paie.total_with_charges_and_reimb) : null

  // Sélection d'une paie : pré-remplit le montant avec le total Airtable
  // (à confirmer contre le débit BNC) et rafraîchit l'aperçu.
  function selectPaie(p) {
    setPaieId(p.id)
    setPushed(null)
    setPreview(null)
    setError(null)
    // Date : « Débité » des items Airtable (jour du débit BNC), sinon aujourd'hui.
    const date = p.debited_date || new Date().toISOString().slice(0, 10)
    setTxnDate(date)
    setBankAmount('')
  }

  // Libellé de période : « du X au Y » quand le début est connu, sinon l'ancien format.
  function periodLabel(p) {
    if (p.period_start && p.period_end) return `Période du ${p.period_start} au ${p.period_end}`
    return `Période finissant le ${p.period_end || '?'}`
  }

  const loadPreview = useCallback((opts = {}) => {
    const id = opts.paieId ?? paieId
    // Virgule décimale et espaces de milliers tolérés.
    const n = Number(String(opts.bankAmount ?? bankAmount).replace(/\s/g, '').replace(',', '.'))
    if (!id || !(n > 0)) { setPreview(null); setError(null); return }
    api.paies.salaryExpensePreview(id, { bank_amount: n, txn_date: opts.txnDate ?? txnDate })
      .then(p => { setPreview(p); setError(null) })
      .catch(e => { setError(e.message); setPreview(null) })
  }, [paieId, bankAmount, txnDate])

  async function push() {
    setPushing(true)
    try {
      const out = await api.paies.salaryExpensePush(paieId, {
        bank_amount: Number(String(bankAmount).replace(/\s/g, '').replace(',', '.')), txn_date: txnDate,
      })
      setPushed({ id: out.qb_purchase_id, url: out.qb_purchase_url })
      setPaies(ps => ps.map(p => p.id === paieId ? { ...p, salary_purchase_id: out.qb_purchase_id } : p))
      addToast({ message: `Dépense publiée dans QuickBooks (#${out.qb_purchase_id})`, type: 'success' })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setPushing(false)
    }
  }

  const alreadyPushed = pushed?.id || paie?.salary_purchase_id
  const alreadyPushedUrl = pushed?.url || paie?.salary_purchase_url
  const inputCls = 'px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30'
  const KIND_LABELS = { reimb: 'Remb. dépenses' }

  return (
    <Card
      title="Comptabilisation de la paie"
      description="Montant passé au compte BNC − remboursements − téléphone → répartition par département → dépense QuickBooks."
      icon={Wallet}
      iconClass="bg-emerald-50 text-emerald-600"
      testId="compta-paie"
      className="lg:col-span-2"
    >
      {loaded && !paie ? (
        <p className="text-sm text-slate-500" data-testid="compta-paie-empty">
          Aucune paie à comptabiliser — toutes les périodes terminées ont leur dépense QuickBooks. ✓
        </p>
      ) : (
      <>
      <div className="flex flex-wrap items-end gap-3 mb-3">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Paie à comptabiliser</label>
          {/* Seules les paies à comptabiliser (période terminée, pas de dépense QB)
              sont proposées — pas d'historique. Une seule → libellé fixe ; celle
              qui vient d'être publiée reste affichée avec son ✓. */}
          {todos.length > 1 ? (
            <select className={`${inputCls} min-w-56`} value={paieId} data-testid="compta-paie-select"
              onChange={e => { const p = paies.find(x => x.id === e.target.value); if (p) selectPaie(p) }}>
              {todos.map(p => (
                <option key={p.id} value={p.id}>
                  {[p.number != null ? `#${p.number}` : null, periodLabel(p)].filter(Boolean).join(' — ')}
                </option>
              ))}
            </select>
          ) : (
            <div className="px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg bg-slate-50 min-w-56" data-testid="compta-paie-select">
              {paie ? [paie.number != null ? `#${paie.number}` : null, periodLabel(paie)].filter(Boolean).join(' — ') : 'Aucune'}
            </div>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Montant passé au compte BNC</label>
          <input type="text" inputMode="decimal" className={`${inputCls} w-40`} data-testid="compta-paie-amount"
            value={bankAmount} placeholder="ex. 23 570,19"
            onChange={e => { setBankAmount(e.target.value); setPushed(null) }}
            onBlur={e => loadPreview({ bankAmount: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') loadPreview() }} />
          {airtableTotal != null && (
            <p className="text-[11px] text-slate-400 mt-0.5" title="À titre de repère — le montant à saisir est le débit réellement vu au compte BNC">
              Repère — total Airtable : {fmtCad(airtableTotal, 2)}
            </p>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Date (débit bancaire)</label>
          <input type="date" className={inputCls} value={txnDate}
            onChange={e => { setTxnDate(e.target.value); loadPreview({ txnDate: e.target.value }) }} />
          {paie?.debited_date && txnDate === paie.debited_date && (
            <p className="text-[11px] text-slate-400 mt-0.5" title="Colonne « Débité » des items de paie dans Airtable">
              Date « Débité » (Airtable)
            </p>
          )}
        </div>
        <div className="ml-auto">
          {alreadyPushed ? (
            alreadyPushedUrl ? (
              <a href={alreadyPushedUrl} target="_blank" rel="noreferrer" title="Ouvrir la dépense dans QuickBooks"
                className="text-xs text-green-700 bg-green-100 hover:bg-green-200 px-2 py-1 rounded-full whitespace-nowrap">
                Comptabilisée — dépense QB #{alreadyPushed} ↗
              </a>
            ) : (
              <span className="text-xs text-green-700 bg-green-100 px-2 py-1 rounded-full whitespace-nowrap">
                Comptabilisée — dépense QB #{alreadyPushed}
              </span>
            )
          ) : (
            // Action transactionnelle (publication QB) : bouton volontaire.
            <button onClick={push} disabled={pushing || !preview} data-testid="compta-paie-push"
              title={!preview ? 'Saisis le montant passé au compte BNC pour publier' : undefined}
              className="px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50 whitespace-nowrap">
              {pushing ? 'Publication…' : 'Pousser dans QuickBooks'}
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

      {preview && (
        <div className="grid gap-4 md:grid-cols-[auto_1fr] items-start">
          {/* Le calcul de la base, comme dans le haut de l'onglet Salaires */}
          <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-sm space-y-1 min-w-64">
            <div className="flex justify-between gap-6"><span className="text-slate-500">Déboursé de la paie</span><span className="tabular-nums">{fmtCad(preview.bank_amount, 2)}</span></div>
            <div className="flex justify-between gap-6"><span className="text-slate-500">− Remb. de dépenses</span><span className="tabular-nums">{fmtCad(-preview.reimb_total, 2)}</span></div>
            <div className="flex justify-between gap-6"><span className="text-slate-500">− Téléphone Martin</span><span className="tabular-nums">{fmtCad(-preview.phone, 2)}</span></div>
            <div className="flex justify-between gap-6 border-t border-slate-200 pt-1 font-semibold"><span>Salaires à répartir</span><span className="tabular-nums">{fmtCad(preview.base, 2)}</span></div>
          </div>

          <div>
            <table className="text-sm w-full">
              <tbody>
                {preview.lines.map((l, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="py-1 pr-3 font-mono text-xs text-slate-500">{l.acctnum || ''}</td>
                    <td className="py-1 pr-3 text-slate-600">
                      {l.kind === 'salary' ? l.description : (l.kind === 'reimb' ? `${KIND_LABELS.reimb} — ${l.employee_name}` : l.description)}
                    </td>
                    {/* Code de taxe de chaque ligne, tel qu'il sera poussé dans QB. */}
                    <td className="py-1 pr-3 text-xs text-slate-400 whitespace-nowrap">{l.taxcode || ''}</td>
                    <td className="py-1 pr-3 text-right text-xs text-slate-400 tabular-nums">{l.pct != null ? `${l.pct} %` : ''}</td>
                    <td className="py-1 text-right tabular-nums font-medium">{fmtCad(l.amount, 2)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="py-1.5" colSpan={3}><span className="text-xs text-slate-400">Mémo : {preview.memo}</span></td>
                  <td className="py-1.5 pr-3 text-right text-xs text-slate-500">Total</td>
                  <td className="py-1.5 text-right tabular-nums font-semibold">{fmtCad(preview.total, 2)}</td>
                </tr>
              </tbody>
            </table>
            {preview.warnings?.map((w, i) => <p key={i} className="text-xs text-amber-700 mt-1">⚠️ {w}</p>)}
          </div>
        </div>
      )}
      {!preview && !error && (
        <p className="text-xs text-slate-400">Inscris le montant passé au compte BNC (la date « Débité » est pré-remplie depuis Airtable) : la dépense QuickBooks est créée et le total reporté dans Airtable.</p>
      )}
      </>
      )}
    </Card>
  )
}

// Répartition de l'assurance collective AGA par département (prorata en nb
// d'employés assurés — onglet Salaires du CTB - Suivi). Aperçu puis publication
// d'une écriture de journal QB.
function AgaRepartitionCard() {
  const [amount, setAmount] = useState('')
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)
  const [pushing, setPushing] = useState(false)
  const [pushedJe, setPushedJe] = useState(null)
  const { addToast } = useToast()

  async function loadPreview(v) {
    const n = Number(v ?? amount)
    if (!(n > 0)) { setPreview(null); return }
    try {
      setPreview(await api.paies.agaRepartitionPreview(n))
      setError(null)
    } catch (e) {
      setError(e.message)
      setPreview(null)
    }
  }

  async function push() {
    if (!confirm('Publier l\'écriture de répartition AGA sur QuickBooks ?')) return
    setPushing(true)
    try {
      const out = await api.paies.agaRepartitionPush(Number(amount))
      setPushedJe({ id: out.qb_journal_entry_id, url: out.qb_journal_entry_url })
      addToast({ message: `Écriture publiée (JE #${out.qb_journal_entry_id})`, type: 'success' })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setPushing(false)
    }
  }

  return (
    <Card
      title="Assurance collective (AGA)"
      description="Répartition d'un paiement par département (prorata des employés assurés) → écriture de journal QuickBooks."
      icon={HeartHandshake}
      iconClass="bg-violet-50 text-violet-600"
      testId="compta-aga"
    >
      <div className="flex items-end gap-3 mb-3">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Montant du paiement AGA (CAD)</label>
          <input type="number" step="0.01" min="0"
            value={amount}
            onChange={e => { setAmount(e.target.value); setPushedJe(null) }}
            onBlur={e => loadPreview(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') loadPreview() }}
            placeholder="ex. 2737.95"
            className="w-44 px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30" />
        </div>
        {preview && !preview.warnings?.length && !pushedJe && (
          // Action transactionnelle (publication QB) : bouton volontaire.
          <button onClick={push} disabled={pushing}
            className="px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
            {pushing ? 'Publication…' : 'Publier sur QB'}
          </button>
        )}
        {pushedJe && (pushedJe.url ? (
          <a href={pushedJe.url} target="_blank" rel="noreferrer" title="Ouvrir l'écriture dans QuickBooks"
            className="text-xs text-green-700 bg-green-100 hover:bg-green-200 px-2 py-1 rounded-full">
            Publiée — JE #{pushedJe.id} ↗
          </a>
        ) : (
          <span className="text-xs text-green-700 bg-green-100 px-2 py-1 rounded-full">Publiée — JE #{pushedJe.id}</span>
        ))}
      </div>
      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
      {preview && (
        <>
          <table className="text-sm w-full">
            <tbody>
              {preview.lines.map((l, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-1 pr-3 text-xs text-slate-500">{l.type === 'Debit' ? 'Débit' : 'Crédit'}</td>
                  <td className="py-1 pr-3 font-mono text-xs">{l.acctnum}</td>
                  <td className="py-1 pr-3 text-slate-600">{l.label}</td>
                  <td className="py-1 text-right tabular-nums font-medium">{fmtCad(l.amount, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.warnings?.map((w, i) => <p key={i} className="text-xs text-amber-700 mt-1.5">⚠️ {w}</p>)}
        </>
      )}
      {!preview && !error && (
        <p className="text-xs text-slate-400">Entre le montant du prélèvement pour voir l'aperçu de l'écriture avant publication.</p>
      )}
    </Card>
  )
}

export default function ComptaDashboard() {
  return (
    <Layout>
      <div className="p-6 max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Dashboard comptabilité</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Trésorerie, projection BNC et reçus manquants.
          </p>
        </div>

        <TreasuryProjectionSection />

        <div className="grid gap-6 lg:grid-cols-2 items-start">
          <PaieComptabilisationCard />
          <AgaRepartitionCard />

          <Card
            title="Reçus manquants"
            description="Charges d'abonnements attendues sans reçu ingéré via factures@orisha.io."
            icon={Receipt}
            iconClass="bg-rose-50 text-rose-500"
            testId="compta-missing-receipts"
          >
            <MissingReceiptsSection />
            <p className="text-xs text-slate-400 flex items-center gap-1 mt-2">
              <RefreshCw size={11} /> Géré depuis la page Abonnements fournisseurs.
            </p>
          </Card>
        </div>
      </div>
    </Layout>
  )
}
