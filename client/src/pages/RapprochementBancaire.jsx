import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { FileUp, Table2, Wand2, CheckCheck, Undo2, Link2, Unlink, ExternalLink, RefreshCw, AlertTriangle, MoreHorizontal, BookOpen, Download, Clock, Plus, ArrowLeftRight, Check, X, Landmark, Wallet, FileText, FileWarning, Flag, Bookmark, Send } from 'lucide-react'
import api from '../lib/api.js'
import { invalidate } from '../lib/prefetch.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtMoney } from '../utils/formatters.js'
import { VendorSelect } from '../components/VendorSelect.jsx'
import { VendorProfileHint } from '../components/VendorProfileHint.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { StatementDropModal } from '../components/StatementDropModal.jsx'
import RecordPeekDrawer from '../components/RecordPeekDrawer.jsx'
import DebtPaymentPublish from '../components/DebtPaymentPublish.jsx'
import { RecordScope } from '../lib/recordLive.jsx'
import { subscribe } from '../lib/realtime.js'

// Le volet « Règles » : même liste que /regles-bancaires, chargée seulement
// quand on l'ouvre (elle va chercher le plan comptable de QuickBooks).
const BankRulesList = lazy(() => import('../components/BankRulesList.jsx').then((m) => ({ default: m.BankRulesList })))

// Sentinel « pas de taxe » des profils fournisseurs (côté serveur : bankActions.js).
const NO_TAX = '__none__'

// Statuts = l'ancien code couleur du fichier TRX_Orisha.xlsx.
// La ligne entière porte la couleur (voir `row-st-*` dans index.css) ;
// `color` reste la pastille du panneau latéral.
// `tint` : le nom de classe est écrit ici EN TOUTES LETTRES, jamais construit
// par interpolation — sinon le scanner de Tailwind ne le voit pas et purge la
// règle du CSS livré.
const STATUS_META = {
  a_traiter:     { label: 'À traiter',      color: 'red',    tint: 'row-st-a_traiter',     hint: 'Aucun document trouvé — souvent facture manquante' },
  facture_recue: { label: 'Facture reçue',  color: 'blue',   tint: 'row-st-facture_recue', hint: 'Document apparié, pas encore publié dans QuickBooks' },
  comptabilise:  { label: 'Comptabilisé',   color: 'yellow', tint: 'row-st-comptabilise',  hint: 'Publié à QuickBooks, pas encore rapproché' },
  rapproche:     { label: 'Rapproché',      color: 'green',  tint: 'row-st-rapproche',     hint: 'Comptabilisé et validé contre le relevé' },
  ignore:        { label: 'Ignoré',         color: 'gray',   tint: 'row-st-ignore',        hint: 'Exclu du rapprochement' },
}

// L'état d'une ligne à la banque. « Complété » est le cas ordinaire : il reste
// muet pour que les deux autres se voient.
const BANK_STATE_META = {
  complete:   { label: 'Complété',   cls: 'text-slate-400' },
  en_attente: { label: 'En attente', cls: 'text-amber-700' },
  autorise:   { label: 'Autorisé',   cls: 'text-blue-700' },
}

// Les écritures QuickBooks sans ligne au relevé : une couleur à part, sinon
// elles fausseraient le compteur « Comptabilisé » (qui doit rester le nombre de
// lignes du relevé restant à rapprocher).
const GHOST_META = { label: 'Hors relevé', tint: 'row-st-ghost', hint: 'Écriture QuickBooks sans ligne au relevé' }

// La couleur d'une ligne : le fantôme l'emporte sur le statut (il n'a pas de
// statut réel). Une seule fonction pour les compteurs, le filtre et la teinte.
const bucketOf = (r) => (r._ghost ? 'ghost' : (STATUS_META[r.status] ? r.status : 'a_traiter'))

// Ordre de la légende = ordre du travail, pas celui de STATUS_META.
// Vert posé par le passage automatique (serveur : bankAutoReconcile).
const AUTO_RECONCILE = { qb_rapproche: 'QuickBooks', ecart_zero: 'écart nul' }
const LEGEND_ORDER = ['a_traiter', 'facture_recue', 'comptabilise', 'rapproche', 'ignore']

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
  return <Link to={to} onClick={(e) => e.stopPropagation()} className="link-record">{label || type}</Link>
}

