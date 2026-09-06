import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Upload, Wand2, CheckCheck, Undo2, Link2, Unlink, ExternalLink, RefreshCw, AlertTriangle, ChevronRight, FileSpreadsheet, BookOpen, Download, Clock, SearchCheck, Plus, ArrowLeftRight } from 'lucide-react'
import api from '../lib/api.js'
import { invalidate } from '../lib/prefetch.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtMoney } from '../utils/formatters.js'
import { VendorSelect } from '../components/VendorSelect.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'

// Sentinel « pas de taxe » des profils fournisseurs (côté serveur : bankActions.js).
const NO_TAX = '__none__'

// Statuts = l'ancien code couleur du fichier TRX_Orisha.xlsx. `cell` peint la
// cellule du tableau (le fichier était lu à la couleur, pas au texte) ; `color`
// reste la pastille du panneau latéral.
const STATUS_META = {
  a_traiter:     { label: 'À traiter',      color: 'red',    cell: 'bg-red-50 text-red-700',     hint: 'Aucun document trouvé — souvent facture manquante' },
  facture_recue: { label: 'Facture reçue',  color: 'blue',   cell: 'bg-sky-50 text-sky-700',     hint: 'Document apparié, pas encore publié à QB' },
  comptabilise:  { label: 'Comptabilisé',   color: 'yellow', cell: 'bg-amber-50 text-amber-700', hint: 'Publié à QuickBooks, pas encore rapproché' },
  rapproche:     { label: 'Rapproché',      color: 'green',  cell: 'bg-green-50 text-green-700', hint: 'Comptabilisé et validé contre le relevé' },
  ignore:        { label: 'Ignoré',         color: 'gray',   cell: 'bg-slate-100 text-slate-500', hint: 'Exclu du rapprochement' },
}

const money = (n, currency = 'CAD') => fmtMoney(n, currency, { fallback: <span className="text-slate-300">—</span> })

// Libellé d'une transaction : « Autres détails » du relevé en principal (il
// nomme la nature réelle — « NOVO EXPRESS » — là où la description de la
// banque reste générique — « PMTS ENTREPRISES »), description en second.
// Les relevés sans « Autres détails » retombent sur la description seule.
const txnLabel = (t) => t.details || t.description || '(sans description)'
const txnSubLabel = (t) => (t.details && t.description && t.details !== t.description ? t.description : null)

function docLink(type, id, label) {
  const to = type === 'achat' ? `/fournisseurs/achats?id=${id}`
    : type === 'receipt' ? `/sale-receipts/${id}`
    : type === 'stripe_payout' ? '/stripe-payouts' : null
  if (!to) return label || '—'
  return <Link to={to} onClick={(e) => e.stopPropagation()} className="text-brand-600 hover:underline">{label || type}</Link>
}

