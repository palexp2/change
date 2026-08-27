// Dettes à long terme — cédules de remboursement (BDC, DEC, Ville de Québec…)
// et comptabilisation des versements dans QB (Dr dette · Dr intérêts · Cr banque).
import { useState, useEffect, useCallback } from 'react'
import { Plus, Upload, CheckCircle2, Landmark, ExternalLink, Calculator, Unlink } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'

const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'
const labelCls = 'block text-xs font-medium text-slate-500 mb-1'

function fmtMoney(n, currency = 'CAD') {
  if (n == null) return '—'
  try { return new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(n) }
  catch { return `${Number(n).toFixed(2)} ${currency}` }
}

const today = () => new Date().toISOString().slice(0, 10)

function DebtModal({ debt, onClose, onSaved, onDeleted }) {
  const isNew = !debt?.id
  const [form, setForm] = useState(debt || { label: '', currency: 'CAD', active: 1 })
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // Fiche existante → autosave au blur ; création → bouton (pas encore d'id).
  const save = async (k, v) => {
    if (isNew) return
    if ((debt[k] ?? '') === (v ?? '')) return
    setSaving(true)
    try {
      onSaved(await api.ltDebts.update(debt.id, { [k]: v === '' ? null : v }))
    } catch (e) {
      addToast({ message: `Sauvegarde échouée : ${e.message}`, type: 'error' })
      set(k, debt[k])
    } finally {
      setSaving(false)
    }
  }

  async function create() {
    if (!form.label?.trim()) { addToast({ message: 'Nom de la dette requis', type: 'error' }); return }
    setSaving(true)
    try {
      onSaved(await api.ltDebts.create(form))
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const field = (k, label, props = {}) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        className={inputCls}
        value={form[k] ?? ''}
        onChange={e => set(k, e.target.value)}
        onBlur={e => save(k, e.target.value.trim() === '' ? null : e.target.value.trim())}
        {...props}
      />
    </div>
  )

  return (
    <Modal isOpen onClose={onClose} title={isNew ? 'Nouvelle dette' : form.label} size="lg">
      <div className="grid grid-cols-2 gap-3">
        {field('label', 'Nom *', { placeholder: 'ex. Prêt BDC', autoFocus: isNew })}
        {field('lender', 'Prêteur', { placeholder: 'ex. BDC' })}
        {field('loan_number', 'No de prêt', { placeholder: 'ex. 173280-03' })}
        {field('principal', 'Montant du prêt', { type: 'number', step: '0.01' })}
        {field('qb_debt_acctnum', 'No de compte de dette QB', { placeholder: 'ex. 27100' })}
        {field('qb_interest_acctnum', "No de compte d'intérêts QB", { placeholder: 'ex. 79200' })}
        {field('qb_bank_acctnum', 'No de compte de banque QB', { placeholder: 'ex. 10000' })}
        {!isNew && (
          <div>
            <label className={labelCls}>Statut</label>
            <select className={inputCls} value={form.active ?? 1} onChange={e => { const v = Number(e.target.value); set('active', v); save('active', v) }}>
              <option value={1}>Active</option>
              <option value={0}>Remboursée / inactive</option>
            </select>
          </div>
        )}
        <div className="col-span-2">
          <label className={labelCls}>Notes</label>
          <textarea className={inputCls} rows={2} value={form.notes ?? ''} onChange={e => set('notes', e.target.value)}
            onBlur={e => save('notes', e.target.value.trim() === '' ? null : e.target.value)} />
        </div>
      </div>
      <div className="flex items-center justify-between mt-4">
        {isNew ? (
          // Bouton requis : création d'un nouvel enregistrement (pas encore d'id → autosave impossible)
          <div className="flex w-full justify-end gap-2">
            <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
            <button onClick={create} disabled={saving}
              className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
              {saving ? 'Création…' : 'Créer'}
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={async () => {
                try { await api.ltDebts.delete(debt.id); onDeleted(debt.id); onClose() }
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

// Import par collage : une ligne par versement « date capital intérêt [solde] »,
// séparateurs tab/;/espaces, dates YYYY-MM-DD ou YYYY/MM/DD, montants style
// « 6 806,00 $ » acceptés.
function parsePastedSchedule(text) {
  const rows = []
  const errors = []
  const num = s => Number(String(s).replace(/[^\d,.-]/g, '').replace(/\s/g, '').replace(',', '.'))
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (!line) continue
    const dateMatch = line.match(/(\d{4})[/-](\d{2})[/-](\d{2})/)
    if (!dateMatch) { errors.push(`ligne ${i + 1} : date introuvable`); continue }
    const payment_date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
    const rest = line.slice(dateMatch.index + dateMatch[0].length)
    const amounts = [...rest.matchAll(/-?[\d\s]+(?:[.,]\d{1,2})?(?=\s*\$|\s|;|$)/g)]
      .map(m => num(m[0])).filter(n => Number.isFinite(n))
    if (amounts.length < 2) { errors.push(`ligne ${i + 1} : capital et intérêt requis`); continue }
    const row = { payment_date, principal: amounts[0], interest: amounts[1] }
    if (amounts.length >= 3) row.balance_after = amounts[amounts.length - 1]
    rows.push(row)
  }
  return { rows, errors }
}

function ImportModal({ debt, onClose, onImported }) {
  const [text, setText] = useState('')
  const [replace, setReplace] = useState(false)
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const parsed = parsePastedSchedule(text)

  async function doImport() {
    setSaving(true)
    try {
      const r = await api.ltDebts.importPayments(debt.id, parsed.rows, replace)
      addToast({ message: `${r.inserted} versement(s) importé(s)${r.skipped ? `, ${r.skipped} ignoré(s) (date déjà présente)` : ''}`, type: 'success' })
      onImported()
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={`Importer une cédule — ${debt.label}`} size="lg">
      <p className="text-xs text-slate-500 mb-2">
        Colle les lignes de la cédule : une ligne par versement, au format
        <span className="font-mono mx-1">date capital intérêt [solde]</span>
        (ex. <span className="font-mono">2026-07-23  6 806,00 $  1 852,52 $  247 872,00 $</span>).
      </p>
      <textarea className={`${inputCls} font-mono`} rows={12} value={text} onChange={e => setText(e.target.value)}
        placeholder={'2026-07-23\t6806,00\t1852,52\t247872,00\n2026-08-23\t6806,00\t1863,12\t241066,00'} autoFocus />
      <div className="flex items-center justify-between mt-2 text-xs">
        <label className="flex items-center gap-1.5 text-slate-600">
          <input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} />
          Remplacer les versements non comptabilisés existants
        </label>
        <span className={parsed.errors.length ? 'text-amber-600' : 'text-slate-500'}>
          {parsed.rows.length} versement(s) reconnu(s){parsed.errors.length ? ` · ${parsed.errors[0]}` : ''}
        </span>
      </div>
      {/* Bouton requis : action transactionnelle d'import en lot */}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
        <button onClick={doImport} disabled={saving || !parsed.rows.length}
          className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
          {saving ? 'Import…' : `Importer ${parsed.rows.length} versement(s)`}
        </button>
      </div>
    </Modal>
  )
}

const FREQUENCIES = [
  { value: 'monthly', label: 'Mensuelle' },
  { value: 'quarterly', label: 'Trimestrielle' },
  { value: 'biweekly', label: 'Aux 2 semaines' },
  { value: 'weekly', label: 'Hebdomadaire' },
]

// Génération de la cédule d'amortissement à partir des paramètres du prêt.
// L'aperçu est calculé par le serveur (même code que l'insertion) pour qu'on ne
// puisse pas confirmer une cédule différente de celle affichée.
function GenerateModal({ debt, onClose, onGenerated }) {
  const [form, setForm] = useState({
    opening_balance: debt.remaining_balance ?? debt.principal ?? '',
    annual_rate: debt.annual_rate ?? '',
    frequency: debt.payment_frequency || 'monthly',
    payment_amount: debt.payment_amount ?? '',
    n_payments: '',
    first_payment_date: debt.next_payment_date || today(),
  })
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)
  const [replace, setReplace] = useState(false)
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const r = await api.ltDebts.generatePayments(debt.id, { ...form, preview: true })
        if (!cancelled) { setPreview(r); setError(null) }
      } catch (e) {
        if (!cancelled) { setPreview(null); setError(e.message) }
      }
    }, 350)
    return () => { cancelled = true; clearTimeout(t) }
  }, [debt.id, form])

  async function generate() {
    setSaving(true)
    try {
      const r = await api.ltDebts.generatePayments(debt.id, { ...form, replace })
      addToast({
        message: `${r.inserted} versement(s) générés${r.skipped ? `, ${r.skipped} ignoré(s) (date déjà présente)` : ''}`,
        type: 'success',
      })
      onGenerated()
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const num = (k, label, props = {}) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input className={inputCls} type="number" value={form[k] ?? ''} data-testid={`gen-${k}`}
        onChange={e => set(k, e.target.value)} {...props} />
    </div>
  )
  const rows = preview?.rows || []

  return (
    <Modal isOpen onClose={onClose} title={`Générer la cédule — ${debt.label}`} size="lg">
      <div className="grid grid-cols-3 gap-3">
        {num('opening_balance', "Solde d'ouverture", { step: '0.01', autoFocus: true })}
        {num('annual_rate', 'Taux annuel (%)', { step: '0.0001' })}
        <div>
          <label className={labelCls}>Fréquence</label>
          <select className={inputCls} value={form.frequency} data-testid="gen-frequency"
            onChange={e => set('frequency', e.target.value)}>
            {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Premier versement</label>
          <input className={inputCls} type="date" value={form.first_payment_date || ''} data-testid="gen-first_payment_date"
            onChange={e => set('first_payment_date', e.target.value)} />
        </div>
        {num('payment_amount', 'Montant du versement', { step: '0.01', placeholder: 'ou nombre de versements' })}
        {num('n_payments', 'Nombre de versements', { step: '1', min: '1', placeholder: 'si montant inconnu' })}
      </div>

      <div className="mt-3 border border-slate-200 rounded-lg overflow-hidden" data-testid="gen-preview">
        {error && <div className="p-3 text-sm text-amber-700 bg-amber-50">{error}</div>}
        {!error && !preview && <div className="p-3 text-sm text-slate-400">Calcul…</div>}
        {!error && preview && (
          <>
            <div className="px-3 py-2 text-xs text-slate-600 bg-slate-50 border-b border-slate-100">
              <span data-testid="gen-count">{preview.totals.count} versement(s)</span>
              {' '}du {fmtDate(preview.totals.first_date)} au {fmtDate(preview.totals.last_date)} ·
              capital {fmtMoney(preview.totals.principal, debt.currency)} ·
              intérêts <span data-testid="gen-interest">{fmtMoney(preview.totals.interest, debt.currency)}</span> ·
              total {fmtMoney(preview.totals.total, debt.currency)}
            </div>
            <table className="w-full text-xs">
              <tbody>
                {[...rows.slice(0, 3), ...(rows.length > 4 ? [null] : []), ...(rows.length > 3 ? rows.slice(-1) : [])].map((p, i) => (
                  p === null ? (
                    <tr key="gap"><td colSpan={4} className="px-3 py-1 text-center text-slate-300">⋯</td></tr>
                  ) : (
                    <tr key={p.payment_date + i} className="border-t border-slate-50">
                      <td className="px-3 py-1 whitespace-nowrap">{fmtDate(p.payment_date)}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtMoney(p.principal, debt.currency)}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtMoney(p.interest, debt.currency)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-slate-500">{fmtMoney(p.balance_after, debt.currency)}</td>
                    </tr>
                  )
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <label className="flex items-center gap-1.5 mt-2 text-xs text-slate-600">
        <input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} data-testid="gen-replace" />
        Remplacer les versements non comptabilisés existants
      </label>
      {/* Bouton requis : action transactionnelle (écriture en lot de la cédule) */}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
        <button onClick={generate} disabled={saving || !preview} data-testid="gen-submit"
          className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
          {saving ? 'Génération…' : `Générer ${preview?.totals.count || 0} versement(s)`}
        </button>
      </div>
    </Modal>
  )
}

// Contrôle de concordance : le solde restant de la cédule doit égaler le solde
// du compte de dette dans QuickBooks. Lecture seule — un écart signale une
// cédule décalée (versement oublié, intérêts capitalisés non repris…).
function QbBalanceCheck({ debt }) {
  const [state, setState] = useState(null)

  useEffect(() => {
    let cancelled = false
    setState(null)
    if (!debt.qb_debt_acctnum) return undefined
    api.ltDebts.qbBalance(debt.id)
      .then(r => { if (!cancelled) setState(r) })
      .catch(e => { if (!cancelled) setState({ error: e.message }) })
    return () => { cancelled = true }
  }, [debt.id, debt.qb_debt_acctnum, debt.payment_count, debt.pushed_count])

  if (!debt.qb_debt_acctnum) return null
  if (!state) return <span className="text-xs text-slate-400" data-testid="qb-balance-check">Vérification du solde QB…</span>
  if (state.error) {
    return <span className="text-xs text-slate-400" data-testid="qb-balance-check">Solde QB indisponible : {state.error}</span>
  }
  return (
    <span className="text-xs" data-testid="qb-balance-check">
      {state.matches ? (
        <span className="text-emerald-600">
          Solde concordant avec QuickBooks #{state.acctnum} ({fmtMoney(state.qb_balance, debt.currency)})
        </span>
      ) : (
        <span className="text-amber-600">
          Écart avec QuickBooks #{state.acctnum} : cédule {fmtMoney(state.erp_balance, debt.currency)} · QB {fmtMoney(state.qb_balance, debt.currency)} ({state.delta > 0 ? '+' : ''}{fmtMoney(state.delta, debt.currency)})
        </span>
      )}
    </span>
  )
}

function PublishModal({ debt, payment, onClose, onPublished }) {
  const [publishing, setPublishing] = useState(false)
  const { addToast } = useToast()
  const total = Math.round((payment.principal + payment.interest) * 100) / 100

  async function publish() {
    setPublishing(true)
    try {
      const r = await api.ltDebts.publishPayment(payment.id)
      addToast({
        message: r.warning || `Dépense publiée dans QB (#${r.qb_txn_id}) — cédule jointe en PDF`,
        type: r.warning ? 'error' : 'success',
      })
      onPublished()
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setPublishing(false)
    }
  }

  const row = (label, acct, dr, cr) => (
    <tr className="border-t border-slate-100">
      <td className="py-1.5 pr-3">{label}</td>
      <td className="py-1.5 pr-3 text-slate-500 font-mono text-xs">{acct ? `#${acct}` : <span className="text-red-600">manquant</span>}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{dr ? fmtMoney(dr, debt.currency) : ''}</td>
      <td className="py-1.5 text-right tabular-nums">{cr ? fmtMoney(cr, debt.currency) : ''}</td>
    </tr>
  )

  return (
    <Modal isOpen onClose={onClose} title={`Comptabiliser le versement du ${fmtDate(payment.payment_date)}`} size="md">
      <p className="text-sm text-slate-600 mb-3">
        Dépense qui sera publiée dans QuickBooks ({debt.label}{debt.loan_number ? ` · prêt ${debt.loan_number}` : ''}) :
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-400">
            <th className="text-left font-medium pb-1">Compte</th><th className="text-left font-medium pb-1">No</th>
            <th className="text-right font-medium pb-1">Débit</th><th className="text-right font-medium pb-1">Crédit</th>
          </tr>
        </thead>
        <tbody>
          {payment.principal > 0 && row('Dette à long terme (capital)', debt.qb_debt_acctnum, payment.principal, null)}
          {payment.interest > 0 && row("Frais d'intérêts", debt.qb_interest_acctnum, payment.interest, null)}
          {row('Banque', debt.qb_bank_acctnum, null, total)}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-200 font-medium">
            <td className="py-1.5" colSpan={2}>Total</td>
            <td className="py-1.5 text-right tabular-nums">{fmtMoney(payment.principal + payment.interest, debt.currency)}</td>
            <td className="py-1.5 text-right tabular-nums">{fmtMoney(total, debt.currency)}</td>
          </tr>
        </tfoot>
      </table>
      {payment.balance_after != null && (
        <p className="text-xs text-slate-500 mt-2">Solde de la dette après ce versement : {fmtMoney(payment.balance_after, debt.currency)}</p>
      )}
      {/* Bouton requis : action transactionnelle (publication d'une dépense dans QB) */}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
        <button onClick={publish} disabled={publishing}
          className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
          {publishing ? 'Publication…' : 'Publier dans QuickBooks'}
        </button>
      </div>
    </Modal>
  )
}

// `qbMissing` = versements dont la transaction QB a été supprimée dans
// QuickBooks : rien n'est comptabilisé, on n'affiche donc pas « Publié ».
function paymentStatus(p, qbMissing) {
  const txnLabel = `${p.qb_txn_type === 'purchase' ? 'Dépense' : 'JE'} #${p.qb_txn_id}`
  if (p.qb_txn_id && qbMissing?.has(p.id)) return { label: `Non comptabilisé · ${txnLabel} supprimée dans QB`, color: 'red', missing: true }
  if (p.qb_txn_id) return { label: `Publié · ${txnLabel}`, color: 'green' }
  if (p.pushed_at) return { label: 'Comptabilisé', color: 'green' }
  if (p.payment_date <= today()) return { label: 'À comptabiliser', color: 'amber' }
  return { label: 'À venir', color: 'gray' }
}

export default function DettesLT() {
  const [debts, setDebts] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [editingDebt, setEditingDebt] = useState(null)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [publishing, setPublishing] = useState(null)
  const [showFuture, setShowFuture] = useState(false)
  const [qbMissing, setQbMissing] = useState(null)
  const { addToast } = useToast()
  const confirm = useConfirm()

  const loadDebts = useCallback(async () => {
    const rows = await api.ltDebts.list()
    setDebts(rows)
    setSelectedId(id => id && rows.some(r => r.id === id) ? id : (rows[0]?.id || null))
    return rows
  }, [])

  const loadDetail = useCallback(async (id) => {
    if (!id) { setDetail(null); return }
    setDetail(await api.ltDebts.payments(id))
  }, [])

  useEffect(() => { loadDebts().catch(e => addToast({ message: e.message, type: 'error' })) }, [loadDebts, addToast])
  useEffect(() => { loadDetail(selectedId).catch(e => addToast({ message: e.message, type: 'error' })) }, [selectedId, loadDetail, addToast])

  // Contrôle en arrière-plan : les transactions QB des versements publiés
  // existent-elles toujours ? Supprimée dans QB = rien n'est comptabilisé.
  // Silencieux si QB est indisponible — on garde alors le statut tel quel.
  const pushedCount = detail?.payments?.filter(p => p.qb_txn_id).length || 0
  useEffect(() => {
    let cancelled = false
    setQbMissing(null)
    if (!selectedId || !pushedCount) return undefined
    api.ltDebts.qbCheck(selectedId)
      .then(r => { if (!cancelled) setQbMissing(new Set(r.missing || [])) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selectedId, pushedCount])

  const refresh = () => { loadDebts(); loadDetail(selectedId) }

  async function markBooked(p) {
    try { await api.ltDebts.markBooked(p.id); refresh() }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
  }
  async function unmarkBooked(p) {
    try { await api.ltDebts.unmarkBooked(p.id); refresh() }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
  }
  // Délier la transaction QB : réversible (on peut republier), donc pas de
  // confirmation — sauf si QB répond que la transaction existe encore.
  async function unpublish(p) {
    try {
      await api.ltDebts.unpublishPayment(p.id)
      setQbMissing(m => { if (!m) return m; const n = new Set(m); n.delete(p.id); return n })
      refresh()
    } catch (e) {
      if (/existe encore/i.test(e.message)) {
        const force = await confirm({
          title: 'Délier quand même ?',
          message: `${e.message.replace(/ Supprime-la.*$/, '')} Délier quand même laissera la transaction dans QuickBooks sans lien avec ce versement.`,
          confirmLabel: 'Délier',
        })
        if (!force) return
        try { await api.ltDebts.unpublishPayment(p.id, { force: true }); refresh() }
        catch (e2) { addToast({ message: e2.message, type: 'error' }) }
      } else {
        addToast({ message: e.message, type: 'error' })
      }
    }
  }

  const debt = detail?.debt
  const payments = detail?.payments || []
  // Par défaut : tout l'historique + les 3 prochains versements ; le reste repliable.
  const future = payments.filter(p => p.payment_date > today())
  const futureCount = future.length
  const shownPayments = showFuture ? payments : payments.filter(p => p.payment_date <= today() || future.indexOf(p) < 3)

  return (
    <Layout>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-slate-800">Dettes à long terme</h1>
        <button onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg">
          <Plus size={15} /> Nouvelle dette
        </button>
      </div>

      <div className="flex gap-4 items-start">
        {/* Liste des dettes */}
        <div className="w-72 shrink-0 space-y-2">
          {debts === null && <div className="text-sm text-slate-400 p-3">Chargement…</div>}
          {debts?.length === 0 && <div className="text-sm text-slate-400 p-3">Aucune dette — en créer une pour commencer.</div>}
          {debts?.map(d => (
            <button key={d.id} onClick={() => setSelectedId(d.id)}
              className={`w-full text-left p-3 rounded-xl border transition ${selectedId === d.id ? 'border-brand-400 bg-brand-50/50 ring-1 ring-brand-400/30' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm text-slate-800 truncate">{d.label}</span>
                {d.due_count > 0
                  ? <Badge color="amber">{d.due_count} à comptabiliser</Badge>
                  : d.active ? <Badge color="green">À jour</Badge> : <Badge color="gray">Inactive</Badge>}
              </div>
              <div className="mt-1 text-xs text-slate-500 flex items-center justify-between">
                <span>{d.lender || ''}{d.loan_number ? ` · ${d.loan_number}` : ''}</span>
              </div>
              <div className="mt-1.5 text-sm tabular-nums text-slate-700">
                Solde : <span className="font-medium">{fmtMoney(d.remaining_balance, d.currency)}</span>
              </div>
              {d.next_payment_date && (
                <div className="text-xs text-slate-500 mt-0.5">
                  Prochain versement : {fmtDate(d.next_payment_date)} · {fmtMoney(d.next_payment_total, d.currency)}
                </div>
              )}
            </button>
          ))}
        </div>

        {/* Cédule */}
        <div className="flex-1 min-w-0 bg-white border border-slate-200 rounded-xl">
          {!debt ? (
            <div className="p-8 text-center text-sm text-slate-400">
              <Landmark className="mx-auto mb-2 text-slate-300" size={28} />
              Sélectionner une dette pour voir sa cédule de remboursement.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
                <div>
                  <div className="font-medium text-slate-800">{debt.label}
                    <button onClick={() => setEditingDebt(debt)} className="ml-2 text-xs text-brand-600 hover:underline">Configurer</button>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Dette #{debt.qb_debt_acctnum || '—'} · Intérêts #{debt.qb_interest_acctnum || '—'} · Banque #{debt.qb_bank_acctnum || '—'}
                    {(!debt.qb_debt_acctnum || !debt.qb_interest_acctnum || !debt.qb_bank_acctnum) &&
                      <span className="text-amber-600 ml-1">· comptes QB incomplets</span>}
                  </div>
                  {debt.annual_rate != null && (
                    <div className="text-xs text-slate-500 mt-0.5" data-testid="debt-terms">
                      {String(debt.annual_rate).replace('.', ',')} % ·
                      {' '}{(FREQUENCIES.find(f => f.value === debt.payment_frequency)?.label || '—').toLowerCase()}
                      {debt.payment_amount != null && ` · ${fmtMoney(debt.payment_amount, debt.currency)} par versement`}
                    </div>
                  )}
                  <div className="mt-0.5"><QbBalanceCheck debt={debt} /></div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => setGenerating(true)} data-testid="debt-generate"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 hover:bg-slate-50 rounded-lg">
                    <Calculator size={13} /> Générer une cédule
                  </button>
                  <button onClick={() => setImporting(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 hover:bg-slate-50 rounded-lg">
                    <Upload size={13} /> Importer une cédule
                  </button>
                </div>
              </div>

              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-400 border-b border-slate-100">
                    <th className="text-left font-medium px-4 py-2 w-10">#</th>
                    <th className="text-left font-medium px-2 py-2">Date</th>
                    <th className="text-right font-medium px-2 py-2">Capital</th>
                    <th className="text-right font-medium px-2 py-2">Intérêt</th>
                    <th className="text-right font-medium px-2 py-2">Total</th>
                    <th className="text-right font-medium px-2 py-2">Solde</th>
                    <th className="text-left font-medium px-2 py-2">Statut</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {payments.length === 0 && (
                    <tr><td colSpan={8} className="px-4 py-6 text-center text-slate-400">
                      Aucun versement — importer la cédule de remboursement.
                    </td></tr>
                  )}
                  {shownPayments.map(p => {
                    const st = paymentStatus(p, qbMissing)
                    return (
                      <tr key={p.id} className={`border-b border-slate-50 ${st.color === 'amber' ? 'bg-amber-50/40' : st.missing ? 'bg-red-50/40' : ''}`}>
                        <td className="px-4 py-2 text-slate-400">{p.seq}</td>
                        <td className="px-2 py-2 whitespace-nowrap">{fmtDate(p.payment_date)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{fmtMoney(p.principal, debt.currency)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{fmtMoney(p.interest, debt.currency)}</td>
                        <td className="px-2 py-2 text-right tabular-nums font-medium">{fmtMoney(p.principal + p.interest, debt.currency)}</td>
                        <td className="px-2 py-2 text-right tabular-nums text-slate-500">{fmtMoney(p.balance_after, debt.currency)}</td>
                        <td className="px-2 py-2" data-testid={`payment-status-${p.id}`}>
                          {p.qb_txn_url && !st.missing ? (
                            <a href={p.qb_txn_url} target="_blank" rel="noreferrer" title="Ouvrir dans QuickBooks"
                              className="inline-flex items-center gap-1 group">
                              <Badge color={st.color}>
                                {st.label} <ExternalLink size={11} className="inline -mt-0.5 ml-0.5 opacity-60 group-hover:opacity-100" />
                              </Badge>
                            </a>
                          ) : <Badge color={st.color}>{st.label}</Badge>}
                        </td>
                        <td className="px-4 py-2 text-right whitespace-nowrap">
                          {!p.pushed_at && (
                            <>
                              <button onClick={() => setPublishing(p)}
                                className="px-2 py-1 text-xs font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-md">
                                Comptabiliser
                              </button>
                              <button onClick={() => markBooked(p)} title="Déjà comptabilisé à la main dans QB — marquer sans publier"
                                className="ml-1.5 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 border border-slate-200 rounded-md">
                                <CheckCircle2 size={13} className="inline -mt-0.5" /> Marquer
                              </button>
                            </>
                          )}
                          {p.pushed_at && !p.qb_txn_id && (
                            <button onClick={() => unmarkBooked(p)}
                              className="px-2 py-1 text-xs text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-md">
                              Démarquer
                            </button>
                          )}
                          {p.qb_txn_id && (
                            <button onClick={() => unpublish(p)} data-testid={`payment-unpublish-${p.id}`}
                              title="La transaction n'existe plus dans QuickBooks — délier pour pouvoir recomptabiliser"
                              className={`px-2 py-1 text-xs rounded-md hover:bg-slate-50 ${st.missing ? 'text-red-600 hover:text-red-700' : 'text-slate-400 hover:text-slate-600'}`}>
                              <Unlink size={13} className="inline -mt-0.5" /> Délier
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {!showFuture && futureCount > 3 && (
                <button onClick={() => setShowFuture(true)}
                  className="w-full py-2.5 text-xs text-slate-500 hover:bg-slate-50 border-t border-slate-100 rounded-b-xl">
                  Afficher les {futureCount - 3} versements futurs restants
                </button>
              )}
              {showFuture && futureCount > 3 && (
                <button onClick={() => setShowFuture(false)}
                  className="w-full py-2.5 text-xs text-slate-500 hover:bg-slate-50 border-t border-slate-100 rounded-b-xl">
                  Réduire
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {(creating || editingDebt) && (
        <DebtModal
          debt={editingDebt}
          onClose={() => { setCreating(false); setEditingDebt(null) }}
          onSaved={d => { refresh(); if (editingDebt) setEditingDebt(prev => ({ ...prev, ...d })) }}
          onDeleted={() => { setSelectedId(null); refresh() }}
        />
      )}
      {importing && debt && (
        <ImportModal debt={debt} onClose={() => setImporting(false)} onImported={refresh} />
      )}
      {generating && debt && (
        <GenerateModal debt={debt} onClose={() => setGenerating(false)} onGenerated={refresh} />
      )}
      {publishing && debt && (
        <PublishModal debt={debt} payment={publishing} onClose={() => setPublishing(null)} onPublished={refresh} />
      )}
    </Layout>
  )
}