// ── Miroir vers le classeur Google ───────────────────────────────────────────
// Boreal écrit, personne d'autre : le bouton pousse le rapprochement et ses
// couleurs dans le classeur, et donne le lien.
// Le classeur Google miroir : état + recopie. Rendu comme une entrée du menu
// « ⋯ » (voir MoreMenu) depuis que la page n'a plus d'en-tête.
function useMirror(flash) {
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState(null)

  useEffect(() => {
    let alive = true
    api.bank.mirrorStatus().then((s) => { if (alive) setUrl(s?.url || null) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const run = async () => {
    setBusy(true)
    try {
      const res = await api.bank.mirrorSync()
      setUrl(res.url)
      const bits = [
        res.added ? `${res.added} ligne${res.added > 1 ? 's' : ''} ajoutée${res.added > 1 ? 's' : ''}` : null,
        res.cells ? `${res.cells} cellule${res.cells > 1 ? 's' : ''} à jour` : null,
      ].filter(Boolean)
      flash(bits.length ? `Classeur à jour — ${bits.join(', ')}.` : 'Classeur déjà à jour.')
    } catch (e) { flash(e.message) } finally { setBusy(false) }
  }

  return { busy, url, run }
}

// ── « Ajouter » : comptabiliser une ligne qui n'aura jamais de facture ──────
//
// Le pendant du bouton « Ajouter » de QuickBooks, et le dossier de préparation
// de l'écriture : chaque valeur proposée affiche D'OÙ elle vient — le relevé, le
// document apparié, une règle, le profil du fournisseur, ou l'habitude (« 7 fois
// sur 8 »). Un champ sans source reste vide : on ne devine pas en silence.
// Quand le profil et l'habitude se contredisent, on le dit au lieu de trancher.
function AddExpenseForm({ txn, currency, onDone, onCancel }) {
  const [defaults, setDefaults] = useState(null)
  const [form, setForm] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [taxCodes, setTaxCodes] = useState([])
  const [rate, setRate] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Écriture coupée : une part par compte. `null` = une seule dépense.
  const [parts, setParts] = useState(null)

  useEffect(() => {
    let alive = true
    api.bank.addDefaults(txn.id).then((d) => {
      if (!alive) return
      setDefaults(d)
      // Remboursement de marge : l'écriture s'ouvre déjà coupée en capital et
      // intérêts, il ne reste qu'à confirmer.
      if (d.split?.lines?.length) setParts(d.split.lines.map((l) => ({ ...l })))
      setForm({
        vendor: d.vendor || '',
        expense_account_id: d.expense_account_id || '',
        tax_code_id: d.tax_code_id || '',
        memo: d.memo || '',
        doc_number: d.doc_number || '',
        qb_type: d.qb_type === 'bill' ? 'bill' : 'purchase',
      })
    }).catch((e) => setError(e.message))
    Promise.all([api.quickbooks.accounts(), api.quickbooks.taxCodes()])
      .then(([a, t]) => { if (alive) { setAccounts(a || []); setTaxCodes(t || []) } })
      .catch(() => {})
    return () => { alive = false }
  }, [txn.id])

  // Dernier recours pour le compte de dépense : la catégorie écrite sur la fiche
  // fournisseur (« 14000 Pièces ») désigne un numéro de compte — on prend celui qui
  // le porte. Complète seulement un champ VIDE, et ne touche jamais à une saisie.
  const vendorCategory = defaults?.vendor_category
  useEffect(() => {
    if (!vendorCategory || !accounts.length) return
    // « 14000 Pièces ou 67000 Fournitures » : deux comptes possibles, on ne choisit pas.
    const nums = [...new Set(String(vendorCategory).match(/\d{4,6}/g) || [])]
    if (nums.length !== 1) return
    const num = nums[0]
    const hit = accounts.find((a) => String(a.AcctNum || '') === num)
    if (!hit) return
    setForm((f) => (f && !f.expense_account_id ? { ...f, expense_account_id: String(hit.Id) } : f))
  }, [vendorCategory, accounts])

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
  // La taxe RÉELLEMENT facturée quand un document est apparié ; sinon seulement,
  // la part déduite du taux nominal du code choisi.
  const docTax = defaults?.tax_cad
  const taxCad = docTax != null ? docTax
    : (rate ? Math.round((total - total / (1 + rate / 100)) * 100) / 100 : 0)
  // La base à répartir quand l'écriture est coupée : le relevé moins la taxe.
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
  const base = round2(total - taxCad)
  const rest = round2(base - (parts || []).reduce((n, p) => n + (Number(p.amount) || 0), 0))

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      const r = await api.bank.addExpense(txn.id, {
        vendor: form.vendor,
        expense_account_id: parts ? '' : form.expense_account_id,
        lines: parts || undefined,
        tax_code_id: form.tax_code_id || null,
        tax_cad: taxCad,
        memo: form.memo,
        payment_account_id: defaults?.payment_account_id || null,
        payment_method: defaults?.payment_method || null,
        doc_number: form.doc_number || null,
        qb_type: form.qb_type,
        due_date: form.qb_type === 'bill' ? defaults?.due_date || null : null,
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

  const draft = defaults?.draft
  // La provenance d'une valeur, sous le champ. Vide = l'humain l'a saisie.
  const from = (k) => {
    const src = draft?.fields?.[k]?.source
    return src ? <span className="text-[11px] text-slate-400">{src}</span> : null
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="text-xs text-slate-500">
        Comptabiliser {money(total, currency)}{draft?.document ? ` · ${draft.document.label}` : ' sans facture'}.
        {/* La règle qui a rempli ces champs : sans elle, on ne saurait pas
            pourquoi le compte et la taxe sont déjà là. */}
        {txn.rule_name && <span className="text-slate-400"> Préparée par la règle « {txn.rule_name} ».</span>}
      </div>

      {!!draft?.hints?.length && (
        <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-500 space-y-0.5">
          {draft.hints.map((h) => <div key={h.label}>{h.label} : {h.value}</div>)}
        </div>
      )}

      {/* Disposition de QuickBooks (choix de Charles, 2026-09-29) : les champs
          côte à côte sur une ligne, l'action dessous. */}
      <div className="grid grid-cols-4 gap-x-3 gap-y-2 items-start">
        <label className="block">
          {/* La fiche du fournisseur (particularités, compte, taxes, échéance) se lit
              au survol de la pastille : on ne quitte pas la transaction pour aller
              la chercher dans /fournisseurs. */}
          <span className="text-xs text-slate-500">
            Fournisseur
            <VendorProfileHint name={form.vendor} accountName={accountName} taxName={taxName} />
          </span>
          <VendorSelect value={form.vendor} onChange={({ vendor }) => set('vendor')(vendor)} />
          {from('vendor')}
        </label>

        {!parts && (
          <label className="block">
            <span className="text-xs text-slate-500">Compte de dépense</span>
            <SearchableSelect value={form.expense_account_id} onChange={set('expense_account_id')}
              options={accounts} getOptionValue={(a) => String(a.Id)}
              getOptionLabel={(a) => `${a.AcctNum ? `${a.AcctNum} · ` : ''}${a.Name}`}
              placeholder="Choisir un compte" />
            <div className="flex items-center justify-between">
              {from('expense_account_id')}
              <button type="button" className="text-[11px] text-slate-500 hover:text-brand-600 hover:underline"
                onClick={() => setParts([
                  { expense_account_id: form.expense_account_id, amount: base },
                  { expense_account_id: '', amount: 0 },
                ])}>
                Diviser
              </button>
            </div>
          </label>
        )}

        <label className="block">
          <span className="text-xs text-slate-500">Taxe</span>
          <SearchableSelect value={form.tax_code_id} onChange={set('tax_code_id')}
            options={taxCodes} getOptionValue={(t) => String(t.Id)} getOptionLabel={(t) => t.Name}
            emptyOption="Aucune taxe" placeholder="Aucune taxe" />
        </label>

        <label className="block">
          <span className="text-xs text-slate-500">Type</span>
          <select className="w-full border border-slate-300 rounded-lg px-2 py-1 text-sm bg-white"
            value={form.qb_type} onChange={(e) => set('qb_type')(e.target.value)}>
            <option value="purchase">Dépense</option>
            <option value="bill">Facture fournisseur</option>
          </select>
          {from('qb_type')}
          {form.qb_type === 'bill' && defaults?.due_date && (
            <span className="text-[11px] text-slate-400">échéance {defaults.due_date}</span>
          )}
        </label>

        <label className="block col-span-2">
          <span className="text-xs text-slate-500">Mémo</span>
          <input className="w-full border border-slate-300 rounded-lg px-2 py-1 text-sm"
            value={form.memo} onChange={(e) => set('memo')(e.target.value)} />
          {from('memo')}
        </label>

        <label className="block">
          <span className="text-xs text-slate-500">N° du document</span>
          <input className="w-full border border-slate-300 rounded-lg px-2 py-1 text-sm"
            value={form.doc_number} onChange={(e) => set('doc_number')(e.target.value)} />
          {from('doc_number')}
        </label>
      </div>

      {parts && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">{defaults?.split?.reason || 'Comptes de dépense'}</span>
            <button type="button" className="text-[11px] text-slate-500 hover:underline" onClick={() => setParts(null)}>
              Un seul compte
            </button>
          </div>
          {parts.map((p, i) => (
            <div key={i} className="flex gap-2 items-center">
              <div className="grow min-w-0">
                <SearchableSelect value={p.expense_account_id}
                  onChange={(v) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, expense_account_id: v } : x)))}
                  options={accounts} getOptionValue={(a) => String(a.Id)}
                  getOptionLabel={(a) => `${a.AcctNum ? `${a.AcctNum} · ` : ''}${a.Name}`}
                  placeholder="Choisir un compte" />
              </div>
              <input type="number" step="0.01" value={p.amount}
                className="w-24 border border-slate-300 rounded-lg px-2 py-1 text-sm text-right"
                onChange={(e) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) } : x)))} />
              <button type="button" className="text-slate-300 hover:text-red-600" title="Retirer"
                onClick={() => setParts((ps) => (ps.length > 2 ? ps.filter((_, j) => j !== i) : ps))}>
                <X size={14} />
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between text-xs">
            <button type="button" className="text-slate-500 hover:text-brand-600 hover:underline"
              onClick={() => setParts((ps) => [...ps, { expense_account_id: '', amount: rest > 0 ? rest : 0 }])}>
              Ajouter une part
            </button>
            <span className={Math.abs(rest) > 0.02 ? 'text-amber-600' : 'text-slate-400'}>
              {Math.abs(rest) > 0.02 ? `reste ${money(rest, currency)}` : `${money(base, currency)} répartis`}
            </span>
          </div>
        </div>
      )}

      <div className="text-xs text-slate-500">
        {docTax != null ? (
          <span>
            {money(taxCad, currency)} de taxe, {money(total - taxCad, currency)} au compte — {draft?.fields?.tax?.source}
          </span>
        ) : (
          <>
            {rate === undefined && <span className="text-slate-400">taux…</span>}
            {!!rate && (
              <span>
                {rate.toFixed(3).replace(/\.?0+$/, '')} % → {money(taxCad, currency)} de taxe, {money(total - taxCad, currency)} au compte
              </span>
            )}
          </>
        )}
      </div>

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

      {/* Comme dans QuickBooks : l'action au bout de la ligne, à droite. */}
      <div className="flex items-center gap-3">
        <button type="button" className="ml-auto text-sm text-slate-500 hover:underline" onClick={onCancel}>
          Annuler
        </button>
        <button type="button" className="px-4 py-1.5 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
          disabled={busy || !form.vendor
            || (parts ? (Math.abs(rest) > 0.02 || parts.some((p) => !p.expense_account_id)) : !form.expense_account_id)}
          onClick={submit}>
          {busy ? 'Publication…' : 'Ajouter'}
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
// Ce qu'un moteur a trouvé et qui attend une décision. La preuve est écrite en
// français par le serveur et affichée telle quelle : c'est elle qui permet de
// trancher en une seconde, pas la confiance en pourcentage.
// Un refus est DÉFINITIF — la proposition ne reviendra pas au prochain passage.
function ProposalCards({ txn, currency, onChanged }) {
  const [items, setItems] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const load = () => api.bank.txnProposals(txn.id).then(setItems).catch(() => setItems([]))
  useEffect(() => { setItems(null); setError(null); load() }, [txn.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (p, accept) => {
    setBusy(p.id); setError(null)
    try {
      if (accept) await api.bank.acceptProposal(p.id)
      else await api.bank.refuseProposal(p.id)
      invalidate('/bank')
      await onChanged()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  const open = (items || []).filter((p) => p.status === 'proposee')
  if (!open.length) return null

  return (
    <div className="space-y-2" data-testid="proposal-cards">
      {open.map((p) => (
        <div key={p.id} className="rounded-lg border border-brand-200 bg-brand-50/60 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Wand2 size={13} className="text-brand-700 shrink-0" />
            <span className="text-xs font-medium text-slate-800">{PROPOSAL_TITLE[p.kind] || p.kind}</span>
            {p.confidence != null && <span className="text-[11px] text-slate-500">{Math.round(p.confidence * 100)} %</span>}
          </div>
          {p.payload?.qb_txn_id && (
            <div className="text-xs text-slate-700">
              Écriture {p.payload.qb_txn_type || ''} n° {p.payload.qb_txn_id}
              {p.payload.date ? ` · ${fmtDate(p.payload.date)}` : ''}
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {(p.evidence || []).map((e, i) => (
              <span key={i} className="text-[11px] px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-600">
                {e.label}{e.detail ? ` : ${e.detail}` : ''}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
              data-testid="proposal-accept" disabled={busy === p.id} onClick={() => decide(p, true)}>
              <Check size={13} /> C'est bien ça
            </button>
            <button className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline disabled:opacity-50"
              title="Définitif : cette proposition ne reviendra pas"
              disabled={busy === p.id} onClick={() => decide(p, false)}>
              <X size={12} /> Ce n'est pas ça
            </button>
            <span className="grow" />
            <span className="text-[11px] text-slate-400">{money(txn.amount, currency)}</span>
          </div>
        </div>
      ))}
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  )
}

const PROPOSAL_TITLE = {
  qb_link: 'Écriture QuickBooks retrouvée',
  doc_match: 'Document apparié',
  invoice_found: 'Facture retrouvée',
  payment_clear: 'Paiement passé au compte',
  paie_debit: 'Débit de paie',
  aga_repartition: 'Répartition AGA',
  debt_payment: 'Versement de dette',
  vendor_expense: 'Écriture prête',
}

// ── Suggestion sur la ligne ────────────────────────────────────────────────
// Ce qu'il faut pour dire oui ou non sans ouvrir le panneau : quoi, avec qui,
// et la preuve. Les noms de comptes et de taxes QuickBooks sont chargés une
// fois, seulement si une ligne en a besoin.
let qbNamesCache = null
function useQbNames(needed) {
  const [names, setNames] = useState(qbNamesCache)
  useEffect(() => {
    if (!needed || qbNamesCache) return
    Promise.all([api.quickbooks.accounts(), api.quickbooks.taxCodes()])
      .then(([a, t]) => { qbNamesCache = { accounts: a || [], taxCodes: t || [] }; setNames(qbNamesCache) })
      .catch(() => {})
  }, [needed])
  return names
}
const nameIn = (list, id) => (list || []).find((o) => String(o.Id) === String(id))?.Name || null

function suggestionText(sg, names, currency) {
  const p = sg.payload || {}
  const proof = (sg.evidence || [])
    .filter((e) => !/^(Paiement émis|Versement attendu|Fournisseur|Compte)$/.test(e.label))
    .map((e) => (e.detail ? `${e.label} ${e.detail}` : e.label))
  switch (sg.kind) {
    case 'payment_clear':
      return { what: `Paiement émis · ${p.label || ''}`, facts: [p.payment_date && fmtDate(p.payment_date), p.payment_amount != null && money(Math.abs(p.payment_amount), currency)], proof }
    case 'debt_payment':
      return { what: `Versement · ${p.debt || 'dette'}`, facts: [], proof }
    case 'paie_debit':
      return { what: 'Débit de la paie', facts: [], proof }
    case 'qb_link':
      return { what: `QuickBooks · ${p.qb_txn_type || 'écriture'} n° ${p.qb_txn_id}`, facts: [p.date && fmtDate(p.date), p.account_name], proof }
    case 'vendor_expense': {
      const acct = nameIn(names?.accounts, p.expense_account_id)
      const tax = p.tax_code_id === '__none__' ? 'sans taxe' : nameIn(names?.taxCodes, p.tax_code_id)
      return { what: `Dépense · ${p.vendor || '?'}`, facts: [acct && `→ ${acct}`, tax], proof: [] }
    }
    default:
      return { what: PROPOSAL_TITLE[sg.kind] || sg.kind, facts: [], proof }
  }
}

function SuggestionCell({ row, currency, names, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const act = (fn) => async (e) => {
    e.stopPropagation()
    setBusy(true); setError(null)
    try { await fn(); invalidate('/bank'); await onChanged() } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  const auto = row.auto_suggestion
  if (auto && !row.suggestion) {
    const t = suggestionText(auto, names, currency)
    return (
      <span className="flex items-center gap-1.5 min-w-0 text-sm">
        <span className="truncate">{t.what}</span>
        <span className="shrink-0 text-[10px] font-bold tracking-wide text-emerald-700 border border-emerald-600 rounded px-1">AUTO</span>
        <button type="button" disabled={busy} onClick={act(() => api.bank.undoProposal(auto.id))}
          className="shrink-0 text-xs text-slate-500 underline hover:text-slate-800 disabled:opacity-40">annuler</button>
        {error && <span className="text-xs text-red-600 truncate" title={error}>{error}</span>}
      </span>
    )
  }
  const sg = row.suggestion
  if (!sg) return null
  const t = suggestionText(sg, names, currency)
  const details = [...t.facts, ...t.proof].filter(Boolean)
  const tip = [t.what, ...details.map((d) => (typeof d === 'string' ? d : null)).filter(Boolean),
    sg.publishes ? 'Crée l\'écriture dans QuickBooks' : null].filter(Boolean).join('\n')
  return (
    <span className="flex items-center gap-1.5 min-w-0 text-sm" title={tip} data-testid="row-suggestion">
      <span className="min-w-0 truncate rounded border border-dashed border-violet-500 px-1.5 text-violet-800 italic">
        {t.what}
        {details.map((d, i) => <span key={i} className="not-italic text-slate-500"> · {d}</span>)}
      </span>
      {sg.publishes && <span className="shrink-0 text-[10px] font-semibold text-amber-700" title="Crée l'écriture dans QuickBooks">QB</span>}
      <button type="button" title="Oui" disabled={busy} onClick={act(() => api.bank.acceptProposal(sg.id))}
        className="shrink-0 p-0.5 rounded border border-slate-300 bg-white text-emerald-700 hover:bg-emerald-50 disabled:opacity-40">
        <Check size={13} />
      </button>
      <button type="button" title="Non — ne reviendra pas" disabled={busy} onClick={act(() => api.bank.refuseProposal(sg.id))}
        className="shrink-0 p-0.5 rounded border border-slate-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-40">
        <X size={13} />
      </button>
      {error && <span className="text-xs text-red-600 truncate" title={error}>{error}</span>}
    </span>
  )
}

// L'écriture QuickBooks de la ligne, montrée comme QuickBooks la montre.
// Confirmer un appariement demandait d'ouvrir QBO dans un autre onglet, de
// lire l'écriture, de revenir : les trois colonnes qui comptent (compte,
// taxe, montant) sont maintenant ici, et le lien vers QBO reste à un clic
// pour le cas où on veut la modifier.
function QbEntryCard({ txn, currency, onChanged }) {
  const [entry, setEntry] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setEntry(null); setError(null)
    api.bank.qbEntry(txn.id)
      .then((e) => { if (alive) setEntry(e) })
      .catch((e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [txn.id])

  const act = async (fn) => {
    setBusy(true)
    try { await fn(); invalidate('/bank'); await onChanged() }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  const done = txn.status === 'rapproche'
  const head = entry?.readable
    ? [entry.type_label, entry.doc_number && `n° ${entry.doc_number}`, entry.date && fmtDate(entry.date)].filter(Boolean).join(' · ')
    : 'Écriture QuickBooks'

  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden" data-testid="qb-entry-card">
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200">
        <BookOpen size={13} className="text-slate-500 shrink-0" />
        <span className="text-xs font-medium text-slate-700 truncate">{head}</span>
        <span className="grow" />
        {entry?.total != null && (
          <span className="text-sm font-semibold tabular-nums">{money(entry.total, entry.currency || currency)}</span>
        )}
      </div>

      {!entry && !error && <div className="px-3 py-3 text-xs text-slate-400">Lecture dans QuickBooks…</div>}
      {error && <div className="px-3 py-3 text-xs text-red-600">{error}</div>}

      {entry?.readable === false && (
        <div className="px-3 py-3 text-xs text-slate-500">{entry.reason}</div>
      )}

      {entry?.readable && (
        <div className="px-3 py-2.5 space-y-2 text-xs">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {entry.party && <span><span className="text-slate-500">Nom </span>{entry.party}</span>}
            {entry.payment_account && <span><span className="text-slate-500">Compte </span>{entry.payment_account}</span>}
            {entry.payment_type && <span><span className="text-slate-500">Mode </span>{entry.payment_type}</span>}
            {entry.exchange_rate && entry.exchange_rate !== 1 && (
              <span><span className="text-slate-500">Taux </span>{entry.exchange_rate}</span>
            )}
          </div>

          {entry.lines?.length > 0 && (
            <table className="w-full">
              <tbody>
                {entry.lines.map((l, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="py-1 pr-2 align-top">
                      <div className="text-slate-800">{l.account || '—'}</div>
                      {l.description && <div className="text-slate-500 truncate">{l.description}</div>}
                    </td>
                    <td className="py-1 pr-2 align-top text-slate-500 whitespace-nowrap">
                      {l.tax_code || l.posting || ''}
                    </td>
                    <td className="py-1 align-top text-right tabular-nums whitespace-nowrap">
                      {money(l.amount, entry.currency || currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {entry.tax_total != null && entry.tax_total !== 0 && (
            <div className="text-slate-500">Taxe {money(entry.tax_total, entry.currency || currency)}</div>
          )}
          {entry.memo && <div className="text-slate-500 italic truncate" title={entry.memo}>{entry.memo}</div>}

          {/* L'écart avec le relevé décide à lui seul de la confirmation. */}
          {entry.bank_amount != null && entry.total != null && (
            (() => {
              const gap = Math.round((Math.abs(entry.bank_amount) - Math.abs(entry.total)) * 100) / 100
              return gap === 0
                ? <div className="text-green-700">Même montant qu'au relevé.</div>
                : <div className="text-amber-700">Écart avec le relevé : {money(gap, currency)}{entry.match_rate ? ` (taux ${entry.match_rate})` : ''}</div>
            })()
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-slate-200 bg-white">
        {done ? (
          <>
            <span className="inline-flex items-center gap-1 text-xs text-green-700"><Check size={13} /> Rapprochée{AUTO_RECONCILE[txn.reconcile_method] ? ` · auto (${AUTO_RECONCILE[txn.reconcile_method]})` : ''}</span>
            <button className="text-xs text-slate-500 hover:underline disabled:opacity-50" disabled={busy}
              onClick={() => act(() => api.bank.reconcile([txn.id], true))}>Annuler</button>
          </>
        ) : (
          <button data-testid="qb-entry-confirm" disabled={busy}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            onClick={() => act(() => api.bank.reconcile([txn.id]))}>
            <Check size={13} /> C'est bien ça
          </button>
        )}
        {entry?.url && (
          <a href={entry.url} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
            <ExternalLink size={12} /> Ouvrir dans QuickBooks
          </a>
        )}
        <span className="grow" />
        <button className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline disabled:opacity-50" disabled={busy}
          title="Le lien est refusé ; l'écriture, elle, reste dans QuickBooks"
          onClick={() => act(() => api.bank.clearQbLink(txn.id))}>
          <X size={12} /> Ce n'est pas ça
        </button>
      </div>
    </div>
  )
}

// « Ce libellé, c'est ce fournisseur ». Le relevé écrit « CHQ #4471 DIGI-KEY
// CORP MN » ; le motif appris ici fait que toutes les lignes suivantes du même
// fournisseur sont reconnues toutes seules. Il fallait auparavant ouvrir la
// page Fournisseurs et coller le motif à la main.
// ── « Toujours faire ça pour ce libellé » ───────────────────────────────────
//
// La généralisation du geste « ce libellé = ce fournisseur » : une règle
// bancaire préremplie avec ce que l'humain vient de voir, et l'aperçu de ce
// qu'elle couvrirait. Elle PRÉPARE l'écriture des prochaines lignes — elle ne
// publie jamais seule.
function RuleFromTxnForm({ txn }) {
  const [draft, setDraft] = useState(null)
  const [keepBooking, setKeepBooking] = useState(true)
  const [names, setNames] = useState(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState(null)
  // Ce libellé revient-il assez pour mériter une règle ? Boréal ne le propose
  // qu'à partir de la troisième fois, et seulement si rien ne le couvre déjà.
  const [chance, setChance] = useState(null)

  useEffect(() => {
    let alive = true
    api.bank.rules.opportunity(txn.id).then((o) => { if (alive) setChance(o) }).catch(() => {})
    return () => { alive = false }
  }, [txn.id])

  const open = async () => {
    setBusy(true); setError(null)
    try {
      setDraft(await api.bank.rules.draftFromTxn(txn.id))
      // Les noms des comptes et des codes de taxe, seulement à l'ouverture.
      if (!names) {
        Promise.all([api.quickbooks.accounts(), api.quickbooks.taxCodes()])
          .then(([a, t]) => setNames({ accounts: a || [], taxCodes: t || [] })).catch(() => {})
      }
    }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const save = async () => {
    setBusy(true); setError(null)
    try {
      const { preview: _p, ...rule } = draft
      // Sans la façon de comptabiliser, la règle ne retient que le libellé.
      if (!keepBooking) {
        rule.vendor_name = null; rule.expense_account_id = null
        rule.tax_code_id = null; rule.memo = null; rule.qb_type = null
      }
      await api.bank.rules.create(rule)
      setDone(true); setDraft(null)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  if (done) return <Link to="/regles-bancaires" className="text-xs text-emerald-700 hover:underline">Règle créée — la voir</Link>
  if (!draft) {
    // Le libellé est déjà passé plusieurs fois : on le dit, plutôt que
    // d'attendre que l'utilisateur pense tout seul à créer la règle.
    if (chance) {
      return (
        <div className="flex items-center gap-2 rounded-lg bg-brand-50 px-2.5 py-1.5">
          <span className="text-xs text-slate-600 flex-1 min-w-0">
            <b className="font-semibold">{chance.lines}<sup>e</sup> fois</b> en {chance.months} mois
            {chance.vendor_name ? ` · ${chance.vendor_name}` : ''} — en faire une règle ?
          </span>
          <button type="button" className="shrink-0 text-xs px-2 py-1 rounded-lg bg-brand-600 text-white hover:bg-brand-700"
            disabled={busy} onClick={open}>Oui</button>
          <button type="button" className="shrink-0 text-xs text-slate-400 hover:text-slate-700"
            onClick={() => setChance(null)}>Non</button>
        </div>
      )
    }
    return (
      <div>
        <button type="button" className="text-xs text-slate-500 hover:text-brand-600 hover:underline"
          disabled={busy} onClick={open}>
          Toujours faire ça pour ce libellé
        </button>
        {error && <div className="text-xs text-red-600">{error}</div>}
      </div>
    )
  }
  const nameOf = (list, id) => (list || []).find((o) => String(o.Id) === String(id))?.Name || null
  const booking = [
    draft.vendor_name,
    nameOf(names?.accounts, draft.expense_account_id) || (draft.expense_account_id ? 'compte choisi' : null),
    draft.tax_code_id ? `taxe ${nameOf(names?.taxCodes, draft.tax_code_id) || ''}`.trim() : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="space-y-2 bg-slate-50 rounded-lg p-2">
      <input value={draft.label_pattern} className="w-full text-xs border border-slate-300 rounded-lg px-2 py-1"
        onChange={(e) => setDraft((d) => ({ ...d, label_pattern: e.target.value, name: e.target.value.slice(0, 40) }))} />
      <div className="text-xs text-slate-500">
        {draft.preview.count} lignes · {draft.preview.a_traiter} à traiter
      </div>
      {/* Ce que la règle retiendra de la façon de comptabiliser : ce que la
          ligne porte déjà, sinon ce que le dossier avait préparé. */}
      {booking && (
        <label className="flex items-start gap-2 text-xs text-slate-600">
          <input type="checkbox" className="mt-0.5" checked={keepBooking} onChange={(e) => setKeepBooking(e.target.checked)} />
          <span>{booking}</span>
        </label>
      )}
      <div className="flex items-center gap-2">
        <button className="text-xs px-2 py-1 rounded-lg bg-brand-600 text-white disabled:opacity-50"
          disabled={busy || draft.label_pattern.trim().length < 3} onClick={save}>
          {busy ? '…' : 'Créer la règle'}
        </button>
        <Link to="/regles-bancaires" className="text-xs text-slate-500 hover:underline">Compléter</Link>
        <button className="text-xs text-slate-500 hover:underline" onClick={() => setDraft(null)}>Annuler</button>
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  )
}

function VendorPatternForm({ txn, onSaved }) {
  const [open, setOpen] = useState(false)
  const [profiles, setProfiles] = useState([])
  const [profileId, setProfileId] = useState(txn.resolved_vendor?.profile_id || '')
  // Par défaut, les premiers mots du libellé : la partie qui ne change pas
  // d'une transaction à l'autre (les numéros et les villes, si).
  const [pattern, setPattern] = useState(() => txnLabel(txn).split(/\s+/).slice(0, 2).join(' '))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Les fiches fournisseurs, chargées seulement quand on ouvre le formulaire.
  useEffect(() => {
    if (!open || profiles.length) return
    api.vendorProfiles.list().then((r) => setProfiles(r?.data || r || [])).catch(() => setProfiles([]))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) {
    return (
      <button type="button" className="text-xs text-slate-500 hover:text-brand-600 hover:underline"
        onClick={() => setOpen(true)}>
        {txn.resolved_vendor ? 'Corriger le fournisseur reconnu' : 'Dire à quel fournisseur ce libellé appartient'}
      </button>
    )
  }
  const save = async () => {
    setBusy(true); setError(null)
    try {
      await api.bank.learnVendorPattern(txn.id, { profile_id: profileId, pattern })
      setOpen(false)
      await onSaved()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-2 bg-slate-50 rounded-lg p-2">
      <SearchableSelect value={profileId} options={profiles} onChange={setProfileId}
        placeholder="Quel fournisseur ?"
        getOptionValue={(o) => o.id} getOptionLabel={(o) => o.name} />
      <div className="flex items-center gap-2">
        <input value={pattern} onChange={(e) => setPattern(e.target.value)}
          className="flex-1 min-w-0 text-xs border border-slate-300 rounded-lg px-2 py-1" />
        <button className="text-xs px-2 py-1 rounded-lg bg-brand-600 text-white disabled:opacity-50"
          disabled={busy || !profileId || pattern.trim().length < 3} onClick={save}>
          {busy ? '…' : 'Retenir'}
        </button>
        <button className="text-xs text-slate-500 hover:underline" onClick={() => setOpen(false)}>Annuler</button>
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  )
}

// ── Comptabiliser sans changer d'écran ──────────────────────────────────────
//
// Une ligne de relevé n'est pas toujours une facture. C'est aussi un versement
// de dette (la ventilation capital / intérêts vit dans la cédule), un débit de
// paie, un paiement émis, un document extrait. Chacune de ces natures avait son
// écran : on quittait le rapprochement pour comptabiliser, puis on y revenait.
//
// `GET /bank/transactions/:id/dossier` dit ce que la ligne porte — rien n'y est
// deviné, seulement ce qui est déjà rattaché — et la surface correspondante
// s'ouvre ICI : la ventilation de la dette dans le panneau, la carte de paie et
// la facture fournisseur dans un panneau empilé par-dessus.
function useDossier(txnId) {
  const [dossier, setDossier] = useState(null)
  const load = useCallback(() => (txnId
    ? api.bank.dossier(txnId).then(setDossier).catch(() => setDossier(null))
    : Promise.resolve()), [txnId])
  useEffect(() => { setDossier(null); load() }, [txnId, load])
  return { dossier, reload: load }
}

// La fiche d'un achat fournisseur n'a pas de route ; elle s'ouvre par son
// formulaire, le même que sur /fournisseurs/achats (autosave, publication QB,
// pièces jointes) — chargé à la demande pour ne pas alourdir cette page.
const AchatPanel = lazy(() => import('./AchatsFournisseurs.jsx').then((m) => ({ default: m.AchatModal })))
const PaiePanel = lazy(() => import('./ComptaDashboard.jsx').then((m) => ({ default: m.PaieComptabilisationCard })))
const AgaPanel = lazy(() => import('./ComptaDashboard.jsx').then((m) => ({ default: m.AgaRepartitionCard })))

function PanelFallback() {
  return <div className="p-6 text-sm text-slate-400">Chargement…</div>
}

// Le document apparié : reçus et payouts ont une fiche que le panneau empile
// tout seul (un simple lien suffit) ; l'achat fournisseur, non — d'où le bouton.
function MatchedDocument({ txn, doc, onChanged, icon = false }) {
  const [achat, setAchat] = useState(null)
  const [loading, setLoading] = useState(false)
  const label = txn.matched_label || doc?.label || 'Document'

  if (txn.matched_type === 'achat') {
    const open = async () => {
      setLoading(true)
      try { setAchat(await api.achatsFournisseurs.get(txn.matched_id)) } catch { /* lien mort : on laisse le libellé */ }
      finally { setLoading(false) }
    }
    return (
      <>
        <button type="button" onClick={(e) => { e.stopPropagation(); open() }} disabled={loading}
          data-testid="open-matched-doc" title={icon ? `Ouvrir ${label}` : undefined}
          className={icon
            ? 'shrink-0 text-slate-300 hover:text-brand-600 disabled:opacity-50'
            : 'link-record text-left disabled:opacity-50'}>
          {icon ? <FileText size={12} /> : label}
        </button>
        {achat && (
          <RecordPeekDrawer open onClose={() => setAchat(null)} peekKey="achats" width={640}
            title={achat.vendor || 'Facture fournisseur'}
            subtitle={[achat.vendor_invoice_number, achat.invoice_date].filter(Boolean).join(' · ')}>
            <div className="px-5 py-4">
              <Suspense fallback={<PanelFallback />}>
                <AchatPanel achat={achat} onClose={() => setAchat(null)} onSaved={async () => { invalidate('/bank'); await onChanged() }} />
              </Suspense>
            </div>
          </RecordPeekDrawer>
        )}
      </>
    )
  }
  // Le payout Stripe s'adresse par son id Stripe : le chemin vient du dossier
  // (panneau) ou de la ligne (tableau), pas de `matched_id`.
  const path = doc?.path || txn.matched_path
  if (path) {
    return (
      <Link to={path} onClick={(e) => e.stopPropagation()} title={icon ? `Ouvrir ${label}` : undefined}
        className={icon ? 'shrink-0 text-slate-300 hover:text-brand-600' : 'link-record'}>
        {icon ? <FileText size={12} /> : label}
      </Link>
    )
  }
  if (icon) return null
  return docLink(txn.matched_type, txn.matched_id, txn.matched_label)
}

// Le versement de dette que porte cette ligne : sa ventilation, et le bouton
// qui la publie. Plus besoin d'ouvrir /dettes-lt et d'y retrouver l'échéance.
function DebtCard({ data, onPublished }) {
  const { debt, payment, qb_url: qbUrl } = data
  const [schedule, setSchedule] = useState(false)
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid="dossier-debt">
      <div className="flex items-center gap-2 mb-2">
        <Landmark size={13} className="text-slate-500 shrink-0" />
        <span className="text-xs font-medium text-slate-700">Versement de dette</span>
        <span className="grow" />
        <button type="button" onClick={() => setSchedule(true)} data-testid="dossier-debt-schedule"
          className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
          <Table2 size={12} /> Cédule
        </button>
      </div>
      <DebtPaymentPublish debt={debt} payment={{ ...payment, qb_url: qbUrl }} onPublished={onPublished} />
      {schedule && (
        <RecordPeekDrawer open peekKey="debt-schedule" width={640} onClose={() => setSchedule(false)}
          title={debt.label} subtitle="Cédule de remboursement">
          <DebtSchedule debtId={debt.id} currentId={payment.id} />
        </RecordPeekDrawer>
      )}
    </div>
  )
}

// La cédule de la dette, lecture seule, le versement de la ligne surligné.
function DebtSchedule({ debtId, currentId }) {
  const [rows, setRows] = useState(null)
  const [currency, setCurrency] = useState('CAD')
  const currentRef = useRef(null)
  useEffect(() => {
    api.ltDebts.payments(debtId).then(d => { setRows(d.payments || []); setCurrency(d.debt?.currency || 'CAD') }).catch(() => setRows([]))
  }, [debtId])
  useEffect(() => { currentRef.current?.scrollIntoView({ block: 'center' }) }, [rows])
  if (!rows) return <div className="p-4"><PanelFallback /></div>
  return (
    <div className="p-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-400 border-b border-slate-100">
            <th className="text-left font-medium px-2 py-2">#</th>
            <th className="text-left font-medium px-2 py-2">Date</th>
            <th className="text-right font-medium px-2 py-2">Capital</th>
            <th className="text-right font-medium px-2 py-2">Intérêt</th>
            <th className="text-right font-medium px-2 py-2">Total</th>
            <th className="text-right font-medium px-2 py-2">Solde</th>
            <th className="px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map(p => (
            <tr key={p.id} ref={p.id === currentId ? currentRef : null}
              className={`border-b border-slate-50 ${p.id === currentId ? 'bg-brand-50 font-medium' : ''}`}>
              <td className="px-2 py-1.5 text-slate-400">{p.seq}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">{fmtDate(p.payment_date)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(p.principal, currency)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(p.interest, currency)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(p.principal + p.interest, currency)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{fmtMoney(p.balance_after, currency)}</td>
              <td className="px-2 py-1.5 text-center">{p.pushed_at && <Check size={13} className="inline text-emerald-600" />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Link to="/dettes-lt" className="block mt-3 text-xs link-record">Ouvrir Dettes à long terme</Link>
    </div>
  )
}

// Le débit de paie : rattaché ici, comptabilisé ici. La carte est celle de la
// page Comptabilité, ouverte sur la période de cette ligne.
function PaieCard({ paie, onChanged }) {
  const [open, setOpen] = useState(false)
  const period = paie.period_start && paie.period_end
    ? `${fmtDate(paie.period_start)} au ${fmtDate(paie.period_end)}`
    : fmtDate(paie.period_end)
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid="dossier-paie">
      <div className="flex items-center gap-2">
        <Wallet size={13} className="text-slate-500 shrink-0" />
        <span className="text-xs font-medium text-slate-700">Paie{paie.number != null ? ` n° ${paie.number}` : ''}</span>
        <span className="text-xs text-slate-500 truncate">{period}</span>
        <span className="grow" />
        {paie.booked ? (
          <span className="text-xs text-slate-500">Comptabilisée</span>
        ) : (
          <button type="button" onClick={() => setOpen(true)} data-testid="dossier-paie-open"
            className="text-xs px-2 py-1 rounded-lg bg-brand-600 text-white hover:bg-brand-700">
            Comptabiliser
          </button>
        )}
      </div>
      {open && (
        <RecordPeekDrawer open peekKey="paie-compta" width={720}
          onClose={async () => { setOpen(false); invalidate('/bank'); await onChanged() }}
          title="Comptabilisation de la paie" subtitle={period}>
          <div className="p-4">
            <Suspense fallback={<PanelFallback />}>
              <PaiePanel paieId={paie.id} />
            </Suspense>
          </div>
        </RecordPeekDrawer>
      )}
      {!paie.booked && (
        <div className="text-[11px] text-slate-400 mt-1">Le débit est rattaché ; la dépense reste à publier.</div>
      )}
    </div>
  )
}

// ENCAISSEMENT CLIENT. Un virement d'un client entre au compte sans document :
// il fallait ouvrir Stripe, retrouver la facture et la marquer payée. Le
// montant ne suffit pas à désigner la bonne facture — plusieurs sont ouvertes
// au même total —, alors chaque candidate arrive avec ce qui la désigne (nom
// du payeur au relevé, numéro, date) et son degré de certitude. Rien n'est
// coché d'office : quand deux candidates se valent, la page le dit et laisse
// chercher. Marquer payée enregistre le paiement, pose le dépôt QuickBooks et
// y joint le PDF de la facture pris sur Stripe.
const VERDICT_META = {
  sure: { dot: 'bg-emerald-500', label: 'Très probable' },
  probable: { dot: 'bg-amber-400', label: 'Possible' },
  faible: { dot: 'bg-slate-300', label: 'Incertaine' },
}

function InvoiceRow({ f, busy, onPay }) {
  const v = VERDICT_META[f.verdict] || VERDICT_META.faible
  const why = (f.reasons || []).join(' · ')
  return (
    <div className="flex items-center gap-2 text-xs min-w-0">
      <span className={`shrink-0 h-2 w-2 rounded-full ${v.dot}`} title={`${v.label}${why ? ` — ${why}` : ''}`} />
      <Link to={`/factures/${f.id}`} onClick={(e) => e.stopPropagation()} className="link-record truncate">
        {f.company_name || f.document_number}
      </Link>
      <span className="text-slate-400 truncate" title={why}>
        {f.document_number} · {fmtDate(f.document_date)}{why ? ` · ${why}` : ''}
      </span>
      <span className="grow" />
      {f.lien_stripe && (
        <a href={f.lien_stripe} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
          title="Ouvrir la facture dans Stripe" className="shrink-0 text-slate-300 hover:text-brand-600">
          <ExternalLink size={12} />
        </a>
      )}
      <button type="button" disabled={busy} onClick={() => onPay(f)} data-testid="invoice-mark-paid"
        className="shrink-0 px-2 py-1 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50">
        {busy ? '…' : 'Marquer payée'}
      </button>
    </div>
  )
}

function InvoiceCard({ txn, invoices, ambiguous, currency, onChanged }) {
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)
  const [q, setQ] = useState('')
  const [found, setFound] = useState(null)

  // Recherche libre : le filet quand la détection n'a pas tranché.
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setFound(null); return undefined }
    const t = setTimeout(() => {
      api.bank.invoiceSearch(txn.id, term).then(r => setFound(r?.candidates || [])).catch(() => setFound([]))
    }, 250)
    return () => clearTimeout(t)
  }, [q, txn.id])

  const pay = async (f) => {
    setBusy(f.id); setError(null); setNote(null)
    try {
      const r = await api.payments.create({
        facture_id: f.id,
        direction: 'in',
        method: /interac/i.test(`${txn.description || ''} ${txn.details || ''}`) ? 'interac' : 'virement_bancaire',
        received_at: txn.txn_date,
        amount: f.balance_due > 0 ? f.balance_due : f.total_amount,
        currency: f.currency || currency || 'CAD',
        notes: `Encaissement vu au relevé — ${txnLabel(txn)}`,
        // Facture marquée « payée » dans Stripe sans encaissement réel : on
        // reprend la main, sinon le solde ne bougerait pas.
        clear_paid_status: !!(f.paid_at && !f.paid_charge_id && !f.paid_payment_intent),
      })
      if (r?.qb_error) setError(`Paiement enregistré, mais pas d'écriture QuickBooks — ${r.qb_error}`)
      else if (r?.qb?.attachment && !r.qb.attachment.attached && r.qb.attachment.reason !== 'déjà jointe') {
        setNote(`Écriture posée ; PDF de la facture non joint (${r.qb.attachment.error || r.qb.attachment.reason}).`)
      }
      invalidate('/bank')
      await onChanged()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  const list = found ?? invoices
  const unsure = ambiguous || !invoices.length || invoices[0]?.verdict !== 'sure'

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2" data-testid="dossier-invoices">
      <div className="flex items-center gap-2">
        <ArrowLeftRight size={13} className="text-slate-500 shrink-0" />
        <span className="text-xs font-medium text-slate-700">Facture client</span>
        {ambiguous && <span className="text-[11px] text-amber-600">plusieurs se ressemblent — à choisir</span>}
      </div>
      {list.map((f) => (
        <InvoiceRow key={f.id} f={f} busy={busy === f.id} onPay={pay} />
      ))}
      {!list.length && <div className="text-xs text-slate-400">Aucune facture ne correspond.</div>}
      {unsure && (
        <label className="flex items-center gap-2 text-[11px] text-slate-400">
          Chercher
          <input value={q} onChange={(e) => setQ(e.target.value)} onClick={(e) => e.stopPropagation()}
            data-testid="invoice-search"
            className="grow text-xs border border-slate-200 rounded-lg px-2 py-1 text-slate-700" />
        </label>
      )}
      {note && <div className="text-xs text-amber-600">{note}</div>}
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  )
}

// LA PIÈCE D'UNE SORTIE. La facture est presque toujours déjà lue dans
// l'extracteur ou saisie en achat, mais le montant et la date ne suffisent pas
// à la désigner : c'est le fournisseur écrit au relevé qui tranche. Apparier
// ici ne publie rien à QuickBooks — ça reste un second geste.
function ReceiptRow({ d, busy, onLink }) {
  const v = VERDICT_META[d.verdict] || VERDICT_META.faible
  const why = (d.reasons || []).join(' · ')
  const to = d.type === 'receipt' ? `/sale-receipts/${d.id}` : null
  return (
    <div className="flex items-center gap-2 text-xs min-w-0">
      <span className={`shrink-0 h-2 w-2 rounded-full ${v.dot}`} title={`${v.label}${why ? ` — ${why}` : ''}`} />
      {to
        ? <Link to={to} onClick={(e) => e.stopPropagation()} className="link-record truncate">{d.label}</Link>
        : <span className="truncate text-slate-700">{d.label}</span>}
      <span className="text-slate-400 truncate" title={why}>
        {fmtDate(d.date)}{why ? ` · ${why}` : ''}
      </span>
      <span className="grow" />
      <button type="button" disabled={busy} onClick={() => onLink(d)} data-testid="receipt-link"
        className="shrink-0 px-2 py-1 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50">
        {busy ? '…' : 'Apparier'}
      </button>
    </div>
  )
}

function ReceiptCard({ txn, receipts, ambiguous, onChanged }) {
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  const [found, setFound] = useState(null)

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setFound(null); return undefined }
    const t = setTimeout(() => {
      api.bank.receiptSearch(txn.id, term).then(r => setFound(r?.candidates || [])).catch(() => setFound([]))
    }, 250)
    return () => clearTimeout(t)
  }, [q, txn.id])

  const link = async (d) => {
    setBusy(d.id); setError(null)
    try {
      await api.bank.match(txn.id, { matched_type: d.type, matched_id: String(d.id), push_qb: false })
      invalidate('/bank')
      await onChanged()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  const list = found ?? receipts
  const unsure = ambiguous || !receipts.length || receipts[0]?.verdict !== 'sure'

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2" data-testid="dossier-receipts">
      <div className="flex items-center gap-2">
        <FileText size={13} className="text-slate-500 shrink-0" />
        <span className="text-xs font-medium text-slate-700">Reçu</span>
        {ambiguous && <span className="text-[11px] text-amber-600">plusieurs se ressemblent — à choisir</span>}
      </div>
      {list.map((d) => (
        <ReceiptRow key={`${d.type}:${d.id}`} d={d} busy={busy === d.id} onLink={link} />
      ))}
      {!list.length && <div className="text-xs text-slate-400">Aucun reçu ne correspond.</div>}
      {unsure && (
        <label className="flex items-center gap-2 text-[11px] text-slate-400">
          Chercher
          <input value={q} onChange={(e) => setQ(e.target.value)} onClick={(e) => e.stopPropagation()}
            data-testid="receipt-search"
            className="grow text-xs border border-slate-200 rounded-lg px-2 py-1 text-slate-700" />
        </label>
      )}
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  )
}

// Le paiement émis passé au compte : rien à comptabiliser, mais il nomme la
// ligne mieux que le relevé.
function PaymentLine({ payment, currency }) {
  return (
    <div className="text-xs text-slate-500" data-testid="dossier-payment">
      Paiement émis · {payment.label || payment.method || 'sortie'} · {money(payment.amount, currency)} du {fmtDate(payment.payment_date)}
    </div>
  )
}

// L'écriture QuickBooks de la ligne, à un clic depuis le tableau.
function QbLink({ txn }) {
  if (!txn.qb_url) return null
  return (
    <a href={txn.qb_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
      title={txn.qb_match_method
        ? `Ouvrir dans QuickBooks — retrouvée par ${MATCH_METHOD[txn.qb_match_method] || txn.qb_match_method}${txn.qb_match_rate ? ` ${txn.qb_match_rate}` : ''}${txn.qb_match_account ? ` (${txn.qb_match_account})` : ''}${txn.qb_match_delta ? `, écart de ${txn.qb_match_delta.toFixed(2)} $` : ''}`
        : 'Ouvrir dans QuickBooks'}
      className={`shrink-0 ${txn.qb_match_delta ? 'text-amber-500' : 'text-slate-300'} hover:text-brand-600`}>
      <ExternalLink size={12} />
    </a>
  )
}

// « X » — la ligne part à la relecture de Michel. Le classeur TRX_Orisha a
// cette colonne depuis toujours (légende « Trx non révisée (Mike) ») : la
// marque posée ici s'y recopie à la même place, et un X déjà écrit là-bas
// remonte ici au premier passage.
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
  // Ce que la ligne porte d'autre qu'une facture : versement de dette, paie,
  // paiement émis. Chacun s'ouvre ici plutôt que sur sa page.
  const { dossier, reload: reloadDossier } = useDossier(txn.id)

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
      </div>

      {/* Ce qui attend une décision, puis l'écriture une fois confirmée. */}
      <ProposalCards txn={txn} currency={currency} onChanged={onChanged} />

      {/* Écriture QuickBooks retrouvée : on la lit ici, on confirme ici. */}
      {txn.qb_txn_id && <QbEntryCard txn={txn} currency={currency} onChanged={onChanged} />}

      {dossier?.debt && (
        <DebtCard data={dossier.debt}
          onPublished={async () => { await reloadDossier(); invalidate('/bank'); await onChanged() }} />
      )}
      {dossier?.paie && <PaieCard paie={dossier.paie} onChanged={onChanged} />}
      {Array.isArray(dossier?.invoices) && (
        <InvoiceCard txn={txn} invoices={dossier.invoices} ambiguous={dossier.invoices_ambiguous}
          currency={currency} onChanged={onChanged} />
      )}
      {dossier?.receipts?.length > 0 && (
        <ReceiptCard txn={txn} receipts={dossier.receipts} ambiguous={dossier.receipts_ambiguous}
          onChanged={onChanged} />
      )}
      {dossier?.payment && <PaymentLine payment={dossier.payment} currency={currency} />}

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
          <div><MatchedDocument txn={txn} doc={dossier?.document} onChanged={onChanged} />
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
                <div className="text-xs text-slate-500">{fmtDate(s.date)} · {money(s.total, currency)} · {Math.round(s.confidence * 100)} %{s.quickbooks_id ? ' · publié dans QuickBooks' : ''}</div>
              </div>
              <button className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50" disabled={busy}
                onClick={() => act(() => api.bank.match(txn.id, { matched_type: s.type, matched_id: s.id }))}>
                <Link2 size={12} /> Lier
              </button>
            </div>
          ))}
        </div>
      )}

      {!txn.transfer_txn_id && (
        <div className="space-y-1.5">
          {!txn.matched_id && <VendorPatternForm txn={txn} onSaved={onChanged} />}
          {/* Après avoir comptabilisé une ligne, c'est LE moment d'en faire une
              règle : la façon de faire est encore sous les yeux. */}
          <RuleFromTxnForm txn={txn} />
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
  const [msg, setMsg] = useState(null)

  const accountId = account?.id

  useEffect(() => {
    if (!accountId) { setSummary(null); return }
    let alive = true
    api.bank.summary(accountId).then((s) => { if (alive) setSummary(s) }).catch(() => { if (alive) setSummary(null) })
    return () => { alive = false }
  }, [accountId, refreshKey])

  // La comparaison QuickBooks tape sur l'API Intuit : elle se charge d'elle-même
  // à l'ouverture du compte, puis après « Mettre à jour » ou une accalmie du
  // temps réel. Côté serveur, le grand livre est mis en cache 5 minutes.
  const loadQb = useCallback(async () => {
    if (!accountId || !account?.qb_account_id) { setQb(null); return }
    setQbLoading(true); setQbError(null)
    try { setQb(await api.bank.qbCompare(accountId)) } catch (e) { setQbError(e.message); setQb(null) } finally { setQbLoading(false) }
  }, [accountId, account?.qb_account_id])

  useEffect(() => { setQb(null); setQbError(null); setMsg(null); loadQb() }, [loadQb])

  // « Mettre à jour » : apparier aux documents de l'ERP, vérifier dans
  // QuickBooks, recalculer l'écart. Un seul bouton, une seule route.
  const runUpdate = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await api.bank.updateAll(accountId)
      setMsg(r?.message || null)
      await onChanged()
      await loadQb()
    } catch (e) {
      setMsg(`Échec : ${e.message}`)
    } finally { setBusy(false) }
  }

  const onMerged = async () => { await onChanged() }

  return { summary, qb, qbLoading, qbError, loadQb, busy, runUpdate, msg, onMerged }
}

// Robot « Rapprocher » de QuickBooks : coche les lignes vertes, lit la
// Différence, enregistre pour plus tard — ne termine jamais (c'est Charles qui
// ferme le mois). Le passage dure une à deux minutes : on relit jusqu'à la fin.
function useQbRobot(accountId, flash) {
  const [state, setState] = useState({ running: false, last: null })
  const load = useCallback(async () => {
    if (!accountId) return
    const s = await api.bank.qbReconcileLast(accountId).catch(() => null)
    if (s) setState(s)
  }, [accountId])
  useEffect(() => { setState({ running: false, last: null }); load() }, [load])
  useEffect(() => {
    if (!state.running) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [state.running, load])
  const run = async () => {
    try {
      await api.bank.qbReconcileRun(accountId)
      setState((s) => ({ ...s, running: true }))
    } catch (e) { flash(e.message) }
  }
  return { ...state, run }
}

const withToken = (url) => `${url}?token=${encodeURIComponent(localStorage.getItem('erp_token') || '')}`

// « QB 0 $ ✓ » / « QB −12,34 $ » : la Différence lue au dernier passage du
// robot ; la capture en lien, le détail en infobulle.
function QbRobotPill({ robot, currency }) {
  const last = robot.last
  const base = 'text-[11px] px-1.5 py-0.5 rounded-full whitespace-nowrap tabular-nums'
  if (robot.running) return <span data-testid="qb-robot-pill" className={`${base} bg-slate-100 text-slate-500 animate-pulse`}>QB …</span>
  if (!last) return null
  const d = last.difference
  const zero = last.ok && d != null && Math.abs(d) < 0.01
  const title = last.ok
    ? [
        last.statement_date ? `au ${fmtDate(last.statement_date)}` : null,
        `${last.checked} cochée(s)`,
        last.already_checked ? `${last.already_checked} déjà cochée(s)` : null,
        last.unmatched_boreal.length ? `${last.unmatched_boreal.length} verte(s) absente(s) de QB` : null,
        last.unmatched_qb.length ? `${last.unmatched_qb.length} écriture(s) QB sans ligne verte` : null,
        last.saved ? 'enregistré pour plus tard' : 'non enregistré',
      ].filter(Boolean).join(' · ')
    : (last.error || 'échec')
  const label = !last.ok ? (last.needs_session ? 'QB session' : 'QB ⚠')
    : d == null ? 'QB ?' : zero ? 'QB 0 $ ✓' : <>QB {money(d, currency)}</>
  const cls = !last.ok || d == null ? 'bg-amber-50 text-amber-700' : zero ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
  const body = <>{label}{last.ok && !last.saved ? ' !' : ''}</>
  return last.screenshot_url
    ? <a href={withToken(last.screenshot_url)} target="_blank" rel="noreferrer" title={title} data-testid="qb-robot-pill" className={`${base} ${cls} hover:underline`}>{body}</a>
    : <span title={title} data-testid="qb-robot-pill" className={`${base} ${cls}`}>{body}</span>
}

// Une ligne, trois nombres : le solde du relevé, celui de QuickBooks, et
// l'écart entre les deux — c'est le seul chiffre qui commande une action.
function EcartBar({ account, rec, robot }) {
  const { summary, qb, qbLoading, qbError, msg } = rec
  if (!account) return null
  const stmt = summary?.statement
  const bal = qb?.balance && !qb.balance.error ? qb.balance : null
  const diff = bal?.difference
  const ok = diff != null && Math.abs(diff) < 0.01
  const currency = account.currency

  // Un seul chiffre affiché (2026-09-15) : les deux soldes qui le produisent
  // sont dans l'infobulle — c'est l'écart, et lui seul, qui commande une action.
  const detail = [
    `Relevé ${stmt?.printed_balance_signed != null ? money(stmt.printed_balance_signed, currency) : '—'}`,
    `QuickBooks ${bal ? money(bal.qb_as_of, currency) : account.qb_account_id ? '—' : 'non mappé'}`,
    stmt?.date ? `soldes au ${fmtDate(stmt.date)}` : null,
    bal && Math.abs(bal.qb_current - bal.qb_as_of) >= 0.01 ? `solde QuickBooks aujourd'hui ${money(bal.qb_current, currency)}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <div data-testid="reconcile-panel" title={detail}
      data-statement-balance={stmt?.printed_balance_signed != null ? money(stmt.printed_balance_signed, currency) : ''}
      data-qb-balance={bal ? money(bal.qb_as_of, currency) : ''}
      className="flex items-baseline gap-x-1.5 text-xs min-w-0">
      <span className="text-slate-400">Écart</span>
      <span data-testid="reconcile-difference"
        className={`text-sm font-semibold tabular-nums ${diff == null ? 'text-slate-300' : ok ? 'text-green-700' : 'text-red-700'}`}>
        {qbLoading ? '…' : diff == null ? '—' : money(diff, currency)}
      </span>
      {robot && <QbRobotPill robot={robot} currency={currency} />}
      {qbError && <span className="text-[11px] text-amber-700 truncate">QuickBooks indisponible</span>}
      {msg && <span className="text-[11px] text-slate-400 truncate">{msg}</span>}
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

// Couleur peinte à la main dans TRX_Orisha du temps où ce fichier était la
// source. Donnée HISTORIQUE figée (2024-2025) : plus personne ne peint rien,
// mais elle reste une preuve pour les lignes de cette époque.
const SHEET_COLOR_META = {
  vert: { dot: 'bg-green-500', label: 'Fichier : rapprochée avec la banque' },
  jaune: { dot: 'bg-yellow-400', label: 'Fichier : comptabilisée' },
  bleu: { dot: 'bg-sky-400', label: 'Fichier : facture retracée' },
  rouge: { dot: 'bg-red-300', label: 'Fichier : pas encore comptabilisée' },
}

// Comment le fournisseur a été reconnu derrière le libellé du relevé.
const VENDOR_VIA = { motif: 'un motif de relevé', alias: 'un alias', nom: 'son nom' }

// Comment l'écriture QuickBooks a été retrouvée (services/bankQbSearch.js).
const MATCH_METHOD = {
  exact: 'montant et date exacts',
  fenetre: 'même montant, date décalée',
  devise: 'montant en devise du compte',
  tolerance: 'montant proche (frais ou conversion)',
  conversion: 'conversion de devise (taux vérifié)',
  devise_taux: 'écriture en devise étrangère (taux vérifié)',
  autre_compte: 'écriture portée à un autre compte',
  agregat: 'plusieurs écritures QuickBooks',
  agregat_inverse: 'écriture QuickBooks partagée avec d\'autres lignes',
}



// Ce qui n'est pas « Mettre à jour » tient dans le menu « ⋯ » en bout de barre :
// déposer un relevé, et les deux gestes du classeur Google. La page n'a plus
// d'en-tête (2026-09-15). Les entrées « Relire TRX_Orisha » et « Détail
// TRX_Orisha » ont disparu avec la lecture du fichier, « Recalculer
// QuickBooks » et « Chercher dans tout QuickBooks » avec le bouton unique.
function MenuItem({ icon, label, hint, onClick, disabled, href, testId }) {
  const cls = 'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-left text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent'
  const body = (
    <>
      <span className="text-slate-400 shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="text-[11px] text-slate-400 shrink-0">{hint}</span>}
    </>
  )
  if (href) {
    return <a href={href} target="_blank" rel="noreferrer" className={cls} data-testid={testId}>{body}</a>
  }
  return <button type="button" className={cls} data-testid={testId} disabled={disabled} onClick={onClick}>{body}</button>
}

function MoreMenu({ onDrop, onRules, flash, robot }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const mirror = useMirror(flash)

  useEffect(() => {
    if (!open) return
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const run = (fn) => () => { setOpen(false); fn() }

  return (
    <div className="relative" ref={ref}>
      <button type="button" data-testid="rapprochement-more" aria-label="Autres actions"
        onClick={() => setOpen((v) => !v)}
        className={`relative inline-flex items-center justify-center w-7 h-7 rounded-md border transition-colors ${open
          ? 'bg-slate-100 border-slate-300 text-slate-700'
          : 'border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}>
        <MoreHorizontal size={15} />
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-30 w-72 rounded-lg border border-slate-200 bg-white shadow-lg p-1">
          <MenuItem icon={<FileUp size={14} />} label="Déposer un relevé"
            testId="statement-drop" onClick={run(onDrop)} />
          <MenuItem icon={<Wand2 size={14} />} label="Règles bancaires"
            testId="reconcile-rules-link" onClick={run(onRules)} />
          {robot && <MenuItem icon={<CheckCheck size={14} className={robot.running ? 'animate-pulse' : ''} />}
            label="Préparer dans QuickBooks" testId="qb-robot-run" disabled={robot.running} onClick={run(robot.run)} />}
          <MenuItem icon={<Table2 size={14} className={mirror.busy ? 'animate-pulse' : ''} />}
            label="Recopier dans le classeur" disabled={mirror.busy} onClick={mirror.run} />
          {mirror.url && <MenuItem icon={<ExternalLink size={14} />} label="Ouvrir le classeur" href={mirror.url} />}
        </div>
      )}
    </div>
  )
}

// Le compte : un bouton-titre dans la barre d'outils, plus une rangée de 13
// onglets. Recherche dès qu'il y a de quoi chercher (règle des >10 options).
// ── Page ─────────────────────────────────────────────────────────────────────

// Trois files, comme « Opérations bancaires » de QuickBooks : ce qui demande
// encore un geste, ce qui est classé, ce qu'on a mis de côté.
// Les trois files « À réviser / Catégorisées / Exclues » ont disparu le
// 2026-09-12 : une seule liste continue, comme le fichier, et la légende des
// couleurs fait le filtre. Un compteur à zéro n'est pas cliquable — sinon la
// liste se viderait et DataTable afficherait son écran « aucune transaction ».
function StatusLegend({ counts, value, onChange, onRequests }) {
  const chip = (key, label, hint, tint, n) => (
    <button key={key} type="button" data-testid={`reconcile-legend-${key}`}
      aria-pressed={value === key} aria-label={`${label} — ${n}`} title={hint}
      disabled={n === 0} onClick={() => onChange(value === key ? null : key)}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors disabled:opacity-40 disabled:cursor-default ${value === key
        ? 'bg-slate-100 ring-1 ring-slate-300 text-slate-900 font-medium'
        : 'text-slate-500 hover:bg-slate-50'}`}>
      <span className={`w-2.5 h-2.5 rounded-[3px] border border-black/10 ${tint}`} />
      <span className="whitespace-nowrap">{label}</span>
      <span className="tabular-nums text-slate-400">{n}</span>
    </button>
  )
  return (
    <div role="group" aria-label="Filtrer par statut" className="flex items-center gap-x-0.5 py-1">
      {LEGEND_ORDER.map((k) => chip(k, STATUS_META[k].label, STATUS_META[k].hint, STATUS_META[k].tint, counts[k] || 0))}
      {counts.ghost > 0 && chip('ghost', GHOST_META.label, GHOST_META.hint, GHOST_META.tint, counts.ghost)}
      {/* Pas une couleur du fichier : ce que les moteurs proposent et qui
          attend un clic. Posée à la suite, séparée par un filet. */}
      {/* Sortie d'argent sans pièce justificative : le vrai « il manque une
          facture ». Posée ici plutôt que sur une page à part — c'est le relevé
          qui la porte, et le dossier de la ligne donne la suite (chercher au
          portail, apprendre le fournisseur, déposer la facture). */}
      {counts.missing > 0 && (
        <button type="button" data-testid="reconcile-legend-missing"
          aria-pressed={value === 'missing'} title="Sorties d'argent sans facture"
          onClick={() => onChange(value === 'missing' ? null : 'missing')}
          className={`ml-2 pl-3 border-l border-slate-200 inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ${value === 'missing'
            ? 'bg-amber-100 text-amber-900 font-medium'
            : 'text-amber-700 hover:bg-amber-50'}`}>
          <FileWarning size={12} />
          <span className="tabular-nums">{counts.missing}</span> sans facture
        </button>
      )}
      {/* Ce que Charles réclame lui-même : le nombre ouvre le panneau, où se
          prépare le message Slack. */}
      {counts.requested > 0 && (
        <span className="ml-2 pl-3 border-l border-slate-200 inline-flex items-center gap-0.5">
          <button type="button" data-testid="reconcile-legend-requested"
            aria-pressed={value === 'requested'} title="Factures demandées"
            onClick={() => onChange(value === 'requested' ? null : 'requested')}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ${value === 'requested'
              ? 'bg-amber-100 text-amber-900 font-medium'
              : 'text-amber-700 hover:bg-amber-50'}`}>
            <Flag size={12} />
            <span className="tabular-nums">{counts.requested}</span> demandées
          </button>
          <button type="button" data-testid="reconcile-requests-open" title="Ouvrir le panneau des factures demandées"
            onClick={onRequests} className="px-1.5 py-1 rounded-md text-amber-700 hover:bg-amber-50">
            <Send size={12} />
          </button>
        </span>
      )}
      {counts.proposals > 0 && (
        <button type="button" data-testid="reconcile-legend-proposals"
          aria-pressed={value === 'proposals'} title="Propositions à confirmer"
          onClick={() => onChange(value === 'proposals' ? null : 'proposals')}
          className={`ml-2 pl-3 border-l border-slate-200 inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ${value === 'proposals'
            ? 'bg-brand-100 text-brand-800 font-medium'
            : 'text-brand-700 hover:bg-brand-50'}`}>
          <Wand2 size={12} />
          <span className="tabular-nums">{counts.proposals}</span> à confirmer
        </button>
      )}
    </div>
  )
}

function TransactionComment({ txn, onSave }) {
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const cancelled = useRef(false)

  const save = async () => {
    if (saving.current || cancelled.current || draft === null) return
    if (draft === (txn.comment || '')) { setDraft(null); return }
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      await onSave(txn.id, draft || null)
      setDraft(null)
    } catch (e) {
      setError(e.message || 'Enregistrement impossible')
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  return (
    <div className="-mx-4 px-4 min-h-8 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {draft === null ? (
        <button type="button" className="w-full min-h-8 text-left truncate cursor-text hover:bg-white/50"
          aria-label="Modifier le commentaire" title={txn.comment || 'Ajouter un commentaire'}
          onClick={() => { cancelled.current = false; setError(null); setDraft(txn.comment || '') }}>
          {txn.comment || '—'}
        </button>
      ) : (
        <>
          <input autoFocus aria-label="Commentaire" aria-invalid={!!error} aria-busy={busy}
            className={`w-full min-w-0 rounded border px-1 py-0.5 text-sm outline-none focus:ring-1 focus:ring-brand-500 ${error ? 'border-red-500' : 'border-brand-500'}`}
            value={draft} readOnly={busy} onChange={(e) => setDraft(e.target.value)} onBlur={save}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter') { e.preventDefault(); save() }
              if (e.key === 'Escape' && !saving.current) {
                e.preventDefault(); cancelled.current = true; setDraft(null); setError(null)
              }
            }} />
          {error && <span role="alert" className="text-xs text-red-600 truncate" title={error}>{error}</span>}
        </>
      )}
    </div>
  )
}

// ── Grammaire QuickBooks dans la vue relevé ────────────────────────────────
// Choix de Charles (2026-09-19) : une seule vue. Le relevé garde ses couleurs
// et ses pastilles, et porte les gestes de QuickBooks — le bouton du geste
// attendu sur chaque ligne, et l'écriture qui s'ouvre sous la ligne. Un clic
// humain par écriture : pas de publication en lot (décision du 2026-09-12).

// Ce que la ligne attend, dit sur la ligne elle-même (maquette B3) : le bouton
// porte le geste, et le dépliage s'ouvre déjà dessus.
const NEXT_META = {
  virement: { label: 'Lier le virement', pane: 'transfer', cls: 'bg-brand-600 text-white hover:bg-brand-700' },
  apparier: { label: 'Apparier', pane: 'match', cls: 'bg-brand-600 text-white hover:bg-brand-700' },
  publier: { label: 'Publier', pane: 'add', cls: 'bg-brand-600 text-white hover:bg-brand-700' },
  comptabiliser: { label: 'Comptabiliser', pane: 'publish', cls: 'bg-brand-600 text-white hover:bg-brand-700' },
  rien: { label: 'Ouvrir', pane: 'add', cls: 'border border-slate-300 text-slate-600 hover:bg-white' },
}

// « Apparier » : les documents au même montant, et le bouton qui lie.
function QbMatchPane({ txn, currency, onChanged }) {
  const [items, setItems] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    api.bank.suggestions(txn.id)
      .then((r) => { if (alive) setItems(r) })
      .catch((e) => { if (alive) { setItems([]); setError(e.message) } })
    return () => { alive = false }
  }, [txn.id])

  const link = async (s) => {
    setBusy(true); setError(null)
    try {
      const r = await api.bank.match(txn.id, { matched_type: s.type, matched_id: s.id })
      invalidate('/bank')
      await onChanged()
      // L'appariement est posé même si QuickBooks refuse : on le dit, le geste
      // reste rejouable depuis la ligne.
      if (r?.qbError) setError(`Lié, mais pas publié dans QuickBooks — ${r.qbError}`)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-2 text-sm">
      {items == null && <div className="text-slate-400 text-xs">Recherche…</div>}
      {items?.length === 0 && (
        <div className="text-xs text-slate-500">Aucun document au même montant à ±7 jours — souvent une facture manquante.</div>
      )}
      {items?.map((s) => (
        <div key={`${s.type}:${s.id}`} className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2">
          <div className="min-w-0">
            <div className="truncate">{docLink(s.type, s.id, s.label)}</div>
            <div className="text-xs text-slate-500">
              {fmtDate(s.date)} · {money(s.total, currency)} · {Math.round(s.confidence * 100)} %{s.quickbooks_id ? ' · publié dans QuickBooks' : ''}
            </div>
          </div>
          <button type="button" disabled={busy}
            className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            onClick={() => link(s)}><Link2 size={12} /> Lier</button>
        </div>
      ))}
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  )
}

// Le document est apparié mais son écriture n'est jamais partie : ce bouton la
// fait partir. Un clic humain, comme partout ailleurs.
function PublishMatchedButton({ txn, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const go = async () => {
    setBusy(true); setError(null)
    try {
      await api.bank.publishMatched(txn.id)
      invalidate('/bank')
      await onChanged()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return (
    <span className="flex items-center gap-2 min-w-0">
      <button type="button" disabled={busy} onClick={go}
        className="shrink-0 px-2 py-1 rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50">
        {busy ? 'Publication…' : 'Comptabiliser dans QuickBooks'}
      </button>
      {error && <span className="truncate text-red-600" title={error}>{error}</span>}
    </span>
  )
}

// Ce que la ligne dépliée montre : le geste attendu, ouvert d'emblée, et les
// autres à un clic. Rien à préparer ⇒ on dit pourquoi, court.
// Les deux marques de Michel, au bout des doigts en tête de ligne : le rond
// rouge au crayon (« à réviser », recopié en X dans TRX_Orisha) et le signet
// orange (où il s'est arrêté — un seul par compte). Discrètes jusqu'au survol,
// bien visibles une fois posées.
// Les factures que Charles réclame : la liste, et le message qui part sur
// Slack. Décocher une ligne la sort de l'envoi — elle reste réclamée.
function InvoiceRequestsPanel({ onChanged }) {
  const [rows, setRows] = useState(null)
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  const apply = (res) => { setRows(res.requests || []); setMessage(res.message || null) }
  useEffect(() => { api.bank.invoiceRequests().then(apply).catch((e) => setError(e.message)) }, [])

  const act = async (fn) => {
    setBusy(true); setError(null); setDone(null)
    try { apply(await fn()) } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const send = async () => {
    setBusy(true); setError(null)
    try {
      const res = await api.bank.sendInvoiceRequests()
      apply(res)
      setDone(`Envoyé — ${res.count} facture${res.count > 1 ? 's' : ''}`)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  if (error && !rows) return <div className="px-5 py-4 text-sm text-red-600">{error}</div>
  if (!rows) return <div className="px-5 py-4 text-sm text-slate-400">Chargement…</div>
  if (!rows.length) return <div className="px-5 py-4 text-sm text-slate-400">Aucune facture demandée.</div>

  const inSend = rows.filter((r) => r.in_send).length
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto px-5 py-3">
        {rows.map((r) => (
          <div key={r.bank_txn_id} className={`flex items-center gap-3 py-2 border-b border-slate-100 ${r.in_send ? '' : 'opacity-50'}`}>
            <input type="checkbox" checked={!!r.in_send} disabled={busy}
              aria-label={r.in_send ? "Retirer de l'envoi" : "Remettre dans l'envoi"}
              onChange={() => act(() => api.bank.setInvoiceRequestInSend(r.bank_txn_id, !r.in_send))}
              className="w-4 h-4 rounded border-slate-300 text-brand-600" />
            <div className="min-w-0 flex-1">
              <div className={`text-sm truncate ${r.in_send ? 'text-slate-800' : 'line-through text-slate-500'}`}>{r.vendor}</div>
              <div className="text-xs text-slate-400 truncate">
                {fmtDate(r.txn_date)} · {r.account_name} · {r.age_days} j{r.last_sent_at ? ' · déjà demandée' : ''}
              </div>
            </div>
            <span className="text-sm tabular-nums text-slate-700">{r.amount_label}</span>
            <button type="button" disabled={busy} title="Retirer de la liste"
              onClick={() => act(async () => { const res = await api.bank.removeInvoiceRequest(r.bank_txn_id); onChanged?.(); return res })}
              className="text-slate-300 hover:text-red-600"><X size={14} /></button>
          </div>
        ))}
        {message && <pre className="mt-3 whitespace-pre-wrap text-xs text-slate-600 bg-slate-50 rounded-lg p-3">{message}</pre>}
      </div>
      <div className="px-5 py-3 border-t border-slate-200 flex items-center gap-3">
        <button type="button" disabled={busy || !inSend} onClick={send}
          data-testid="invoice-requests-send"
          className="px-3 py-1.5 rounded-md bg-brand-600 text-white text-sm hover:bg-brand-700 disabled:opacity-50">
          {busy ? 'Envoi…' : `Envoyer ${inSend} facture${inSend > 1 ? 's' : ''}`}
        </button>
        {done && <span className="text-xs text-green-700">{done}</span>}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  )
}

function RowMarks({ row, bookmarked, onReview, onBookmark }) {
  const [busy, setBusy] = useState(false)
  const red = !!row.review_flag
  const run = (fn) => async (e) => {
    e.stopPropagation()
    setBusy(true)
    try { await fn() } finally { setBusy(false) }
  }
  return (
    <span className="lg-marks flex items-center justify-center gap-1.5 h-full">
      <button type="button" disabled={busy} data-testid="review-mark" aria-pressed={red}
        aria-label={red ? 'Retirer « à réviser »' : 'À réviser'} title={red ? 'Retirer « à réviser »' : 'À réviser'}
        onClick={run(() => onReview(row, !red))} className="lg-mark-pen" />
      <button type="button" disabled={busy} data-testid="row-bookmark" aria-pressed={bookmarked}
        aria-label={bookmarked ? 'Retirer le signet' : 'Poser le signet ici'} title={bookmarked ? 'Retirer le signet' : 'Poser le signet ici'}
        onClick={run(() => onBookmark(bookmarked ? null : row.id))} className="lg-mark-ribbon" />
    </span>
  )
}

// Les comptes en onglets au pied de la page, comme les feuilles d'un classeur.
// Le rond rouge compte les lignes que Michel a encore à réviser.
// Pseudo-compte : tout ce qui n'est pas encore comptabilisé, tous comptes
// confondus, dans le même tableau (demande de Charles, 2026-09-27).
const TODO_TAB = '__todo__'
const TODO_STATUSES = new Set(['a_traiter', 'facture_recue'])
// Les années closes n'y figurent plus (Charles, 2026-09-27 : « 2025, ça pu rapport »).
const TODO_SINCE = '2026-01-01'

function AccountTabs({ accounts, accountId, onChange }) {
  const todo = accounts.reduce((n, a) => n + (a.todo_count || 0), 0)
  return (
    <nav aria-label="Comptes" data-testid="account-tabs"
      className="lg-tabs flex items-stretch overflow-x-auto">
      <button type="button" data-testid="account-tab-todo" onClick={() => onChange(TODO_TAB)}
        aria-current={accountId === TODO_TAB ? 'page' : undefined} title="Tous les comptes"
        className={`lg-tab shrink-0 flex items-center gap-2 px-4 whitespace-nowrap ${accountId === TODO_TAB ? 'lg-tab-on' : ''}`}>
        À comptabiliser
        {todo > 0 && <span className="lg-count">{todo}</span>}
      </button>
      {accounts.map((a) => (
        <button key={a.id} type="button" onClick={() => onChange(a.id)} aria-current={a.id === accountId ? 'page' : undefined}
          title={[a.institution, a.account_number, a.currency].filter(Boolean).join(' · ')}
          className={`lg-tab shrink-0 flex items-center gap-2 px-4 whitespace-nowrap ${a.id === accountId ? 'lg-tab-on' : ''}`}>
          {a.name}
          {a.review_count > 0 && <span className="lg-count" data-testid="account-review-count">{a.review_count}</span>}
        </button>
      ))}
    </nav>
  )
}

// Ce que la ligne porte et qui se comptabilise déjà tout seul (dette, paie,
// assurance collective, pièce ou facture retrouvée) : la ligne dépliée l'ouvre
// d'emblée, sans passer par le dossier complet (demande de Charles, 2026-09-27).
function dossierFocus(d) {
  if (!d) return null
  if (d.debt && !d.debt.payment?.pushed_at && !d.debt.payment?.qb_txn_id) return { key: 'debt', label: 'Dette' }
  if (d.paie && !d.paie.booked) return { key: 'paie', label: 'Paie' }
  if (d.aga) return { key: 'aga', label: 'Assurance' }
  if (d.invoices?.length) return { key: 'invoices', label: 'Facture' }
  if (d.receipts?.length) return { key: 'receipts', label: 'Reçu' }
  return null
}

function DossierFocus({ txn, currency, focus, dossier, reload, onChanged }) {
  const after = async () => { await reload(); invalidate('/bank'); await onChanged() }
  if (focus.key === 'debt') return <DebtCard data={dossier.debt} onPublished={after} />
  if (focus.key === 'paie' || focus.key === 'aga') {
    return (
      <Suspense fallback={<PanelFallback />}>
        {focus.key === 'paie' ? <PaiePanel paieId={dossier.paie.id} /> : <AgaPanel debit={dossier.aga} />}
      </Suspense>
    )
  }
  if (focus.key === 'invoices') {
    return <InvoiceCard txn={txn} invoices={dossier.invoices} ambiguous={dossier.invoices_ambiguous} currency={currency} onChanged={onChanged} />
  }
  return <ReceiptCard txn={txn} receipts={dossier.receipts} ambiguous={dossier.receipts_ambiguous} onChanged={onChanged} />
}

function QbRowExpansion({ txn, currency, next, onChanged, onOpenPanel, collapse }) {
  // Une ligne qui porte une proposition s'ouvre dessus : c'est le geste que la
  // page attend d'abord, avant celui que `next-actions` a calculé.
  const ready = txn.proposal_count > 0
  const [pane, setPane] = useState(ready ? 'ready' : NEXT_META[next?.kind || 'rien'].pane)
  // « Exclure » a quitté cette barre (2026-09-29) : on l'y touchait par accident.
  const { dossier, reload } = useDossier(txn._ghost ? null : txn.id)
  const focus = dossierFocus(dossier)
  // Le dossier arrive après le dépliage : s'il porte quelque chose de
  // comptabilisable, c'est ce volet qui s'ouvre (sauf proposition ou choix fait).
  const touched = useRef(false)
  useEffect(() => {
    if (focus && !ready && !touched.current) setPane('dossier')
  }, [focus?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  if (txn._ghost) {
    return <div className="px-4 py-3 text-xs text-slate-500">Écriture QuickBooks sans ligne au relevé.</div>
  }

  // Confirmée : la ligne change de couleur et le dépliage se referme.
  const proposalDone = async () => { await onChanged(); collapse() }

  const settled = txn.matched_id || txn.transfer_txn_id || txn.status === 'rapproche' || txn.status === 'ignore'
  if (settled) {
    // Réglée mais encore porteuse d'une proposition ouverte : on la montre
    // quand même, sinon elle n'est atteignable que par le panneau latéral.
    return (
      <div className="px-4 py-3 space-y-3 max-w-5xl">
        {ready && <ProposalCards txn={txn} currency={currency} onChanged={proposalDone} />}
        {!ready && focus && (
          <DossierFocus txn={txn} currency={currency} focus={focus} dossier={dossier} reload={reload} onChanged={onChanged} />
        )}
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {txn.matched_id
            ? <span className="flex items-center gap-1.5">{docLink(txn.matched_type, txn.matched_id, txn.matched_label)}<QbLink txn={txn} /></span>
            : <span>{STATUS_META[bucketOf(txn)].hint}</span>}
          {next?.kind === 'comptabiliser' && <PublishMatchedButton txn={txn} onChanged={onChanged} />}
          <button type="button" className="px-2 py-1 rounded border border-slate-300 hover:bg-white"
            onClick={() => onOpenPanel(txn)}>Ouvrir le dossier</button>
        </div>
        {!txn.transfer_txn_id && txn.status !== 'ignore' && <RuleFromTxnForm txn={txn} />}
      </div>
    )
  }

  // Maquette L5 (choix de Charles, 2026-09-29) : la barre de QuickBooks —
  // trois onglets soulignés, celui que la ligne appelle déjà ouvert.
  const GESTURES = [
    { key: 'add', label: 'Catégoriser', show: txn.amount < 0 },
    { key: 'match', label: 'Trouver une correspondance', show: true },
    { key: 'transfer', label: 'Enregistrer comme transfert', show: true },
  ].filter((g) => g.show)

  // La bande verte de QuickBooks : ce que Boréal a déjà trouvé pour cette
  // ligne, dit avant les onglets (demande de Charles, 2026-09-29).
  const found = ready
    ? (txn.proposal_count > 1 ? `${txn.proposal_count} propositions prêtes` : 'Proposition prête')
    : focus ? `Correspondance trouvée · ${focus.label}`
      : next?.kind === 'virement' ? 'Virement interne reconnu'
        : next?.label ? next.label : null
  const banner = [found, txn.rule_name ? `Règle « ${txn.rule_name} »` : null].filter(Boolean).join(' · ')

  const tab = (key, label) => (
    <button key={key} type="button" onClick={() => { touched.current = true; setPane(key) }} aria-pressed={pane === key}
      className={`px-3 py-1.5 text-xs border-b-2 -mb-px ${pane === key
        ? 'border-brand-600 text-slate-900 font-medium'
        : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
      {label}
    </button>
  )

  return (
    <div className="px-4 py-3 space-y-3 max-w-5xl">
      {banner && (
        <div className="flex items-center gap-2 rounded-lg bg-green-50 text-green-800 px-3 py-1.5 text-xs">
          <CheckCheck size={13} className="shrink-0" /> {banner}
        </div>
      )}
      <div className="flex items-center gap-1 flex-wrap border-b border-slate-200">
        {ready && tab('ready', 'Prêt')}
        {focus && tab('dossier', focus.label)}
        {GESTURES.map((g) => tab(g.key, g.label))}
        <button type="button" onClick={() => onOpenPanel(txn)}
          className="ml-auto px-2 py-1 text-xs rounded-md text-slate-500 hover:bg-white/60">Dossier complet</button>
      </div>

      {pane === 'dossier' && focus && (
        <DossierFocus txn={txn} currency={currency} focus={focus} dossier={dossier} reload={reload} onChanged={onChanged} />
      )}
      {pane === 'ready' && ready && (
        <ProposalCards txn={txn} currency={currency} onChanged={proposalDone} />
      )}
      {pane === 'add' && txn.amount < 0 && (
        <AddExpenseForm txn={txn} currency={currency} onDone={() => { collapse(); onChanged() }} onCancel={collapse} />
      )}
      {pane === 'add' && txn.amount > 0 && (
        <div className="text-xs text-slate-500">Une entrée ne se comptabilise pas en dépense — l'apparier à un dépôt ou à un virement.</div>
      )}
      {pane === 'match' && <QbMatchPane txn={txn} currency={currency} onChanged={async () => { collapse(); await onChanged() }} />}
      {pane === 'transfer' && (
        <TransferForm txn={txn} currency={currency} onDone={() => { collapse(); onChanged() }} onCancel={collapse} />
      )}

      {/* La règle se crée là où le libellé est sous les yeux, une à la fois —
          l'atelier, lui, les propose en lot. */}
      {!txn.transfer_txn_id && <RuleFromTxnForm txn={txn} />}
    </div>
  )
}

export default function RapprochementBancaire() {
  const navigate = useNavigate()
  const [accounts, setAccounts] = useState([])
  const [accountId, setAccountIdRaw] = useState(null)
  // Compte reflété dans l'URL (?compte=) : le sous-menu de la sidebar peut
  // ouvrir un compte précis, et le lien reste partageable.
  const [params, setParams] = useSearchParams()
  const askedAccount = params.get('compte')
  // « Ouvre CETTE ligne » : le lien vient de la page Propositions. La ligne se
  // déplie sur son volet « Prêt » et défile à l'écran.
  const askedRow = params.get('ligne')
  const setAccountId = useCallback((next) => {
    setAccountIdRaw(prev => {
      const id = typeof next === 'function' ? next(prev) : next
      if (id) setParams((prev) => { const next = new URLSearchParams(prev); next.set('compte', id); return next }, { replace: true })
      return id
    })
  }, [setParams])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [showDrop, setShowDrop] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState(null)
  const [pageDrag, setPageDrag] = useState(false)
  const [notice, setNotice] = useState(null)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [requestsOpen, setRequestsOpen] = useState(false)
  // null = toute la liste ; sinon une clé de STATUS_META ou 'ghost'.
  const [colorFilter, setColorFilter] = useState(null)
  const account = accounts.find((a) => a.id === accountId) || null

  const loadAccounts = useCallback(async () => {
    const list = await api.bank.accounts()
    setAccounts(list)
    // Au chargement : le compte demandé dans l'URL gagne, sinon on garde le
    // courant, sinon le premier. On passe par le setter brut pour ne pas
    // réécrire l'URL quand personne n'a rien demandé.
    setAccountIdRaw((prev) => {
      const wanted = new URLSearchParams(window.location.search).get('compte')
      if (wanted === TODO_TAB || (wanted && list.some((a) => a.id === wanted))) return wanted
      if (prev === TODO_TAB) return prev
      return prev && list.some((a) => a.id === prev) ? prev : (list[0]?.id || null)
    })
  }, [])

  const loadTxns = useCallback(async () => {
    if (!accountId) { setRows([]); setLoading(false); return }
    setLoading(true)
    try {
      if (accountId !== TODO_TAB) { setRows(await api.bank.transactions(accountId)); return }
      const list = await api.bank.accounts()
      const per = await Promise.all(list.filter((a) => a.todo_count > 0).map(async (a) => (
        (await api.bank.transactions(a.id))
          .filter((r) => TODO_STATUSES.has(r.status) && (r.txn_date || '') >= TODO_SINCE)
          .map((r) => ({ ...r, _acct: { id: a.id, name: a.name, currency: a.currency } }))
      )))
      setRows(per.flat().sort((x, y) => String(y.txn_date).localeCompare(String(x.txn_date))))
    } finally { setLoading(false) }
  }, [accountId])

  useEffect(() => { loadAccounts() }, [loadAccounts])
  // URL → état : clic dans le sous-menu alors que la page est déjà ouverte.
  useEffect(() => {
    if (askedAccount && askedAccount !== accountId && (askedAccount === TODO_TAB || accounts.some((a) => a.id === askedAccount))) {
      setAccountIdRaw(askedAccount)
    }
  }, [askedAccount, accounts, accountId])
  useEffect(() => { loadTxns() }, [loadTxns])
  useEffect(() => { setColorFilter(null) }, [accountId])

  // Incrémenté à chaque refresh : le résumé local se recalcule (la comparaison
  // QuickBooks, elle, reste à la demande).
  const [reconcileKey, setReconcileKey] = useState(0)
  const refresh = useCallback(async () => {
    await Promise.all([loadTxns(), loadAccounts()])
    setReconcileKey((k) => k + 1)
  }, [loadTxns, loadAccounts])

  useEffect(() => subscribe('sale_receipt:list', () => {
    invalidate('/bank')
    refresh().catch(() => {})
  }), [refresh])

  const rec = useReconcile(account, reconcileKey, refresh)

  // Le geste attendu par chaque ligne, en un seul appel par compte.
  const [nextActions, setNextActions] = useState({})
  useEffect(() => {
    if (!accountId) { setNextActions({}); return undefined }
    let alive = true
    const ids = accountId === TODO_TAB ? accounts.filter((a) => a.todo_count > 0).map((a) => a.id) : [accountId]
    Promise.all(ids.map((id) => api.bank.nextActions(id)))
      .then((ms) => { if (alive) setNextActions(Object.assign({}, ...ms.map((m) => m || {}))) })
      .catch(() => { if (alive) setNextActions({}) })
    return () => { alive = false }
  }, [accountId, reconcileKey, accountId === TODO_TAB ? accounts : null]) // eslint-disable-line react-hooks/exhaustive-deps

  // Ouverture du panneau depuis un bouton de ligne : quelle ligne, dans quel
  // mode. `null` = le panneau s'ouvre sur sa vue habituelle.
  const [peekOpen, setPeekOpen] = useState({ id: null, mode: null, forId: null })

  // La page bouge toute seule. Une ligne change sans qu'on ait cliqué dessus :
  // la vérification QuickBooks retrouve son écriture, un avis d'Intuit arrive,
  // la facture appariée est publiée. On écoute le canal DU COMPTE affiché — le
  // canal global ferait clignoter la page à cause d'un autre compte.
  //
  // La charge utile ne porte que les colonnes qui bougent : on fusionne sur
  // place. L'écart, lui, appelle QuickBooks : il attend une accalmie de 3 s.
  const liveSoon = useRef(null)
  const liveUnknown = useRef(false)
  useEffect(() => {
    if (!accountId) return undefined
    const off = subscribe(`bank_account:${accountId}`, (msg) => {
      const p = msg?.payload
      if (!p?.id) return
      setRows((prev) => {
        const i = prev.findIndex((r) => r.id === p.id)
        // Ligne inconnue de l'onglet (créée depuis) : la charge utile ne porte
        // pas de quoi l'afficher, il faut relire la liste.
        if (i === -1) { liveUnknown.current = true; return prev }
        const next = prev.slice()
        next[i] = { ...next[i], ...p }
        return next
      })
      clearTimeout(liveSoon.current)
      liveSoon.current = setTimeout(() => {
        if (liveUnknown.current) { liveUnknown.current = false; invalidate('/bank'); loadTxns().catch(() => {}) }
        setReconcileKey((k) => k + 1)
        rec.loadQb()
      }, 3000)
    })
    return () => { clearTimeout(liveSoon.current); off() }
  }, [accountId, loadTxns, rec.loadQb]) // eslint-disable-line react-hooks/exhaustive-deps

  // Ce qui cloche sur une ligne, dit sur la ligne elle-même plutôt que dans une
  // section repliée au-dessus du tableau : solde qui ne suit pas, doublon,
  // absence d'écriture QuickBooks.
  const flags = useMemo(() => {
    const m = new Map()
    const short = (a) => a.kind === 'chaine_solde' ? `Solde décalé de ${fmtMoney(a.amount, account?.currency)} · ligne manquante ?`
      : a.kind === 'doublon' ? 'Doublon ?'
      : a.explanation
    for (const a of rec.summary?.anomalies || []) if (a.txn_id && !m.has(a.txn_id)) m.set(a.txn_id, short(a))
    for (const g of rec.qb?.missing_in_qb || []) if (g.txn_id && !m.has(g.txn_id)) m.set(g.txn_id, 'Absent de QuickBooks')
    return m
  }, [rec.summary, rec.qb, account?.currency])

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

  // Une seule liste : le relevé au complet, fantômes glissés à leur date. Le
  // filtre de couleur s'applique APRÈS (mémo séparé) pour qu'un clic sur la
  // légende ne refasse ni la fusion ni le tri.
  const allRows = useMemo(() => {
    if (!ghosts.length) return decorated
    return [...decorated, ...ghosts].sort((a, b) => (
      a.txn_date < b.txn_date ? 1 : a.txn_date > b.txn_date ? -1 : (a._ghost ? 1 : b._ghost ? -1 : 0)
    ))
  }, [decorated, ghosts])

  const peekRow = allRows.find((r) => r.id === peekOpen.id)
  // Facture retracée : le clic sur la ligne ouvre le document lui-même (reçu
  // extrait, payout, facture fournisseur) plutôt que de déplier la ligne.
  const [achatDoc, setAchatDoc] = useState(null)
  const openMatchedDocument = (r) => {
    if (r._ghost || !r.matched_id || r.transfer_txn_id) return false
    if (r.matched_type === 'achat') {
      api.achatsFournisseurs.get(r.matched_id).then(setAchatDoc).catch(() => {})
      return true
    }
    if (r.matched_path) { navigate(r.matched_path); return true }
    return false
  }

  const openTransaction = (r) => {
    if (!r._ghost && r.status === 'facture_recue' && r.matched_type === 'receipt' && r.matched_id) {
      navigate(`/sale-receipts/${r.matched_id}`)
      return
    }
    setPeekOpen({ id: r.id, mode: null, forId: r.id })
  }

  // Compteurs sur TOUTE la liste : ils ne doivent pas bouger quand on filtre.
  const counts = useMemo(() => {
    const c = { ghost: 0, proposals: 0, missing: 0, requested: 0 }
    for (const k of LEGEND_ORDER) c[k] = 0
    for (const r of allRows) {
      c[bucketOf(r)] += 1
      if (r.proposal_count) c.proposals += r.proposal_count
      if (r.missing_invoice) c.missing += 1
      if (r.invoice_requested) c.requested += 1
    }
    return c
  }, [allRows])

  const visibleRows = useMemo(() => {
    if (!colorFilter) return allRows
    if (colorFilter === 'proposals') return allRows.filter((r) => r.proposal_count > 0)
    // Les plus vieilles d'abord : c'est l'ancienneté qui dit ce qui presse.
    if (colorFilter === 'requested') {
      return allRows.filter((r) => r.invoice_requested)
        .sort((a, b) => String(a.txn_date).localeCompare(String(b.txn_date)))
    }
    if (colorFilter === 'missing') {
      return allRows.filter((r) => r.missing_invoice)
        .sort((a, b) => String(a.txn_date).localeCompare(String(b.txn_date)))
    }
    return allRows.filter((r) => bucketOf(r) === colorFilter)
  }, [allRows, colorFilter])

  // Les lignes fantômes (`qb:…`) n'existent pas en base : aucune action de lot
  // ne doit leur être envoyée. Elles restent cochables — DataTable ne sait pas
  // désactiver une case ligne par ligne — d'où le filtre ici.
  const bulkReal = async (ids, fn) => {
    const real = ids.filter((id) => !String(id).startsWith('qb:'))
    if (!real.length) return
    await fn(real)
    await refresh()
  }

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(null), 6000) }
  const robot = useQbRobot(account?.qb_account_id ? accountId : null, flash)

  // Glisser un relevé n'importe où sur la page ouvre la fenêtre de dépôt avec
  // le fichier déjà pris en charge — aucun bouton à trouver d'abord. On ne
  // réagit qu'à un vrai fichier, pas au déplacement d'une sélection de texte.
  useEffect(() => {
    let depth = 0
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
    const onEnter = (e) => { if (hasFiles(e)) { e.preventDefault(); depth++; setPageDrag(true) } }
    const onOver = (e) => { if (hasFiles(e)) e.preventDefault() }
    const onLeave = () => { if (--depth <= 0) { depth = 0; setPageDrag(false) } }
    const onDrop = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setPageDrag(false)
      const files = [...(e.dataTransfer.files || [])]
      if (!files.length) return
      setDroppedFiles(files)
      setShowDrop(true)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  const currency = account?.currency

  const saveComment = useCallback(async (id, comment) => {
    const updated = await api.bank.updateTransaction(id, { comment })
    invalidate('/bank')
    setRows((current) => current.map((row) => row.id === id ? { ...row, comment: updated.comment } : row))
  }, [])

  // Rond rouge : posé sur place, puis relu (compteur de l'onglet du compte).
  const setReview = useCallback(async (row, on) => {
    setRows((cur) => cur.map((r) => r.id === row.id ? { ...r, review_flag: on ? 1 : 0 } : r))
    try { await api.bank.setReview(row.id, on) } finally { invalidate('/bank'); loadAccounts().catch(() => {}) }
  }, [loadAccounts])
  const setBookmark = useCallback(async (txnId) => {
    if (!accountId || accountId === TODO_TAB) return
    setAccounts((cur) => cur.map((a) => a.id === accountId ? { ...a, bookmark_txn_id: txnId } : a))
    await api.bank.updateAccount(accountId, { bookmark_txn_id: txnId })
    invalidate('/bank')
  }, [accountId])

  const qbNames = useQbNames(rows.some((r) => r.suggestion?.kind === 'vendor_expense'))
  // Le relevé porte tous les gestes : la ligne prend la couleur de son statut
  // (rouge à traiter, bleu facture reçue, jaune comptabilisé, vert rapproché),
  // comme les cases peintes du fichier TRX_Orisha. Le face à face avec
  // QuickBooks (maquette R3) est retiré — Charles, 2026-09-29.
  const COLUMNS = useMemo(() => {
    const num = (v, cls = '', cur = currency) => (v == null
      ? <span className="block text-right text-slate-200">·</span>
      : <span className={`block text-right tabular-nums ${cls}`}>{money(v, cur)}</span>)
    const renderers = {
      comment: (r) => (r._ghost ? '—' : <TransactionComment key={r.id} txn={r} onSave={saveComment} />),
      txn_date: (r) => (
        <span className="whitespace-nowrap text-slate-500 tabular-nums">
          {!!r.pending && <span title="En attente à la banque"><Clock size={11} className="inline mr-1 -mt-0.5 text-slate-400" /></span>}
          {r.review_flag ? <span className="lg-pen">{fmtDate(r.txn_date)}</span> : fmtDate(r.txn_date)}
        </span>
      ),
      description: (r) => (
        <span className={`block truncate ${r._ghost ? 'italic text-slate-400' : ''}`} title={txnSubLabel(r) || undefined}>
          {r.proposal_count > 0 && (
            <span title={`${r.proposal_count} proposition${r.proposal_count > 1 ? 's' : ''}`}>
              <Wand2 size={12} className="inline mr-1 -mt-0.5 text-brand-600" />
            </span>
          )}
          {r._flag && <span title={r._flag}><AlertTriangle size={12} className="inline mr-1 -mt-0.5 text-amber-500" /></span>}
          {r._ghost && <span className="text-slate-400">QuickBooks · </span>}
          {r._acct && <span className="mr-1.5 px-1 rounded bg-slate-100 text-[11px] text-slate-500">{r._acct.name}</span>}
          <span className="lg-lbl">{txnLabel(r)}</span>
          {txnSubLabel(r) && <span className="lg-sub"> · {txnSubLabel(r)}</span>}
        </span>
      ),
      bank_description: (r) => (txnSubLabel(r)
        ? <span className="block truncate text-slate-500" title={txnSubLabel(r)}>{txnSubLabel(r)}</span>
        : <span className="text-slate-200">·</span>),
      debit: (r) => num(r._ghost ? (r.amount < 0 ? -r.amount : null) : r.debit, 'text-slate-700', r._acct?.currency || currency),
      credit: (r) => num(r._ghost ? (r.amount > 0 ? r.amount : null) : r.credit, 'text-green-700', r._acct?.currency || currency),
      amount: (r) => num(r.amount, r.amount < 0 ? 'text-slate-700' : 'text-green-700', r._acct?.currency || currency),
      balance: (r) => num(r.balance, 'text-slate-400', r._acct?.currency || currency),
      vendor: (r) => (r.matched_id && r.matched_label
        ? (
          <span className="flex items-center gap-1 min-w-0">
            <span className="truncate">{docLink(r.matched_type, r.matched_id, r.matched_label)}</span>
            <MatchedDocument txn={r} doc={null} onChanged={refresh} icon />
            <QbLink txn={r} />
          </span>
        )
        : r.resolved_vendor
          ? (
            <Link to="/fournisseurs" onClick={(e) => e.stopPropagation()} className="block truncate text-slate-500 hover:text-brand-600"
              title={`Reconnu par ${VENDOR_VIA[r.resolved_vendor.via] || r.resolved_vendor.via}`}>
              {r.resolved_vendor.name}
            </Link>
          )
          : <span className="text-slate-200">·</span>),
      bank_state: (r) => {
        const m = BANK_STATE_META[r.bank_state]
        return m ? <span className={`block truncate ${m.cls}`}>{m.label}</span> : <span className="text-slate-200">·</span>
      },
      match_confidence: (r) => (r.match_confidence != null ? `${Math.round(r.match_confidence * 100)} %` : '—'),
    }
    // Le statut ne prend plus de colonne : c'est la couleur de la ligne. La
    // description de la banque suit le libellé, sur la même ligne.
    const base = TABLE_COLUMN_META.bank_transactions
      .filter((c) => c.id !== 'status' && c.id !== 'bank_description')
      .map((c) => ({ ...c, render: renderers[c.id] }))
    const marks = {
      id: '_marks', label: '', width: 56, alwaysVisible: true, sortable: false, filterable: false, groupable: false,
      render: (r) => (r._ghost ? null : (
        <RowMarks row={r} bookmarked={account?.bookmark_txn_id === r.id} onReview={setReview} onBookmark={setBookmark} />
      )),
    }
    const iBal = base.findIndex((c) => c.id === 'balance')
    const withMarks = iBal === -1 ? [...base, marks] : [...base.slice(0, iBal + 1), marks, ...base.slice(iBal + 1)]
    const suggestion = {
      id: '_suggestion', label: 'Suggestion', width: 440, alwaysVisible: true, sortable: false, filterable: false, groupable: false,
      render: (r) => (r._ghost ? null : (
        <SuggestionCell row={r} currency={r._acct?.currency || currency} names={qbNames} onChanged={refresh} />
      )),
    }
    const iDesc = withMarks.findIndex((c) => c.id === 'description')
    const cols = iDesc === -1 ? [...withMarks, suggestion] : [...withMarks.slice(0, iDesc + 1), suggestion, ...withMarks.slice(iDesc + 1)]
    // Le geste attendu, en tête de ligne : un clic la déplie sur le bon volet.
    return [{
      id: '_next', label: '', width: 190, sortable: false, filterable: false, groupable: false,
      render: (r) => {
        if (r._ghost || r.status === 'rapproche' || r.status === 'ignore' || r.suggestion || r.auto_suggestion) return null
        const pending = nextActions[r.id]
        if (r.qb_txn_id && !pending) return null
        if ((r.matched_id || r.transfer_txn_id) && pending?.kind !== 'comptabiliser') {
          return <span className="text-xs text-slate-400 truncate">{r.matched_label || 'Virement'}</span>
        }
        const n = pending || { kind: 'rien', label: null }
        const meta = NEXT_META[n.kind] || NEXT_META.rien
        const from = r.rule_name ? `Préparée par la règle « ${r.rule_name} »` : null
        return (
          <span className="flex items-center gap-2 min-w-0">
            <button type="button" title={from || undefined} className={`shrink-0 text-xs px-2 py-1 rounded-md ${meta.cls}`}>{meta.label}</button>
            {n.label && <span className="truncate text-xs text-slate-500" title={from || n.label}>{n.label}</span>}
          </span>
        )
      },
    }, ...cols]
  }, [currency, saveComment, refresh, nextActions, account?.bookmark_txn_id, setReview, setBookmark, qbNames])

  return (
    <Layout>
      <div className="px-3 pt-3">
        {/* Plus d'en-tête (2026-09-15) : le titre ne sert qu'aux lecteurs
            d'écran, le compte, l'écart et les actions vivent dans la barre
            d'outils du tableau. */}
        <h1 className="sr-only">Rapprochement bancaire</h1>

        {notice && <div className="mb-3 text-sm bg-green-50 text-green-800 rounded-lg px-3 py-2">{notice}</div>}

        <DataTable
          table="bank_transactions"
          skin="ledger"
          expandToggle={false}
          height="calc(100vh - 165px)"
          // Le compte n'est nommé qu'une fois : par son onglet, en bas
          // (maquette T1, 2026-09-27). Les outils du tableau tiennent dans un
          // seul menu.
          toolsMenu
          toolbarEnd={
            <div className="flex items-center gap-2 ml-2 min-w-0">
              <StatusLegend counts={counts} value={colorFilter} onChange={setColorFilter} onRequests={() => setRequestsOpen(true)} />
              <EcartBar account={account} rec={rec} robot={account?.qb_account_id ? robot : null} />
              {/* Le seul bouton d'action de la page : apparier aux documents,
                  vérifier dans QuickBooks, recalculer l'écart. */}
              {accountId !== TODO_TAB && (
                <button type="button" data-testid="reconcile-auto-btn" aria-label="Mettre à jour"
                  className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-800 disabled:opacity-50"
                  title={rec.busy ? 'Mise à jour…' : "Mettre à jour — apparier aux documents, vérifier dans QuickBooks, recalculer l'écart"}
                  disabled={rec.busy || !accountId} onClick={rec.runUpdate}>
                  <RefreshCw size={14} className={rec.busy ? 'animate-spin' : ''} />
                </button>
              )}
              <MoreMenu onDrop={() => setShowDrop(true)} onRules={() => setRulesOpen(true)} flash={flash} robot={account?.qb_account_id ? robot : null} />
            </div>
          }
          columns={COLUMNS}
          openKey={askedRow}
          data={visibleRows}
          loading={loading}
          rowKey="id"
          // La ligne porte la couleur de son statut (index.css, `row-st-*`).
          // L'anomalie ne prend PLUS le fond — elle pose un filet à gauche, qui
          // cohabite avec la teinte. Une règle de couleur de vue, elle, est
          // posée en style inline par DataTable : elle gagne sur tout, c'est
          // voulu (la règle explicite de l'utilisateur passe avant).
          rowClassName={(r) => `${r._ghost ? GHOST_META.tint : STATUS_META[bucketOf(r)].tint}${r._flag ? ' row-flagged' : ''}`}
          searchFields={['details', 'description', 'reference', 'amount', 'comment', 'matched_label']}
          // Sans `bulkDeleteAlways`, DataTable n'affiche les cases à cocher que
          // si un admin a activé la suppression en lot sur la table : la
          // confirmation en lot était invisible. Pas de `onBulkDelete` — on ne
          // supprime pas une ligne de relevé depuis la barre.
          bulkDeleteAlways
          bulkActions={[
            {
              key: 'reconcile', label: 'Confirmer', icon: CheckCheck, busyLabel: 'Rapprochement…',
              show: (rows) => rows.some((r) => !r._ghost && r.status !== 'rapproche' && r.status !== 'ignore'),
              onClick: async (ids) => { await bulkReal(ids, (real) => api.bank.reconcile(real)) },
            },
            {
              // Une dépense (ou une répartition AGA) publie dans QuickBooks :
              // elle ne part JAMAIS en lot, elle attend son clic. Le bouton
              // annonce donc ce qu'il va vraiment confirmer, et le serveur
              // refuse les autres de toute façon.
              key: 'accept-proposals', icon: Wand2, busyLabel: 'Confirmation…',
              label: (rows) => {
                const n = rows.reduce((s, r) => s + Math.max(0, (r.proposal_count || 0) - (r.publishing_count || 0)), 0)
                return n > 1 ? `Confirmer ${n} propositions` : 'Confirmer la proposition'
              },
              show: (rows) => rows.some((r) => (r.proposal_count || 0) - (r.publishing_count || 0) > 0),
              onClick: async (ids) => {
                const rows = allRows.filter((r) => ids.includes(r.id) && r.proposal_count > 0)
                if (!rows.length) return
                const props = (await Promise.all(rows.map((r) => api.bank.txnProposals(r.id)))).flat()
                const open = props.filter((p) => p.status === 'proposee')
                const batch = open.filter((p) => !p.publishes).map((p) => p.id)
                const held = open.length - batch.length
                if (batch.length) await api.bank.acceptProposals(batch)
                invalidate('/bank')
                await refresh()
                if (held) {
                  flash(held > 1
                    ? `${held} écritures restent à confirmer une par une — elles publient dans QuickBooks.`
                    : 'Une écriture reste à confirmer sur sa ligne — elle publie dans QuickBooks.')
                }
              },
            },
            {
              key: 'unreconcile', label: 'Annuler le rapprochement', icon: Undo2, busyLabel: 'Mise à jour…',
              show: (rows) => rows.length > 0 && rows.every((r) => r.status === 'rapproche'),
              onClick: async (ids) => { await bulkReal(ids, (real) => api.bank.reconcile(real, true)) },
            },
            {
              // Les deux marques de Michel, posées sur toute la sélection d'un
              // coup — elles ne se posaient qu'une ligne à la fois.
              key: 'review', label: 'À réviser', icon: AlertTriangle, busyLabel: 'Mise à jour…',
              show: (rows) => rows.some((r) => !r._ghost && !r.review_flag),
              onClick: async (ids) => {
                await bulkReal(ids, async (real) => {
                  for (const id of real) await api.bank.setReview(id, true)
                })
                loadAccounts().catch(() => {})
              },
            },
            {
              // Un seul signet par compte : sur une sélection, il se pose sur la
              // ligne la plus récente.
              key: 'bookmark', label: 'Signet', icon: Bookmark, busyLabel: 'Mise à jour…',
              show: (rows) => accountId !== TODO_TAB && rows.some((r) => !r._ghost),
              onClick: async (ids) => {
                const real = allRows.filter((r) => ids.includes(r.id) && !r._ghost)
                const last = real.sort((a, b) => String(b.txn_date).localeCompare(String(a.txn_date)))[0]
                if (last) await setBookmark(last.id)
              },
            },
            {
              // La liste des factures réclamées ne se remplit que d'ici.
              key: 'invoice-request', label: 'Facture manquante', icon: Flag, busyLabel: 'Ajout…',
              show: (rows) => rows.some((r) => !r._ghost && !r.invoice_requested),
              onClick: async (ids) => {
                await bulkReal(ids, (real) => api.bank.addInvoiceRequests(real))
                setRequestsOpen(true)
              },
            },
            {
              key: 'ignore', label: 'Ignorer', icon: Unlink, busyLabel: 'Mise à jour…',
              show: (rows) => rows.some((r) => !r._ghost && r.status !== 'ignore'),
              onClick: async (ids) => {
                await bulkReal(ids, async (real) => {
                  for (const id of real) await api.bank.updateTransaction(id, { status: 'ignore' })
                })
              },
            },
            {
              key: 'reactivate', label: 'Ré-activer', icon: Undo2, busyLabel: 'Mise à jour…',
              show: (rows) => rows.length > 0 && rows.every((r) => r.status === 'ignore'),
              onClick: async (ids) => {
                await bulkReal(ids, async (real) => {
                  for (const id of real) await api.bank.updateTransaction(id, { status: 'a_traiter' })
                })
              },
            },
          ]}
          onRowClick={(r) => (openMatchedDocument(r) ? undefined : false)}
          renderExpanded={(row, { collapse }) => (
            <QbRowExpansion key={row.id} txn={row} currency={row._acct?.currency || currency} next={nextActions[row.id]}
              onChanged={refresh} onOpenPanel={openTransaction} collapse={collapse} />
          )}
          emptyState={{
            title: 'Aucune transaction',
            description: 'Importer un relevé pour commencer le rapprochement.',
          }}
        />
        <div className="dt-skin-ledger">
          <AccountTabs accounts={accounts} accountId={accountId} onChange={setAccountId} />
        </div>
      </div>

      <RecordPeekDrawer open={!!peekRow}
        onClose={() => setPeekOpen({ id: null, mode: null, forId: null })}
        title={peekRow ? txnLabel(peekRow) : ''}
        subtitle={peekRow ? fmtDate(peekRow.txn_date) : ''} width={420}>
        {peekRow && <RecordScope id={peekRow.id}>
          {peekRow._ghost
            ? <GhostPeek row={peekRow} currency={currency} />
            : <TxnPeek key={peekRow.id} txn={peekRow} currency={peekRow._acct?.currency || currency} onChanged={refresh}
                initialMode={peekOpen.forId === peekRow.id ? peekOpen.mode : null} />}
        </RecordScope>}
      </RecordPeekDrawer>

      {achatDoc && (
        <RecordPeekDrawer open onClose={() => setAchatDoc(null)} peekKey="achats" width={640}
          title={achatDoc.vendor || 'Facture fournisseur'}
          subtitle={[achatDoc.vendor_invoice_number, achatDoc.invoice_date].filter(Boolean).join(' · ')}>
          <div className="px-5 py-4">
            <Suspense fallback={<PanelFallback />}>
              <AchatPanel achat={achatDoc} onClose={() => setAchatDoc(null)} onSaved={async () => { invalidate('/bank'); await refresh() }} />
            </Suspense>
          </div>
        </RecordPeekDrawer>
      )}

      <RecordPeekDrawer open={requestsOpen} onClose={() => setRequestsOpen(false)} peekKey="invoice-requests"
        title="Factures demandées" subtitle="Décocher sort du message, pas de la liste" width={460}>
        {requestsOpen && <InvoiceRequestsPanel onChanged={refresh} />}
      </RecordPeekDrawer>

      <RecordPeekDrawer open={rulesOpen} onClose={() => setRulesOpen(false)} peekKey="bank-rules"
        title="Règles bancaires" subtitle="Elles préparent l'écriture, jamais la publication" width={480}>
        <Suspense fallback={<div className="text-sm text-slate-400">Chargement…</div>}>
          <BankRulesList footer={
            <Link to="/regles-bancaires" className="text-xs text-brand-700 hover:underline">
              Atelier, ménage et import QuickBooks →
            </Link>
          } />
        </Suspense>
      </RecordPeekDrawer>

      {pageDrag && !showDrop && (
        <div className="fixed inset-0 z-40 pointer-events-none flex items-center justify-center bg-brand-600/10 border-4 border-dashed border-brand-500">
          <span className="px-4 py-2 rounded-lg bg-white text-sm shadow">Lâchez le relevé ici</span>
        </div>
      )}

      {showDrop && (
        <StatementDropModal
          accounts={accounts}
          initialFiles={droppedFiles}
          onClose={() => { setShowDrop(false); setDroppedFiles(null) }}
          onDone={async (results) => {
            setShowDrop(false)
            setDroppedFiles(null)
            const inserted = results.reduce((n, r) => n + r.inserted, 0)
            const matched = results.reduce((n, r) => n + r.autoMatched, 0)
            flash(`${inserted} importée${inserted > 1 ? 's' : ''} depuis ${results.length} relevé${results.length > 1 ? 's' : ''}, ${matched} appariée${matched > 1 ? 's' : ''}.`)
            await refresh()
          }}
        />
      )}
    </Layout>
  )
}