// ── Modale d'import par collage ──────────────────────────────────────────────
// Import = action transactionnelle (pas d'autosave) : collage → aperçu → confirmation.
function ImportModal({ account, onClose, onDone }) {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const doPreview = async () => {
    setBusy(true); setError(null)
    try {
      setPreview(await api.bank.import(account.id, { text, preview: true }))
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const doImport = async () => {
    setBusy(true); setError(null)
    try {
      const res = await api.bank.import(account.id, { text })
      onDone(res)
    } catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <Modal isOpen onClose={onClose} title={`Importer un relevé — ${account.name}`} size="lg">
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Coller les lignes du relevé (depuis Excel ou le site de la banque), <strong>avec la ligne d'entêtes</strong> (Date,
          Description, Montant ou Débit/Crédit…). Les doublons déjà importés sont ignorés automatiquement.
        </p>
        <textarea
          className="w-full h-48 border border-slate-300 rounded-lg p-2 font-mono text-xs"
          value={text}
          onChange={(e) => { setText(e.target.value); setPreview(null) }}
        />
        {error && <div className="text-sm text-red-600">{error}</div>}
        {preview && (
          <div className="text-sm bg-slate-50 rounded-lg p-3 space-y-1">
            <div><strong>{preview.rows.length}</strong> transaction{preview.rows.length > 1 ? 's' : ''} reconnue{preview.rows.length > 1 ? 's' : ''}</div>
            {preview.parseErrors?.length > 0 && (
              <div className="text-amber-700">{preview.parseErrors.slice(0, 5).map((e, i) => <div key={i}>⚠️ {e}</div>)}</div>
            )}
            <div className="max-h-40 overflow-auto mt-1">
              <table className="w-full text-xs">
                <tbody>
                  {preview.rows.slice(0, 30).map((r, i) => (
                    <tr key={i} className="border-t border-slate-200">
                      <td className="py-0.5 pr-2 whitespace-nowrap">{r.txn_date}</td>
                      <td className="pr-2 truncate max-w-[16rem]">
                        {txnLabel(r)}
                        {txnSubLabel(r) && <span className="text-slate-400"> · {txnSubLabel(r)}</span>}
                      </td>
                      <td className={`text-right whitespace-nowrap ${r.amount < 0 ? 'text-red-700' : 'text-green-700'}`}>{r.amount.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50" onClick={onClose}>Annuler</button>
          {!preview ? (
            <button className="px-3 py-1.5 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
              disabled={busy || !text.trim()} onClick={doPreview}>
              {busy ? 'Analyse…' : 'Analyser'}
            </button>
          ) : (
            <button className="px-3 py-1.5 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
              disabled={busy || !preview.rows.length} onClick={doImport}>
              {busy ? 'Import…' : `Importer ${preview.rows.length} transactions`}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}

// ── « Ajouter » : comptabiliser une ligne qui n'aura jamais de facture ──────
//
// Le pendant du bouton « Ajouter » de QuickBooks. Les valeurs proposées ne sont
// pas devinées : elles viennent du profil du fournisseur, puis de la façon dont
// on a réellement comptabilisé ce fournisseur les fois précédentes. Quand ces
// fois-là ne concordent pas, on le dit plutôt que de choisir en silence.
function AddExpenseForm({ txn, currency, onDone, onCancel }) {
  const [defaults, setDefaults] = useState(null)
  const [form, setForm] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [taxCodes, setTaxCodes] = useState([])
  const [rate, setRate] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    api.bank.addDefaults(txn.id).then((d) => {
      if (!alive) return
      setDefaults(d)
      setForm({
        vendor: d.vendor || '',
        expense_account_id: d.expense_account_id || '',
        tax_code_id: d.tax_code_id || '',
        memo: d.memo || d.label || '',
      })
    }).catch((e) => setError(e.message))
    Promise.all([api.quickbooks.accounts(), api.quickbooks.taxCodes()])
      .then(([a, t]) => { if (alive) { setAccounts(a || []); setTaxCodes(t || []) } })
      .catch(() => {})
    return () => { alive = false }
  }, [txn.id])

  // Taux d'achat du code choisi : c'est lui qui dit quelle part du montant
  // débité est de la taxe. Un aller-retour par code, gardé en mémoire.
  const taxCodeId = form?.tax_code_id
  useEffect(() => {
    if (!taxCodeId || taxCodeId === NO_TAX) { setRate(null); return }
    let alive = true
    setRate(undefined)
    api.bank.taxCodeRate(taxCodeId).then((r) => { if (alive) setRate(r.percent) }).catch(() => { if (alive) setRate(null) })
    return () => { alive = false }
  }, [taxCodeId])

  const total = Math.abs(txn.amount)
  const taxCad = rate ? Math.round((total - total / (1 + rate / 100)) * 100) / 100 : 0

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      const r = await api.bank.addExpense(txn.id, {
        vendor: form.vendor,
        expense_account_id: form.expense_account_id,
        tax_code_id: form.tax_code_id || null,
        tax_cad: taxCad,
        memo: form.memo,
        payment_account_id: defaults?.payment_account_id || null,
      })
      invalidate('/bank')
      if (r.qbError) setError(`Écriture créée, publication QuickBooks refusée : ${r.qbError}`)
      else onDone()
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  if (!form) return <div className="p-4 text-sm text-slate-400">{error || 'Chargement…'}</div>

  const h = defaults?.history
  const accountName = (id) => accounts.find((a) => String(a.Id) === String(id))?.Name || id
  const taxName = (id) => (id === NO_TAX ? 'aucune' : taxCodes.find((t) => String(t.Id) === String(id))?.Name || id)
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="space-y-3 text-sm">
      <div className="text-xs text-slate-500">
        Comptabiliser {money(total, currency)} sans facture. {defaults?.source ? `Proposé d'après : ${defaults.source}.` : 'Aucun fournisseur reconnu.'}
      </div>

      <label className="block">
        <span className="text-xs text-slate-500">Fournisseur</span>
        <VendorSelect value={form.vendor} onChange={({ vendor }) => set('vendor')(vendor)} />
      </label>

      <label className="block">
        <span className="text-xs text-slate-500">Compte de dépense</span>
        <SearchableSelect value={form.expense_account_id} onChange={set('expense_account_id')}
          options={accounts} getOptionValue={(a) => String(a.Id)}
          getOptionLabel={(a) => `${a.AcctNum ? `${a.AcctNum} · ` : ''}${a.Name}`}
          placeholder="Choisir un compte" />
      </label>

      <label className="block">
        <span className="text-xs text-slate-500">Taxe</span>
        <SearchableSelect value={form.tax_code_id} onChange={set('tax_code_id')}
          options={taxCodes} getOptionValue={(t) => String(t.Id)} getOptionLabel={(t) => t.Name}
          emptyOption="Aucune taxe" placeholder="Aucune taxe" />
        {rate === undefined && <span className="text-xs text-slate-400">taux…</span>}
        {!!rate && (
          <span className="text-xs text-slate-500">
            {rate.toFixed(3).replace(/\.?0+$/, '')} % → {money(taxCad, currency)} de taxe, {money(total - taxCad, currency)} au compte
          </span>
        )}
      </label>

      <label className="block">
        <span className="text-xs text-slate-500">Mémo</span>
        <input className="w-full border border-slate-300 rounded-lg px-2 py-1 text-sm"
          value={form.memo} onChange={(e) => set('memo')(e.target.value)} />
      </label>

      {h && (() => {
        // Deux choses valent un avertissement : un historique qui se contredit,
        // et une proposition (venue du profil fournisseur) qui contredit ce
        // qu'on a réellement publié les fois précédentes.
        const usualAccount = h.expense_accounts[0]?.value || null
        const usualTax = h.tax_codes[0]?.value || null
        const offAccount = usualAccount && form.expense_account_id && String(form.expense_account_id) !== String(usualAccount)
        // Les achats publiés ne portent presque jamais de code de taxe (QuickBooks
        // la calcule alors lui-même) : proposer un code là où l'historique n'en
        // avait aucun n'est pas une contradiction, c'est une amélioration. On
        // n'avertit que si l'habitude était un code PRÉCIS, et un autre.
        const offTax = usualTax && usualTax !== NO_TAX && String(form.tax_code_id || NO_TAX) !== String(usualTax)
        const warn = !h.consistent || offAccount || offTax
        return (
          <div className={`rounded-lg px-2.5 py-1.5 text-xs space-y-0.5 ${warn ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-500'}`}>
            {h.consistent ? (
              <div>Les {h.count} dernières fois : {accountName(usualAccount)} · taxe {taxName(usualTax)}</div>
            ) : (
              <div>
                Sur {h.count} achats : {h.expense_accounts.map((e) => `${accountName(e.value)} ×${e.n}`).join(', ')}
                {h.tax_codes.length > 1 && <> — taxe : {h.tax_codes.map((t) => `${taxName(t.value)} ×${t.n}`).join(', ')}</>}
              </div>
            )}
            {offAccount && <div>Le compte proposé n'est pas celui de l'habitude ({accountName(usualAccount)}).</div>}
            {offTax && <div>La taxe proposée n'est pas celle de l'habitude ({taxName(usualTax)}).</div>}
          </div>
        )
      })()}

      {error && <div className="text-xs text-red-600">{error}</div>}

      <div className="flex gap-2">
        <button type="button" className="px-3 py-1.5 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
          disabled={busy || !form.vendor || !form.expense_account_id} onClick={submit}>
          {busy ? 'Publication…' : 'Ajouter et publier'}
        </button>
        <button type="button" className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </div>
  )
}

// ── « Transfert » : les deux moitiés d'un mouvement interne ─────────────────
function TransferForm({ txn, currency, onDone, onCancel }) {
  const [candidates, setCandidates] = useState(null)
  const [pick, setPick] = useState(null)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)

  useEffect(() => {
    let alive = true
    api.bank.transferCandidates(txn.id)
      .then((c) => { if (alive) { setCandidates(c); setPick(c[0]?.id || null) } })
      .catch((e) => { if (alive) { setCandidates([]); setError(e.message) } })
    return () => { alive = false }
  }, [txn.id])

  const chosen = candidates?.find((c) => c.id === pick) || null

  const submit = async () => {
    setBusy(true); setError(null); setNote(null)
    try {
      const r = await api.bank.transfer(txn.id, {
        counterpart_txn_id: pick,
        amount: chosen?.fx ? Number(amount) : undefined,
      })
      invalidate('/bank')
      if (r.qbError) setError(`Virement lié, écriture QuickBooks refusée : ${r.qbError}`)
      else { setNote(r.skipped || r.fx_note || null); onDone() }
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="text-xs text-slate-500">
        Choisir la ligne de l'autre compte qui est l'autre moitié de ce mouvement.
      </div>
      {candidates == null && <div className="text-slate-400">Recherche…</div>}
      {candidates?.length === 0 && (
        <div className="text-slate-500">Aucune ligne de sens opposé au même montant dans un autre compte, à ±5 jours.</div>
      )}
      <div className="space-y-1">
        {candidates?.map((c) => (
          <button key={c.id} type="button" onClick={() => setPick(c.id)}
            className={`w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left border transition-colors ${pick === c.id
              ? 'border-brand-400 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
            <span className="min-w-0 grow">
              <span className="block truncate font-medium text-slate-800">{c.account_name}</span>
              <span className="block truncate text-xs text-slate-500">{fmtDate(c.txn_date)} · {c.label}</span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block tabular-nums">{money(c.amount, c.currency)}</span>
              {c.fx && <span className="block text-xs text-amber-600">change ~{c.rate}</span>}
            </span>
          </button>
        ))}
      </div>
      {chosen?.fx && (
        <label className="block">
          <span className="text-xs text-slate-500">Montant transféré ({currency})</span>
          <input type="number" step="0.01" className="w-full border border-slate-300 rounded-lg px-2 py-1 text-sm"
            value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={Math.abs(txn.amount).toFixed(2)} />
        </label>
      )}
      {note && <div className="text-xs text-amber-700">{note}</div>}
      {error && <div className="text-xs text-red-600">{error}</div>}
      <div className="flex gap-2">
        <button type="button" className="px-3 py-1.5 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
          disabled={busy || !pick || (chosen?.fx && !(Number(amount) > 0))} onClick={submit}>
          {busy ? 'Liaison…' : 'Lier et publier'}
        </button>
        <button type="button" className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </div>
  )
}

// ── Drawer latéral : détail + suggestions de matching ────────────────────────
function TxnPeek({ txn, currency, onChanged, initialMode = null }) {
  // Le panneau porte les deux gestes qui demandent un formulaire : comptabiliser
  // sans facture, et apparier un virement. Les boutons de la ligne ouvrent le
  // panneau DÉJÀ dans le bon mode : `initialMode` n'est lu qu'au montage, la
  // remise à zéro se fait quand on passe à UNE AUTRE ligne.
  const [mode, setMode] = useState(initialMode || null)
  const [suggestions, setSuggestions] = useState(null)
  const [busy, setBusy] = useState(false)
  const [comment, setComment] = useState(txn.comment || '')
  const [pushError, setPushError] = useState(null)
  // Besoin de collecte : y a-t-il un portail fournisseur à interroger pour cette
  // ligne ? null = pas encore chargé, false = aucun collecteur.
  const [need, setNeed] = useState(null)
  const [collecting, setCollecting] = useState(false)
  // La ligne change dans le panneau (navigation ↑↓) : on repart de la vue
  // habituelle plutôt que de garder le formulaire de la ligne précédente.
  const modeSeededFor = useRef(txn.id)
  useEffect(() => {
    if (modeSeededFor.current !== txn.id) { modeSeededFor.current = txn.id; setMode(null) }
  }, [txn.id])

  useEffect(() => {
    setComment(txn.comment || '')
    setSuggestions(null)
    setPushError(null)
    setNeed(null)
    if (!txn.matched_id) {
      api.bank.suggestions(txn.id).then(setSuggestions).catch(() => setSuggestions([]))
      api.scrapers.needForTransaction(txn.id).then(n => setNeed(n || false)).catch(() => setNeed(false))
    }
  }, [txn.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const collectInvoice = async () => {
    setCollecting(true)
    try {
      await api.scrapers.collectForTransaction(txn.id)
      setPushError(null)
    } catch (e) {
      setPushError(e.message)
    } finally { setCollecting(false) }
  }

  const act = async (fn) => {
    setBusy(true)
    try { await fn(); await onChanged() } finally { setBusy(false) }
  }
  const pushToQb = async () => {
    setBusy(true); setPushError(null)
    try {
      await api.achatsFournisseurs.pushToQb(txn.matched_id)
      // La mutation invalide le cache de /achats-fournisseurs (voir api.js),
      // pas celui du tableau de rapprochement — sans ce coup de pouce, le lien
      // « Ouvrir dans QuickBooks » ne serait visible qu'après le TTL du cache
      // de requêtes (30 s, voir lib/prefetch.js).
      invalidate('/bank')
      await onChanged()
    }
    catch (e) { setPushError(e.message) }
    finally { setBusy(false) }
  }
  const saveComment = () => {
    if ((txn.comment || '') === comment) return
    api.bank.updateTransaction(txn.id, { comment: comment || null }).then(onChanged).catch(() => {})
  }

  const meta = STATUS_META[txn.status] || STATUS_META.a_traiter
  const done = async () => { setMode(null); await onChanged() }

  if (mode === 'add') {
    return (
      <div className="p-4">
        <div className="font-medium text-slate-900 mb-2">{txnLabel(txn)}</div>
        <AddExpenseForm txn={txn} currency={currency} onDone={done} onCancel={() => setMode(null)} />
      </div>
    )
  }
  if (mode === 'transfer') {
    return (
      <div className="p-4">
        <div className="font-medium text-slate-900 mb-2">{txnLabel(txn)}</div>
        <TransferForm txn={txn} currency={currency} onDone={done} onCancel={() => setMode(null)} />
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4 text-sm">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Badge color={meta.color}>{meta.label}</Badge>
          {SHEET_COLOR_META[txn.sheet_color] && (
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <span className={`h-2 w-2 rounded-full ${SHEET_COLOR_META[txn.sheet_color].dot}`} />
              {SHEET_COLOR_META[txn.sheet_color].label.replace('Fichier : ', '')}
            </span>
          )}
          <span className="text-slate-500">{fmtDate(txn.txn_date)}</span>
        </div>
        <div className="font-medium text-slate-900">{txnLabel(txn)}</div>
        {txnSubLabel(txn) && <div className="text-xs text-slate-500">{txnSubLabel(txn)}</div>}
        <div className={`text-lg font-semibold ${txn.amount < 0 ? 'text-red-700' : 'text-green-700'}`}>{money(txn.amount, currency)}</div>
        {txn.reference && <div className="text-slate-500 font-mono text-xs">Réf. {txn.reference}</div>}
        <div className="text-xs text-slate-500">{meta.hint}</div>
        {txn.qb_match_method && (
          <div className="text-xs text-slate-500">
            Écriture QuickBooks retrouvée par {MATCH_METHOD[txn.qb_match_method] || txn.qb_match_method}
            {txn.qb_match_rate ? ` au taux ${txn.qb_match_rate}` : ''}
            {txn.qb_match_account ? ` — comptabilisée sur ${txn.qb_match_account}` : ''}
            {txn.qb_match_delta ? ` — écart de ${money(txn.qb_match_delta, currency)}` : ''}
          </div>
        )}
        {txn.qb_url && !txn.matched_id && (
          <a href={txn.qb_url} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
            <ExternalLink size={12} /> Ouvrir dans QuickBooks
          </a>
        )}
      </div>

      {txn.transfer_txn_id ? (
        <div className="bg-slate-50 rounded-lg p-3 space-y-2">
          <div className="text-xs font-medium text-slate-500 uppercase">Virement interne</div>
          <div>{txn.matched_label || 'Virement'}</div>
          <div className="flex items-center gap-3">
            {txn.qb_url && (
              <a href={txn.qb_url} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
                <ExternalLink size={12} /> Ouvrir dans QuickBooks
              </a>
            )}
            <button className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline disabled:opacity-50" disabled={busy}
              onClick={() => act(() => api.bank.unlinkTransfer(txn.id))}>
              <Unlink size={12} /> Défaire le virement
            </button>
          </div>
          {txn.qb_txn_id && <div className="text-xs text-slate-400">L'écriture QuickBooks reste : l'annuler dans QuickBooks si besoin.</div>}
        </div>
      ) : txn.matched_id ? (
        <div className="bg-slate-50 rounded-lg p-3 space-y-2">
          <div className="text-xs font-medium text-slate-500 uppercase">Document apparié</div>
          <div>{docLink(txn.matched_type, txn.matched_id, txn.matched_label)}
            {txn.match_method === 'auto' && txn.match_confidence != null && (
              <span className="text-xs text-slate-400 ml-2">auto · {Math.round(txn.match_confidence * 100)} %</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {txn.qb_url ? (
              <a href={txn.qb_url} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
                <ExternalLink size={12} /> Ouvrir dans QuickBooks
              </a>
            ) : txn.matched_type === 'achat' && (
              <button className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50" disabled={busy}
                onClick={pushToQb}>
                <BookOpen size={12} /> {busy ? 'Comptabilisation…' : 'Comptabiliser sur QuickBooks'}
              </button>
            )}
            <button className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline disabled:opacity-50" disabled={busy}
              onClick={() => act(() => api.bank.match(txn.id, { matched_type: null, matched_id: null }))}>
              <Unlink size={12} /> Délier
            </button>
          </div>
          {pushError && <div className="text-xs text-red-600">{pushError}</div>}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-500 uppercase">Suggestions</div>
          {suggestions == null && <div className="text-slate-400">Recherche…</div>}
          {suggestions?.length === 0 && (
            <div className="text-slate-500">Aucun document au même montant à ±7 jours — probablement une <strong>facture manquante</strong>.</div>
          )}
          {need && need.scraper_account_id && need.account_enabled ? (
            <div className="flex items-center gap-2 bg-brand-50 border border-brand-200 rounded-lg p-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-slate-700">
                  {need.vendor_name} a un portail branché — la facture peut être récupérée automatiquement.
                </div>
                {need.note && <div className="text-[11px] text-slate-500 truncate">Dernière tentative : {need.note}</div>}
              </div>
              <button className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
                disabled={collecting} onClick={collectInvoice}>
                <Download size={12} /> {collecting ? 'Lancement…' : 'Chercher la facture'}
              </button>
            </div>
          ) : need && need.vendor_name ? (
            <div className="text-xs text-slate-500">
              Fournisseur reconnu ({need.vendor_name}), mais aucun portail n'est branché pour lui.
            </div>
          ) : null}
          {suggestions?.map((s) => (
            <div key={`${s.type}:${s.id}`} className="flex items-center justify-between gap-2 bg-slate-50 rounded-lg p-2">
              <div className="min-w-0">
                <div className="truncate">{docLink(s.type, s.id, s.label)}</div>
                <div className="text-xs text-slate-500">{fmtDate(s.date)} · {money(s.total, currency)} · {Math.round(s.confidence * 100)} %{s.quickbooks_id ? ' · publié QB' : ''}</div>
              </div>
              <button className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50" disabled={busy}
                onClick={() => act(() => api.bank.match(txn.id, { matched_type: s.type, matched_id: s.id }))}>
                <Link2 size={12} /> Lier
              </button>
            </div>
          ))}
        </div>
      )}

      {!txn.matched_id && !txn.transfer_txn_id && txn.status !== 'ignore' && (
        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
          {txn.amount < 0 && (
            <button className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-slate-300 hover:bg-slate-50"
              title="Comptabiliser cette ligne sans facture" onClick={() => setMode('add')}>
              <Plus size={12} /> Ajouter
            </button>
          )}
          <button className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-slate-300 hover:bg-slate-50"
            title="Apparier à la ligne miroir d'un autre compte" onClick={() => setMode('transfer')}>
            <ArrowLeftRight size={12} /> Transfert
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {txn.status !== 'rapproche' && txn.status !== 'ignore' && (
          <button className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50" disabled={busy}
            onClick={() => act(() => api.bank.reconcile([txn.id]))}>
            <CheckCheck size={12} /> Marquer rapproché
          </button>
        )}
        {txn.status === 'rapproche' && (
          <button className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50" disabled={busy}
            onClick={() => act(() => api.bank.reconcile([txn.id], true))}>
            <Undo2 size={12} /> Annuler le rapprochement
          </button>
        )}
        {txn.status !== 'ignore' ? (
          <button className="text-xs px-2 py-1 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50" disabled={busy}
            onClick={() => act(() => api.bank.updateTransaction(txn.id, { status: 'ignore' }))}>
            Ignorer
          </button>
        ) : (
          <button className="text-xs px-2 py-1 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50" disabled={busy}
            onClick={() => act(() => api.bank.updateTransaction(txn.id, { status: 'a_traiter' }))}>
            Ré-activer
          </button>
        )}
      </div>

      <div>
        <div className="text-xs font-medium text-slate-500 uppercase mb-1">Commentaire</div>
        <textarea className="w-full border border-slate-300 rounded-lg p-2 text-sm" rows={2}
          value={comment} onChange={(e) => setComment(e.target.value)} onBlur={saveComment} />
      </div>
    </div>
  )
}

// Écriture QuickBooks sans ligne au relevé : rien à modifier ici, seulement à
// constater et à aller corriger dans QuickBooks.
function GhostPeek({ row, currency }) {
  return (
    <div className="p-4 space-y-3 text-sm">
      <div className="text-slate-600">
        Cette écriture existe dans QuickBooks mais aucune ligne du relevé ne lui correspond.
      </div>
      <div className="rounded-lg bg-slate-50 p-3 space-y-1">
        <div className="font-medium text-slate-900">{row.label}</div>
        <div className="text-slate-500">{fmtDate(row.txn_date)}</div>
        <div className={`text-lg font-semibold ${row.amount < 0 ? 'text-red-700' : 'text-green-700'}`}>{money(row.amount, currency)}</div>
      </div>
      <div className="text-xs text-slate-500">
        Soit le relevé n'a pas encore été importé jusqu'à cette date, soit l'écriture est en trop dans QuickBooks.
      </div>
      {row.qb_url && (
        <a href={row.qb_url} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
          <ExternalLink size={12} /> Ouvrir dans QuickBooks
        </a>
      )}
    </div>
  )
}

// ── Rapprochement : état et actions ─────────────────────────────────────────
//
// L'équivalent de l'écran « Rapprocher » de QuickBooks : le solde du compte est
// recalculé à partir du relevé importé, comparé au solde QuickBooks à la même
// date. Le hook porte l'état ; l'écart s'affiche sur une ligne (EcartBar) et
// les transactions fautives sont signalées DANS le tableau, pas dans des
// sections repliables au-dessus de lui.

function useReconcile(account, refreshKey, onChanged) {
  const [summary, setSummary] = useState(null)
  const [qb, setQb] = useState(null)
  const [qbLoading, setQbLoading] = useState(false)
  const [qbError, setQbError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [qbAuditBusy, setQbAuditBusy] = useState(false)
  const [qbAuditMsg, setQbAuditMsg] = useState(null)

  const accountId = account?.id

  useEffect(() => {
    if (!accountId) { setSummary(null); return }
    let alive = true
    api.bank.summary(accountId).then((s) => { if (alive) setSummary(s) }).catch(() => { if (alive) setSummary(null) })
    return () => { alive = false }
  }, [accountId, refreshKey])

  // La comparaison QuickBooks tape sur l'API Intuit (quelques secondes) : elle
  // se charge d'elle-même à l'ouverture du compte, puis à la demande.
  const loadQb = useCallback(async () => {
    if (!accountId || !account?.qb_account_id) { setQb(null); return }
    setQbLoading(true); setQbError(null)
    try { setQb(await api.bank.qbCompare(accountId)) } catch (e) { setQbError(e.message); setQb(null) } finally { setQbLoading(false) }
  }, [accountId, account?.qb_account_id])

  useEffect(() => { setQb(null); setQbError(null); setQbAuditMsg(null); loadQb() }, [loadQb])

  const runAuto = async () => {
    setBusy(true)
    try {
      await api.bank.reconcileAuto(accountId)
      await onChanged()
      await loadQb()
    } finally { setBusy(false) }
  }

  // Compte Plaid : la vérité « comptabilisé dans QuickBooks » ne vient plus du
  // fichier TRX_Orisha (désactivé pour ces comptes) mais de cette recherche
  // approfondie — voir services/plaidQbAudit.js.
  const runQbAudit = async () => {
    setQbAuditBusy(true); setQbAuditMsg(null)
    try {
      const r = await api.bank.qbAudit(accountId)
      setQbAuditMsg(`${r.linked} lié(s) sur ${r.scanned} vérifiée(s)`)
      await onChanged()
    } catch (e) {
      setQbAuditMsg(`Échec : ${e.message}`)
    } finally { setQbAuditBusy(false) }
  }

  const onMerged = async () => { await onChanged() }

  return { summary, qb, qbLoading, qbError, loadQb, busy, runAuto, qbAuditBusy, qbAuditMsg, runQbAudit, onMerged }
}

// Une ligne, trois nombres : le solde du relevé, celui de QuickBooks, et
// l'écart entre les deux — c'est le seul chiffre qui commande une action.
function EcartBar({ account, rec }) {
  const { summary, qb, qbLoading, qbError, qbAuditMsg } = rec
  if (!account) return null
  const stmt = summary?.statement
  const bal = qb?.balance && !qb.balance.error ? qb.balance : null
  const diff = bal?.difference
  const ok = diff != null && Math.abs(diff) < 0.01
  const currency = account.currency

  return (
    <div data-testid="reconcile-panel" className="flex items-baseline gap-x-2 text-sm min-w-0">
      <span className="text-slate-500">Écart</span>
      <span data-testid="reconcile-difference"
        className={`text-lg font-semibold tabular-nums ${diff == null ? 'text-slate-300' : ok ? 'text-green-700' : 'text-red-700'}`}>
        {qbLoading ? '…' : diff == null ? '—' : money(diff, currency)}
      </span>
      <span className="text-xs text-slate-400 truncate"
        title={[
          stmt?.date ? `Soldes au ${fmtDate(stmt.date)}` : null,
          bal && Math.abs(bal.qb_current - bal.qb_as_of) >= 0.01 ? `Solde QuickBooks aujourd'hui : ${money(bal.qb_current, currency)}` : null,
        ].filter(Boolean).join(' — ') || undefined}>
        <span data-testid="reconcile-statement-balance">
          relevé {stmt?.balance_signed != null ? money(stmt.balance_signed, currency) : '—'}
        </span>
        {' · '}
        <span data-testid="reconcile-qb-balance">
          QB {bal ? money(bal.qb_as_of, currency) : account.qb_account_id ? '—' : 'non mappé'}
        </span>
      </span>
      {qbError && <span className="text-xs text-amber-700">QuickBooks indisponible : {qbError}</span>}
      {qbAuditMsg && <span className="text-xs text-slate-400">{qbAuditMsg}</span>}
      <PlaidDuplicates account={account} rec={rec} />
    </div>
  )
}

// Doublons hérités du fichier TRX_Orisha, sur un compte qui reçoit maintenant
// ses transactions de la banque : chaque mouvement y figure deux fois, une
// fois par source, avec des clés de dédup étrangères l'une à l'autre. La
// fusion garde la ligne de la banque en lui donnant ce que portait celle du
// fichier (statut, lien QuickBooks, commentaire). Rien ne s'affiche quand il
// n'y en a pas.
function PlaidDuplicates({ account, rec }) {
  const { summary, onMerged } = rec
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  const n = summary?.plaid_duplicates || 0
  if (!account?.plaid_account_id || (!n && !done)) return null

  const merge = async () => {
    setBusy(true)
    try {
      const r = await api.bank.mergePlaidDuplicates(account.id, false)
      setDone(r.merged)
      await onMerged?.()
    } finally { setBusy(false) }
  }

  if (done != null) return <span className="text-xs text-slate-400">{done} doublon(s) fusionné(s)</span>
  return (
    <button type="button" onClick={merge} disabled={busy} data-testid="plaid-duplicates-merge"
      title="Ces mouvements figurent deux fois : une ligne de la banque et une du fichier TRX_Orisha. La fusion garde celle de la banque."
      className="text-xs text-amber-700 bg-amber-50 hover:bg-amber-100 px-2 py-0.5 rounded-full whitespace-nowrap disabled:opacity-50">
      {busy ? 'Fusion…' : `${n} en double · fusionner`}
    </button>
  )
}

// ── Sync automatique du fichier TRX_Orisha (Drive) ───────────────────────────

const ANOMALY_KIND = {
  comptabilisee_introuvable: { label: 'Déclarée comptabilisée, introuvable dans QuickBooks', color: 'red' },
  doublon_releve: { label: 'Probablement saisie deux fois', color: 'orange' },
  qb_sans_releve: { label: 'Compensée dans QuickBooks, absente du relevé', color: 'orange' },
}

// Couleur peinte à la main dans TRX_Orisha : c'est l'affirmation de Michel sur
// ce qui est comptabilisé. L'ERP la conserve telle quelle et la confronte au
// grand livre plutôt que de la deviner.
const SHEET_COLOR_META = {
  vert: { dot: 'bg-green-500', label: 'Fichier : rapprochée avec la banque' },
  jaune: { dot: 'bg-yellow-400', label: 'Fichier : comptabilisée' },
  bleu: { dot: 'bg-sky-400', label: 'Fichier : facture retracée' },
  rouge: { dot: 'bg-red-300', label: 'Fichier : pas encore comptabilisée' },
}

// Comment l'écriture QuickBooks a été retrouvée (services/bankQbSearch.js).
const MATCH_METHOD = {
  exact: 'montant et date exacts',
  fenetre: 'même montant, date décalée',
  devise: 'montant en devise du compte',
  tolerance: 'montant proche (frais ou conversion)',
  conversion: 'conversion de devise (taux vérifié)',
  autre_compte: 'écriture portée à un autre compte',
  agregat: 'plusieurs écritures QuickBooks',
  agregat_inverse: 'écriture QuickBooks partagée avec d\'autres lignes',
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('fr-CA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// État + actions de la sync TRX_Orisha, partagés entre l'icône du header
// (TrxSheetIndicator) et le panneau détaillé repliable (TrxSheetPanel) — un
// seul chargement de statut pour les deux.
function useTrxSheetStatus(onSynced) {
  const [status, setStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    api.bank.trxSheetStatus().then(setStatus).catch(() => setStatus(null))
  }, [])
  useEffect(() => { load() }, [load])

  const runSync = async () => {
    setSyncing(true); setError(null)
    try {
      await api.bank.trxSheetSync()
      load()
      await onSynced()
    } catch (e) { setError(e.message) } finally { setSyncing(false) }
  }

  const last = status?.last_run
  return {
    status, syncing, error, runSync, last,
    anomalies: last?.anomalies || [],
    toBook: last?.to_book || [],
    gaps: last?.gaps || [],
  }
}

// Icône discrète dans le header — remplace l'ancien bandeau plein-largeur
// permanent. Silencieuse quand tout est à jour, se transforme en pill visible
// seulement quand il y a des anomalies à signaler.
function TrxSheetIndicator({ trx, open, onToggle }) {
  if (!trx.status) return null
  if (trx.anomalies.length > 0) {
    return (
      <button type="button" onClick={onToggle} data-testid="trx-sheet-indicator"
        title="TRX_Orisha : anomalies détectées — cliquer pour voir le détail"
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${open
          ? 'bg-amber-100 border-amber-300 text-amber-900'
          : 'bg-amber-50 border-amber-200 text-amber-800 hover:bg-amber-100'}`}>
        <AlertTriangle size={13} />
        {trx.anomalies.length} anomalie{trx.anomalies.length > 1 ? 's' : ''}
      </button>
    )
  }
  return (
    <button type="button" onClick={onToggle} data-testid="trx-sheet-indicator"
      title="Fichier TRX_Orisha (Drive) — sync auto aux 20 min, cliquer pour le détail"
      className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border transition-colors ${open
        ? 'bg-slate-100 border-slate-300 text-slate-700'
        : 'border-slate-300 text-slate-400 hover:bg-slate-50 hover:text-slate-600'}`}>
      {trx.syncing ? <RefreshCw size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />}
    </button>
  )
}

// Panneau détaillé — replié par défaut, ouvert via TrxSheetIndicator (ou
// auto-ouvert une fois s'il y a des anomalies). Contenu inchangé par rapport
// à l'ancien bandeau : dernier passage, 3 sous-panneaux, sync manuelle.
function TrxSheetPanel({ trx, onGoToAccount }) {
  const { status, syncing, error, runSync, last, anomalies, toBook, gaps } = trx
  const [showAnomalies, setShowAnomalies] = useState(null)
  if (!status) return null

  // Un panneau à la fois : anomalies (contradictions), à comptabiliser (travail
  // en cours, jamais alerté) et appariements avec écart (frais, conversions).
  const panel = (key) => () => setShowAnomalies((v) => (v === key ? null : key))
  const line = (a, extra) => (
    <div className="min-w-0">
      <button type="button" className="text-left hover:underline" title="Ouvrir ce compte"
        onClick={() => onGoToAccount(a.account_id)}>
        <span className="font-medium">{a.account_name}</span>
        <span className="text-slate-500"> · {fmtDate(a.date)} · </span>
        <span className={a.amount < 0 ? 'text-red-700' : 'text-green-700'}>{money(a.amount)}</span>
        <span className="text-slate-700"> · {a.label}</span>
      </button>
      {extra}
    </div>
  )

  return (
    <div data-testid="trx-sheet-banner"
      className={`mb-3 rounded-xl border px-4 py-3 ${anomalies.length ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <span className="inline-flex items-center gap-1.5 font-medium text-slate-700"
          title={`${status.active ? 'Sync auto aux 20 min' : 'Automation désactivée'} — ${last
            ? `dernier passage ${fmtDateTime(last.executed_at)} : ${last.status === 'success' ? last.summary : `échec (${last.error})`}`
            : 'jamais synchronisé'}`}>
          <FileSpreadsheet size={13} className="text-green-700" /> TRX_Orisha
        </span>
        {last?.status === 'error' && <span className="text-red-600">échec de la dernière sync : {last.error}</span>}
        <span className="grow" />
        {anomalies.length > 0 && (
          <button type="button"
            className="inline-flex items-center gap-1 text-amber-800 hover:text-amber-900 font-medium"
            onClick={panel('anomalies')}>
            <AlertTriangle size={14} />
            {anomalies.length} anomalie{anomalies.length > 1 ? 's' : ''}
            <ChevronRight size={14} className={`transition-transform ${showAnomalies === 'anomalies' ? 'rotate-90' : ''}`} />
          </button>
        )}
        {toBook.length > 0 && (
          <button type="button"
            className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900"
            title="Lignes pas encore comptabilisées d'après la couleur du fichier — état de travail normal, jamais alerté"
            onClick={panel('to_book')}>
            <BookOpen size={14} />
            {toBook.length} à comptabiliser
            <ChevronRight size={14} className={`transition-transform ${showAnomalies === 'to_book' ? 'rotate-90' : ''}`} />
          </button>
        )}
        {gaps.length > 0 && (
          <button type="button"
            className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900"
            title="Appariées à QuickBooks malgré un écart de montant (frais bancaires, conversion de devise)"
            onClick={panel('gaps')}>
            <Link2 size={14} />
            {gaps.length} avec écart
            <ChevronRight size={14} className={`transition-transform ${showAnomalies === 'gaps' ? 'rotate-90' : ''}`} />
          </button>
        )}
        <button type="button"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50"
          disabled={syncing} onClick={runSync}>
          <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Synchronisation…' : 'Synchroniser maintenant'}
        </button>
      </div>
      {error && <div className="mt-2 text-sm text-red-600">Sync échouée : {error}</div>}
      {showAnomalies === 'anomalies' && (
        <div className="mt-3 space-y-1.5 max-h-80 overflow-auto pr-1">
          {anomalies.map((a) => {
            const kind = ANOMALY_KIND[a.kind] || { label: a.kind, color: 'gray' }
            return (
              <div key={a.key} className="flex items-start gap-2 rounded-lg bg-white/70 border border-amber-200 px-2.5 py-1.5 text-sm">
                <Badge color={kind.color} size="xs">{kind.label}</Badge>
                {line(a, <div className="text-xs text-slate-500">↳ {a.explanation}</div>)}
              </div>
            )
          })}
        </div>
      )}
      {showAnomalies === 'to_book' && (
        <div className="mt-3 space-y-1.5 max-h-80 overflow-auto pr-1">
          <div className="text-xs text-slate-500">
            Pas des anomalies : ces lignes ne sont simplement pas encore comptabilisées d'après la couleur du fichier.
          </div>
          {toBook.map((a) => (
            <div key={a.key} className="flex items-start gap-2 rounded-lg bg-white/70 border border-slate-200 px-2.5 py-1.5 text-sm">
              <Badge color={a.sheet_color === 'bleu' ? 'blue' : 'gray'} size="xs">{a.age_days} j</Badge>
              {line(a, <div className="text-xs text-slate-500">↳ {a.explanation}</div>)}
            </div>
          ))}
        </div>
      )}
      {showAnomalies === 'gaps' && (
        <div className="mt-3 space-y-1.5 max-h-80 overflow-auto pr-1">
          {gaps.map((g) => (
            <div key={`${g.txn_id || g.date}-${g.qb_id}`} className="flex items-start gap-2 rounded-lg bg-white/70 border border-slate-200 px-2.5 py-1.5 text-sm">
              <Badge color="gray" size="xs">{g.method_label}</Badge>
              {line(g, (
                <div className="text-xs text-slate-500">
                  ↳ QuickBooks : {fmtDate(g.qb_date)}{g.qb_name ? ` · ${g.qb_name}` : ''} · écart {money(g.delta)}
                  {g.rate ? ` · taux ${g.rate}` : ''}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

// Trois files, comme « Opérations bancaires » de QuickBooks : ce qui demande
// encore un geste, ce qui est classé, ce qu'on a mis de côté.
const TABS = [
  { key: 'review', label: 'À réviser', statuses: ['a_traiter', 'facture_recue'] },
  { key: 'done', label: 'Catégorisées', statuses: ['comptabilise', 'rapproche'] },
  { key: 'excluded', label: 'Exclues', statuses: ['ignore'] },
]
const TAB_OF_STATUS = Object.fromEntries(TABS.flatMap((t) => t.statuses.map((st) => [st, t.key])))

// Onglet : soulignement fin, pas de pastille pleine — la barre de comptes et
// la barre de files se lisent comme les onglets d'un classeur.
function Tab({ active, onClick, title, children }) {
  return (
    <button type="button" onClick={onClick} title={title}
      className={`-mb-px border-b-2 px-2 py-1.5 text-sm whitespace-nowrap transition-colors ${active
        ? 'border-brand-500 text-slate-900 font-medium'
        : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
      {children}
    </button>
  )
}

export default function RapprochementBancaire() {
  const [accounts, setAccounts] = useState([])
  const [accountId, setAccountIdRaw] = useState(null)
  // Compte reflété dans l'URL (?compte=) : le sous-menu de la sidebar peut
  // ouvrir un compte précis, et le lien reste partageable.
  const [params, setParams] = useSearchParams()
  const askedAccount = params.get('compte')
  const setAccountId = useCallback((next) => {
    setAccountIdRaw(prev => {
      const id = typeof next === 'function' ? next(prev) : next
      if (id) setParams({ compte: id }, { replace: true })
      return id
    })
  }, [setParams])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [showImport, setShowImport] = useState(false)
  const [notice, setNotice] = useState(null)
  const [tab, setTab] = useState('review')

  const account = accounts.find((a) => a.id === accountId) || null

  const loadAccounts = useCallback(async () => {
    const list = await api.bank.accounts()
    setAccounts(list)
    // Au chargement : le compte demandé dans l'URL gagne, sinon on garde le
    // courant, sinon le premier. On passe par le setter brut pour ne pas
    // réécrire l'URL quand personne n'a rien demandé.
    setAccountIdRaw((prev) => {
      const wanted = new URLSearchParams(window.location.search).get('compte')
      if (wanted && list.some((a) => a.id === wanted)) return wanted
      return prev && list.some((a) => a.id === prev) ? prev : (list[0]?.id || null)
    })
  }, [])

  const loadTxns = useCallback(async () => {
    if (!accountId) { setRows([]); setLoading(false); return }
    setLoading(true)
    try { setRows(await api.bank.transactions(accountId)) } finally { setLoading(false) }
  }, [accountId])

  useEffect(() => { loadAccounts() }, [loadAccounts])
  // URL → état : clic dans le sous-menu alors que la page est déjà ouverte.
  useEffect(() => {
    if (askedAccount && askedAccount !== accountId && accounts.some((a) => a.id === askedAccount)) {
      setAccountIdRaw(askedAccount)
    }
  }, [askedAccount, accounts, accountId])
  useEffect(() => { loadTxns() }, [loadTxns])
  useEffect(() => { setTab('review') }, [accountId])

  // Incrémenté à chaque refresh : le résumé local se recalcule (la comparaison
  // QuickBooks, elle, reste à la demande).
  const [reconcileKey, setReconcileKey] = useState(0)
  const refresh = useCallback(async () => {
    await Promise.all([loadTxns(), loadAccounts()])
    setReconcileKey((k) => k + 1)
  }, [loadTxns, loadAccounts])

  const rec = useReconcile(account, reconcileKey, refresh)

  // Ouverture du panneau depuis un bouton de ligne : quelle ligne, dans quel
  // mode. `null` = le panneau s'ouvre sur sa vue habituelle.
  const [peekOpen, setPeekOpen] = useState({ id: null, mode: null, forId: null })

  // Sync TRX_Orisha : icône discrète dans le header (TrxSheetIndicator),
  // panneau replié par défaut sous les onglets de comptes (TrxSheetPanel) —
  // auto-ouvert une seule fois si des anomalies apparaissent.
  const trx = useTrxSheetStatus(refresh)
  const [trxOpen, setTrxOpen] = useState(false)
  const trxAutoOpenedRef = useRef(false)
  useEffect(() => {
    if (trx.anomalies.length > 0 && !trxAutoOpenedRef.current) {
      trxAutoOpenedRef.current = true
      setTrxOpen(true)
    }
  }, [trx.anomalies.length])

  // Ce qui cloche sur une ligne, dit sur la ligne elle-même plutôt que dans une
  // section repliée au-dessus du tableau : solde qui ne suit pas, doublon,
  // absence d'écriture QuickBooks.
  const flags = useMemo(() => {
    const m = new Map()
    for (const a of rec.summary?.anomalies || []) if (a.txn_id && !m.has(a.txn_id)) m.set(a.txn_id, a.explanation)
    for (const g of rec.qb?.missing_in_qb || []) if (g.txn_id && !m.has(g.txn_id)) m.set(g.txn_id, 'Aucune écriture correspondante dans QuickBooks')
    return m
  }, [rec.summary, rec.qb])

  // Écritures QuickBooks sans ligne au relevé : des lignes fantômes glissées à
  // leur date, comme une ligne à compléter dans un tableur. Elles ne sont pas
  // dans la base — juste montrées là où elles manquent.
  const ghosts = useMemo(() => (rec.qb?.missing_in_statement || []).map((g) => ({
    id: `qb:${g.entity}:${g.qb_id}`,
    _ghost: true,
    txn_date: g.date,
    amount: g.amount,
    label: `${g.entity} #${g.qb_id}`,
    details: `${g.entity} #${g.qb_id}`,
    status: 'comptabilise',
    qb_url: g.url,
  })), [rec.qb])

  // Débit / crédit : deux colonnes séparées comme sur un relevé. `amount` reste
  // la valeur signée en base (tri, recherche, filtres).
  const decorated = useMemo(() => rows.map((r) => ({
    ...r,
    debit: r.amount < 0 ? -r.amount : null,
    credit: r.amount > 0 ? r.amount : null,
    _flag: flags.get(r.id) || null,
  })), [rows, flags])

  const counts = useMemo(() => {
    const c = { review: 0, done: 0, excluded: 0 }
    for (const r of rows) { const k = TAB_OF_STATUS[r.status]; if (k) c[k] += 1 }
    c.review += ghosts.length
    return c
  }, [rows, ghosts])

  const tabRows = useMemo(() => {
    const wanted = new Set(TABS.find((t) => t.key === tab)?.statuses || [])
    const kept = decorated.filter((r) => wanted.has(r.status))
    // Les fantômes n'existent qu'à réviser : c'est là qu'ils demandent un geste.
    if (tab !== 'review' || ghosts.length === 0) return kept
    return [...kept, ...ghosts].sort((a, b) => (a.txn_date < b.txn_date ? 1 : a.txn_date > b.txn_date ? -1 : 0))
  }, [decorated, ghosts, tab])

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(null), 6000) }

  const currency = account?.currency

  const COLUMNS = useMemo(() => {
    const num = (v, cls = '') => v == null
      ? <span className="block text-right text-slate-200">·</span>
      : <span className={`block text-right tabular-nums ${cls}`}>{money(v, currency)}</span>
    const RENDERS = {
      txn_date: (r) => (
        <span className="whitespace-nowrap text-slate-500 tabular-nums">
          {!!r.pending && <Clock size={11} className="inline mr-1 -mt-0.5 text-slate-400" title="En attente à la banque (pas encore posée)" />}
          {fmtDate(r.txn_date)}
        </span>
      ),
      // Une seule ligne : la description de la banque, souvent générique, part
      // en infobulle. Le ⚠ dit sur place ce qui cloche.
      description: (r) => (
        <span className={`block truncate ${r._ghost ? 'italic text-slate-400' : ''}`} title={txnSubLabel(r) || undefined}>
          {r._flag && <AlertTriangle size={12} className="inline mr-1 -mt-0.5 text-amber-500" title={r._flag} />}
          {r._ghost && <span className="text-slate-400">QuickBooks · </span>}
          {txnLabel(r)}
        </span>
      ),
      debit: (r) => num(r._ghost ? (r.amount < 0 ? -r.amount : null) : r.debit, 'text-slate-700'),
      credit: (r) => num(r._ghost ? (r.amount > 0 ? r.amount : null) : r.credit, 'text-green-700'),
      amount: (r) => num(r.amount, r.amount < 0 ? 'text-slate-700' : 'text-green-700'),
      balance: (r) => num(r.balance, 'text-slate-400'),
      // Le statut se lit à la couleur, comme les cases peintes du vieux fichier.
      status: (r) => {
        if (r._ghost) return <span className="block truncate rounded px-1.5 py-0.5 text-xs bg-slate-100 text-slate-500">Hors relevé</span>
        const m = STATUS_META[r.status] || STATUS_META.a_traiter
        return <span className={`block truncate rounded px-1.5 py-0.5 text-xs font-medium ${m.cell}`} title={m.hint}>{m.label}</span>
      },
      matched_label: (r) => (
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate">
            {r.matched_id ? docLink(r.matched_type, r.matched_id, r.matched_label) : <span className="text-slate-200">·</span>}
          </span>
          {r.qb_url && (
            <a href={r.qb_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
              title={r.qb_match_method
                ? `Ouvrir dans QuickBooks — retrouvée par ${MATCH_METHOD[r.qb_match_method] || r.qb_match_method}${r.qb_match_rate ? ` ${r.qb_match_rate}` : ''}${r.qb_match_account ? ` (${r.qb_match_account})` : ''}${r.qb_match_delta ? `, écart de ${r.qb_match_delta.toFixed(2)} $` : ''}`
                : 'Ouvrir dans QuickBooks'}
              className={`shrink-0 ${r.qb_match_delta ? 'text-amber-500' : 'text-slate-300'} hover:text-brand-600`}>
              <ExternalLink size={12} />
            </a>
          )}
        </span>
      ),
      match_confidence: (r) => r.match_confidence != null ? `${Math.round(r.match_confidence * 100)} %` : '—',
    }
    const cols = TABLE_COLUMN_META.bank_transactions.map((meta) => ({ ...meta, render: RENDERS[meta.id] }))
    // Les deux gestes de « Opérations bancaires », à portée de clic sur la
    // ligne : le panneau s'ouvre déjà dans le bon formulaire. Uniquement dans
    // la file à réviser — ailleurs, il n'y a plus rien à décider. En TÊTE de
    // ligne : en queue, la colonne sortait de l'écran dès que les colonnes
    // larges (libellé, document) prenaient toute la place.
    if (tab !== 'review') return cols
    const act = (e, r, mode) => { e.stopPropagation(); setPeekOpen({ id: r.id, mode, forId: r.id }) }
    const btn = 'p-1 rounded text-slate-400 hover:text-brand-600 hover:bg-white'
    return [{
      id: '_actions', label: '', width: 62, sortable: false, filterable: false, groupable: false,
      render: (r) => {
        if (r._ghost || r.matched_id || r.transfer_txn_id) return null
        return (
          <span className="flex items-center gap-0.5">
            {r.amount < 0 && (
              <button type="button" title="Ajouter — comptabiliser cette ligne sans facture"
                className={btn} onClick={(e) => act(e, r, 'add')}><Plus size={14} /></button>
            )}
            <button type="button" title="Transfert — apparier à la ligne miroir d'un autre compte"
              className={btn} onClick={(e) => act(e, r, 'transfer')}><ArrowLeftRight size={13} /></button>
          </span>
        )
      },
    }, ...cols]
  }, [currency, tab])

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-3">
          <PageTitle>Rapprochement bancaire</PageTitle>
          <div className="flex items-center gap-1.5">
            {!account?.plaid_account_id && (
              <TrxSheetIndicator trx={trx} open={trxOpen} onToggle={() => setTrxOpen((v) => !v)} />
            )}
            {/* Compte branché à Plaid : les transactions arrivent de la banque.
                Un collage y créerait un doublon par ligne (les deux sources ne
                partagent pas leur clé de dédup) — le bouton disparaît, comme
                l'indicateur TRX_Orisha juste au-dessus. */}
            {!account?.plaid_account_id && (
              <button type="button" title="Importer un relevé (collage)"
                className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50 hover:text-slate-700 disabled:opacity-50"
                disabled={!accountId} onClick={() => setShowImport(true)}>
                <Upload size={15} />
              </button>
            )}
            {!!account?.plaid_account_id && (
              <button type="button"
                className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50 hover:text-slate-700 disabled:opacity-50"
                title="Rechercher dans QuickBooks (recherche approfondie, tout l'historique) une écriture pour chaque transaction non rapprochée"
                disabled={rec.qbAuditBusy || !account.qb_account_id} onClick={rec.runQbAudit}>
                <SearchCheck size={15} className={rec.qbAuditBusy ? 'animate-pulse' : ''} />
              </button>
            )}
            <button type="button" title="Recalculer la comparaison QuickBooks"
              className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50 hover:text-slate-700 disabled:opacity-50"
              disabled={rec.qbLoading || !account?.qb_account_id} onClick={rec.loadQb}>
              <RefreshCw size={15} className={rec.qbLoading ? 'animate-spin' : ''} />
            </button>
            <button type="button" data-testid="reconcile-auto-btn"
              className="inline-flex items-center gap-1.5 px-3 h-8 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
              title="Apparier les transactions aux documents de l'ERP puis aux écritures QuickBooks"
              disabled={rec.busy || !accountId} onClick={rec.runAuto}>
              <Wand2 size={15} /> {rec.busy ? 'Rapprochement…' : 'Rapprocher'}
            </button>
          </div>
        </div>

        {/* Comptes — les onglets du vieux classeur */}
        <div className="flex flex-wrap items-center gap-x-3 border-b border-slate-200 mb-2">
          {accounts.map((a) => (
            <Tab key={a.id} active={a.id === accountId} onClick={() => setAccountId(a.id)}
              title={[a.institution, a.account_number, a.currency, a.last_txn_date && `dernière trx ${fmtDate(a.last_txn_date)}`]
                .filter(Boolean).join(' · ')}>
              {a.name}
              {a.a_traiter_count > 0 && <span className="ml-1.5 text-xs text-red-600 tabular-nums">{a.a_traiter_count}</span>}
            </Tab>
          ))}
        </div>

        {trxOpen && !account?.plaid_account_id && <TrxSheetPanel trx={trx} onGoToAccount={(id) => setAccountId(id)} />}

        {/* Files de travail à gauche, le seul chiffre qui compte à droite */}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-slate-200 mb-3">
          <div className="flex items-center gap-x-3">
            {TABS.map((t) => (
              <Tab key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>
                {t.label} <span className="text-xs text-slate-400 tabular-nums">{counts[t.key]}</span>
              </Tab>
            ))}
          </div>
          <div className="pb-1.5 min-w-0"><EcartBar account={account} rec={rec} /></div>
        </div>

        {notice && <div className="mb-3 text-sm bg-green-50 text-green-800 rounded-lg px-3 py-2">{notice}</div>}

        <DataTable
          table="bank_transactions"
          manageViews
          columns={COLUMNS}
          data={tabRows}
          loading={loading}
          rowKey="id"
          rowClassName={(r) => r._ghost ? 'bg-slate-50/70' : r._flag ? 'bg-amber-50/70' : ''}
          searchFields={['details', 'description', 'reference', 'amount', 'comment', 'matched_label']}
          bulkActions={[
            {
              key: 'reconcile', label: 'Marquer rapproché', icon: CheckCheck, busyLabel: 'Rapprochement…',
              onClick: async (ids) => { await api.bank.reconcile(ids.filter((id) => !String(id).startsWith('qb:'))); await refresh() },
            },
            {
              key: 'automatch-hint', label: 'Ignorer', icon: Undo2, busyLabel: 'Mise à jour…',
              onClick: async (ids) => {
                for (const id of ids) if (!String(id).startsWith('qb:')) await api.bank.updateTransaction(id, { status: 'ignore' })
                await refresh()
              },
            },
          ]}
          peek={{
            title: (r) => txnLabel(r),
            subtitle: (r) => fmtDate(r.txn_date),
            width: 420,
            openId: peekOpen.id,
            onOpenConsumed: () => setPeekOpen((p) => ({ ...p, id: null })),
            render: (r) => r._ghost
              ? <GhostPeek row={r} currency={currency} />
              : <TxnPeek txn={r} currency={currency} onChanged={refresh}
                  initialMode={peekOpen.forId === r.id ? peekOpen.mode : null} />,
          }}
          emptyState={{
            title: tab === 'review' ? 'Rien à réviser' : 'Aucune transaction',
            description: tab === 'review'
              ? 'Tout est classé pour ce compte.'
              : account?.plaid_account_id
                ? 'Les transactions arrivent de la banque — rien à importer.'
                : 'Importer un relevé pour commencer le rapprochement.',
          }}
        />
      </div>

      {showImport && account && (
        <ImportModal
          account={account}
          onClose={() => setShowImport(false)}
          onDone={async (res) => {
            setShowImport(false)
            flash(`${res.inserted} importée${res.inserted > 1 ? 's' : ''} (${res.duplicates} doublon${res.duplicates > 1 ? 's' : ''} ignoré${res.duplicates > 1 ? 's' : ''}), ${res.autoMatched} appariée${res.autoMatched > 1 ? 's' : ''} automatiquement.`)
            await refresh()
          }}
        />
      )}
    </Layout>
  )
}
