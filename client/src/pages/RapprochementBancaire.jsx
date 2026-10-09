import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { celebrate } from '../lib/celebrate.js'
import { FileUp, Table2, Wand2, CheckCheck, Undo2, Link2, Unlink, ExternalLink, RefreshCw, AlertTriangle, MoreHorizontal, BookOpen, Download, Clock, Plus, ArrowLeftRight, Check, X, Landmark, Wallet, FileText, Flag, Bookmark, Send, Pencil, Paperclip, Combine, Split } from 'lucide-react'
import { createPortal } from 'react-dom'
import api from '../lib/api.js'
import { invalidate, prefetch } from '../lib/prefetch.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtMoney } from '../utils/formatters.js'
import { VendorSelect } from '../components/VendorSelect.jsx'
import { VendorProfileHint, VendorHover } from '../components/VendorProfileHint.jsx'
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

// Vert posé par le passage automatique (serveur : bankAutoReconcile).
const AUTO_RECONCILE = { qb_rapproche: 'QuickBooks', ecart_zero: 'écart nul' }

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

// ── Panneau « reçu » (maquette P2, 2026-10-03) ─────────────────────────────
// Une colonne qui se lit de haut en bas : libellé à gauche, valeur à droite,
// crayon au survol. Un clic sur la valeur l'ouvre en saisie, sur place.
function SlipRow({ label, value, warn, edit, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const close = () => setOpen(false)
  return (
    <div className="group grid grid-cols-[88px_1fr_16px] gap-2.5 items-center py-2.5 border-b border-slate-100 last:border-0">
      <span className="text-xs text-slate-500">{label}</span>
      {open && edit ? <div className="min-w-0">{edit(close)}</div> : edit ? (
        <button type="button" onClick={() => setOpen(true)}
          className={`min-w-0 truncate text-left font-medium ${warn ? 'text-amber-600' : 'text-slate-900'}`}>{value}</button>
      ) : <span className={`min-w-0 truncate font-medium ${warn ? 'text-amber-600' : 'text-slate-900'}`}>{value}</span>}
      {edit && !open
        ? <button type="button" aria-label={`Modifier ${label}`} onClick={() => setOpen(true)}
            className="text-slate-300 opacity-0 group-hover:opacity-100 hover:text-slate-600"><Pencil size={12} /></button>
        : <span />}
    </div>
  )
}

// Le gros bouton du bas. Entrée le déclenche tant qu'aucun champ n'a le focus.
function SlipCta({ label, busy, busyLabel, disabled, onClick }) {
  const cb = useRef(onClick)
  cb.current = disabled || busy ? null : onClick
  useEffect(() => {
    const h = (e) => {
      if (e.key !== 'Enter' || e.defaultPrevented || !cb.current) return
      const t = e.target
      if (t && t !== document.body && t.closest?.('input,textarea,select,button,[role="combobox"],[contenteditable="true"]')) return
      e.preventDefault(); cb.current()
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])
  return (
    <button type="button" disabled={disabled || busy} onClick={onClick}
      className="w-full h-11 rounded-full bg-[#2ca01c] hover:bg-[#248a17] text-white text-[14px] font-semibold disabled:opacity-40">
      {busy ? busyLabel : label}{!busy && <span className="ml-1.5 text-[12px] font-normal opacity-70">↵</span>}
    </button>
  )
}

// ── « Ajouter » : comptabiliser une ligne qui n'aura jamais de facture ──────
//
// Le pendant du bouton « Ajouter » de QuickBooks, et le dossier de préparation
// de l'écriture : chaque valeur proposée affiche D'OÙ elle vient — le relevé, le
// document apparié, une règle, le profil du fournisseur, ou l'habitude (« 7 fois
// sur 8 »). Un champ sans source reste vide : on ne devine pas en silence.
// Quand le profil et l'habitude se contredisent, on le dit au lieu de trancher.
// `compact` : la version du panneau (maquette C2, 2026-10-03) — deux colonnes,
// ni provenance ni historique : l'app tranche, l'humain ne voit que le résultat
// (et un « à vérifier » quand l'habitude se partage).
function AddExpenseForm({ txn, currency, onDone, onCancel, compact = false, receipt = false, line = false, next = null, bankAccounts = null, opType = null }) {
  const cheque = opType === 'cheque'
  const [defaults, setDefaults] = useState(null)
  const [form, setForm] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [taxCodes, setTaxCodes] = useState([])
  const [rate, setRate] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Écriture coupée : une part par compte. `null` = une seule dépense.
  const [parts, setParts] = useState(null)
  const [requested, setRequested] = useState(false)
  // Pièce récurrente (bail, contrat) jointe d'office, et les champs que
  // l'humain a touchés — un nouveau bénéficiaire ne les écrase pas.
  const [standing, setStanding] = useState(null)
  const touched = useRef(new Set())

  useEffect(() => {
    let alive = true
    api.bank.addDefaults(txn.id).then((d) => {
      if (!alive) return
      setDefaults(d)
      setStanding(d.standing_doc || null)
      // Remboursement de marge : l'écriture s'ouvre déjà coupée en capital et
      // intérêts, il ne reste qu'à confirmer.
      if (d.split?.lines?.length) setParts(d.split.lines.map((l) => ({ ...l })))
      // Ligne ouverte (L3) : elle reprend EXACTEMENT ce que la colonne annonce —
      // l'écriture préparée, ou le compte du virement détecté.
      const sg = line && txn.suggestion?.kind === 'vendor_expense' ? txn.suggestion.payload || {} : {}
      const xfer = line && next?.kind === 'virement' ? (bankAccounts || []).find((b) => b.id === next.account_id) : null
      setForm({
        vendor: sg.vendor || d.vendor || '',
        expense_account_id: (xfer?.qb_account_id && String(xfer.qb_account_id)) || sg.expense_account_id || d.expense_account_id || '',
        tax_code_id: sg.tax_code_id || d.tax_code_id || '',
        memo: d.memo || '',
        doc_number: d.doc_number || (cheque && txn.check_number) || '',
        qb_type: cheque ? 'purchase' : d.qb_type === 'bill' ? 'bill' : 'purchase',
      })
    }).catch((e) => setError(e.message))
    // Ligne ouverte : tous les comptes — un virement, un remboursement de dette
    // se catégorisent vers un compte de bilan, comme dans QuickBooks.
    Promise.all([api.quickbooks.accounts(line ? { all: 1 } : {}), api.quickbooks.taxCodes()])
      .then(([a, t]) => { if (alive) { setAccounts(a || []); setTaxCodes(t || []) } })
      .catch(() => {})
    return () => { alive = false }
  }, [txn.id]) // eslint-disable-line react-hooks/exhaustive-deps

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
  // Répartition d'une règle en % : les montants suivent la base hors taxes
  // (qui bouge avec le code de taxe) ; la dernière part prend le reste.
  useEffect(() => {
    if (rate === undefined) return
    setParts((ps) => {
      if (!ps?.some((p) => p.pct != null)) return ps
      let used = 0
      return ps.map((p, i) => {
        if (p.pct == null) { used += Number(p.amount) || 0; return p }
        const amount = i === ps.length - 1 ? round2(base - used) : round2(base * p.pct / 100)
        used += amount
        return amount === p.amount ? p : { ...p, amount }
      })
    })
  }, [base, rate])

  // Joint la pièce récurrente (ou retient qu'on n'en veut pas) une fois l'écriture faite.
  const attachStanding = async () => {
    if (!standing) return
    try {
      await api.bank.standingDoc(txn.id, { vendor: form.vendor, drive_file_id: standing.drive_file_id, file_name: standing.file_name, attach: standing.checked })
    } catch (e) { throw new Error(`Écriture publiée, ${standing.file_name} non joint : ${e.message}`) }
  }

  // Bénéficiaire choisi : on relit SON habitude (catégorie, taxe, mémo, pièce).
  const pickPayee = (p) => {
    setForm((f) => ({ ...f, vendor: p.name, payee_id: p.type === 'new' ? null : p.id, payee_type: p.type === 'new' ? null : p.type }))
    api.bank.addDefaults(txn.id, p.name).then((d) => {
      setDefaults(d)
      setStanding(d.standing_doc || null)
      setForm((f) => {
        if (!f || f.vendor !== p.name) return f
        const next = { ...f }
        for (const k of ['expense_account_id', 'tax_code_id', 'memo']) if (!touched.current.has(k) && d[k]) next[k] = d[k]
        return next
      })
    }).catch(() => {})
  }

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      const r = await api.bank.addExpense(txn.id, {
        vendor: form.vendor,
        expense_account_id: parts ? '' : form.expense_account_id,
        lines: parts ? parts.map(({ pct: _pct, ...p }) => p) : undefined,
        tax_code_id: form.tax_code_id || null,
        tax_cad: taxCad,
        memo: form.memo,
        payment_account_id: defaults?.payment_account_id || null,
        payment_method: cheque ? 'Chèque' : defaults?.payment_method || null,
        doc_number: form.doc_number || null,
        qb_type: form.qb_type,
        payee_id: form.payee_id || null,
        payee_type: form.payee_type || null,
        due_date: form.qb_type === 'bill' ? defaults?.due_date || null : null,
      })
      invalidate('/bank')
      if (r.qbError) setError(`Écriture créée, publication QuickBooks refusée : ${r.qbError}`)
      else { await attachStanding(); onDone() }
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  if (!form) return <div className="p-4 text-sm text-slate-400">{error || 'Chargement…'}</div>

  const h = defaults?.history
  const accountName = (id) => accounts.find((a) => String(a.Id) === String(id))?.Name || id
  const taxName = (id) => (id === NO_TAX ? 'aucune' : taxCodes.find((t) => String(t.Id) === String(id))?.Name || id)
  const set = (k) => (v) => { touched.current.add(k); setForm((f) => ({ ...f, [k]: v })) }

  const draft = defaults?.draft
  // La provenance d'une valeur, sous le champ. Vide = l'humain l'a saisie.
  const from = (k) => {
    if (compact) return null
    const src = draft?.fields?.[k]?.source
    return src ? <span className="text-[11px] text-slate-400">{src}</span> : null
  }

  const accSrc = draft?.fields?.expense_account_id?.source || ''
  const unsure = compact && (!form.expense_account_id || accSrc.startsWith('habitude :') || accSrc.startsWith('déduit') || /^déjà fait \d+ fois sur/.test(accSrc))

  if (line) {
    const bank = bankOfQb(form.expense_account_id, bankAccounts)
    const doc = draft?.document
    const acctOpt = (a) => `${a.AcctNum ? `${a.AcctNum} · ` : ''}${a.Name}`
    const sgp = txn.suggestion?.kind === 'vendor_expense' ? txn.suggestion : null
    const go = async () => {
      if (!bank && !(sgp && !parts && !cheque
        && String(sgp.payload?.expense_account_id || '') === String(form.expense_account_id || '')
        && String(sgp.payload?.tax_code_id || '') === String(form.tax_code_id || '')
        && (sgp.payload?.vendor || '') === (form.vendor || '')
        && (form.memo || '') === (defaults?.memo || ''))) { await submit(); return }
      setBusy(true); setError(null)
      try {
        // Rien n'a bougé dans l'écriture préparée : on la confirme telle quelle.
        if (bank) await transferToBank(txn, bank)
        else { await api.bank.acceptProposal(sgp.id); invalidate('/bank'); await attachStanding() }
        await onDone(bank ? 'Virement lié' : 'Écriture ajoutée')
      } catch (e) { setError(e.message) } finally { setBusy(false) }
    }
    const blocked = !bank && (!form.vendor || (parts ? (Math.abs(rest) > 0.02 || parts.some((p) => !p.expense_account_id)) : !form.expense_account_id))
    return (
      <div className="flex flex-col gap-3" data-testid="line-categorize">
        <div className="grid grid-cols-[1.1fr_1.4fr_1fr_0.9fr] gap-x-3.5 gap-y-2.5 max-w-[980px] items-start">
          {cheque && (
            <LineField label="N° de chèque">
              <input className={LINE_INPUT} value={form.doc_number} onChange={(e) => set('doc_number')(e.target.value)} />
            </LineField>
          )}
          {!bank && (
            <LineField label="Bénéficiaire">
              <QbPayeeSelect name={form.vendor} payeeId={form.payee_id} payeeType={form.payee_type} currency={currency}
                onPick={pickPayee} />
            </LineField>
          )}
          {parts ? (
            <LineField label="Catégorie">
              <button type="button" className="min-h-[34px] text-left text-slate-600 hover:underline" onClick={() => setParts(null)}>
                {parts.length} comptes · revenir à un seul
              </button>
            </LineField>
          ) : (
            <LineField label="Catégorie" warn={!bank && (accSrc.startsWith('habitude :') || accSrc.startsWith('déduit'))} className={bank ? 'col-span-2' : ''}>
              <SearchableSelect value={form.expense_account_id} onChange={set('expense_account_id')}
                options={accounts} getOptionValue={(a) => String(a.Id)} getOptionLabel={acctOpt} placeholder="Choisir une catégorie" className={LINE_INPUT} />
            </LineField>
          )}
          {!bank && (
            <LineField label="Taxe">
              <SearchableSelect value={form.tax_code_id} onChange={set('tax_code_id')}
                options={taxCodes} getOptionValue={(t) => String(t.Id)} getOptionLabel={(t) => t.Name}
                emptyOption="Aucune taxe" placeholder="Aucune taxe" className={LINE_INPUT} />
            </LineField>
          )}
          <LineField label="Montant">
            <span className="flex flex-col justify-center min-h-[34px] tabular-nums">
              <span className="font-semibold text-slate-900">{money(total, currency)}</span>
              <span className="text-[11px] text-slate-500">
                {bank ? `virement vers ${bank.name}` : rate === undefined ? '…' : taxCad ? `${money(base, currency)} + ${money(taxCad, currency)} taxes` : 'sans taxes'}
              </span>
            </span>
          </LineField>
          <LineField label="Mémo" className="col-span-2">
            <input className={LINE_INPUT} value={form.memo}
              onChange={(e) => set('memo')(e.target.value)} />
          </LineField>
        </div>
        {parts && (
          <div className="max-w-[640px] space-y-1.5">
            {parts.map((p, i) => (
              <div key={i} className="flex gap-2 items-center">
                <div className="grow min-w-0">
                  <SearchableSelect value={p.expense_account_id}
                    onChange={(v) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, expense_account_id: v } : x)))}
                    options={accounts} getOptionValue={(a) => String(a.Id)} getOptionLabel={acctOpt} placeholder="Choisir une catégorie" className={LINE_INPUT} />
                </div>
                <input type="number" step="0.01" value={p.amount}
                  className="w-28 h-[34px] border border-slate-300 rounded px-2 text-sm text-right bg-white"
                  onChange={(e) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value), pct: null } : x)))} />
                <button type="button" className="text-slate-300 hover:text-red-600" aria-label="Retirer"
                  onClick={() => setParts((ps) => (ps.length > 2 ? ps.filter((_, j) => j !== i) : ps))}><X size={14} /></button>
              </div>
            ))}
            <div className="flex items-center justify-between text-xs">
              <button type="button" className="text-[#0077c5] hover:underline"
                onClick={() => setParts((ps) => [...ps, { expense_account_id: '', amount: rest > 0 ? rest : 0 }])}>+ Ligne</button>
              {Math.abs(rest) > 0.02 && <span className="text-amber-600">reste {money(rest, currency)}</span>}
            </div>
          </div>
        )}
        <LineBar txn={txn} error={error}>
          {!bank && (doc
            ? <span className="text-[13px] text-green-700">Facture ✓ {doc.label}</span>
            : standing
              ? <label className="flex items-center gap-1.5 text-[13px] text-slate-700" data-testid="standing-doc">
                  <input type="checkbox" checked={standing.checked} onChange={(e) => setStanding((x) => ({ ...x, checked: e.target.checked }))} />
                  <Paperclip size={13} className="text-slate-400" />
                  <a href={standing.url} target="_blank" rel="noreferrer" className="hover:underline">{standing.file_name}</a>
                </label>
            : txn.invoice_requested || requested
              ? <span className="text-[13px] text-slate-500">Facture manquante</span>
              : null)}
          {!bank && !parts && (
            <button type="button" className={LINE_GHOST}
              onClick={() => setParts([{ expense_account_id: form.expense_account_id, amount: base }, { expense_account_id: '', amount: 0 }])}>Diviser</button>
          )}
          <button type="button" className={LINE_GO} disabled={busy || blocked} onClick={go}>{busy ? 'Publication…' : 'Ajouter'}</button>
        </LineBar>
      </div>
    )
  }

  if (receipt) {
    const acctLabel = (id) => {
      const a = accounts.find((x) => String(x.Id) === String(id))
      return a ? `${a.AcctNum ? `${a.AcctNum} · ` : ''}${a.Name}` : ''
    }
    const doubt = !form.expense_account_id || accSrc.startsWith('habitude :') || accSrc.startsWith('déduit')
    const acctSelect = (close, value, onPick) => (
      <SearchableSelect value={value} onChange={(v) => { onPick(v); close() }}
        options={accounts} getOptionValue={(a) => String(a.Id)}
        getOptionLabel={(a) => `${a.AcctNum ? `${a.AcctNum} · ` : ''}${a.Name}`} placeholder="Choisir un compte" />
    )
    const doc = draft?.document
    return (
      <div className="flex flex-col gap-3">
        <div>
          <SlipRow label="Fournisseur" value={form.vendor || '—'} defaultOpen={!form.vendor}
            edit={(close) => <VendorSelect value={form.vendor} onChange={({ vendor }) => { set('vendor')(vendor); if (vendor) close() }} />} />
          {!parts && (
            <SlipRow label="Compte" warn={doubt} defaultOpen={!form.expense_account_id}
              value={<>{acctLabel(form.expense_account_id)}{doubt && <span className="font-normal text-amber-600" data-testid="add-unsure"> · à vérifier</span>}</>}
              edit={(close) => acctSelect(close, form.expense_account_id, set('expense_account_id'))} />
          )}
          {parts && (
            <div className="py-2.5 border-b border-slate-100 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{defaults?.split?.reason || 'Comptes'}</span>
                <button type="button" className="hover:underline" onClick={() => setParts(null)}>Un seul compte</button>
              </div>
              {parts.map((p, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <div className="grow min-w-0">
                    <SearchableSelect value={p.expense_account_id}
                      onChange={(v) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, expense_account_id: v } : x)))}
                      options={accounts} getOptionValue={(a) => String(a.Id)}
                      getOptionLabel={(a) => `${a.AcctNum ? `${a.AcctNum} · ` : ''}${a.Name}`} placeholder="Choisir un compte" />
                  </div>
                  <input type="number" step="0.01" value={p.amount}
                    className="w-24 border border-slate-300 rounded-lg px-2 py-1 text-sm text-right"
                    onChange={(e) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value), pct: null } : x)))} />
                  <button type="button" className="text-slate-300 hover:text-red-600" aria-label="Retirer"
                    onClick={() => setParts((ps) => (ps.length > 2 ? ps.filter((_, j) => j !== i) : ps))}><X size={14} /></button>
                </div>
              ))}
              <div className="flex items-center justify-between text-xs">
                <button type="button" className="text-slate-500 hover:underline"
                  onClick={() => setParts((ps) => [...ps, { expense_account_id: '', amount: rest > 0 ? rest : 0 }])}>+ Part</button>
                {Math.abs(rest) > 0.02 && <span className="text-amber-600">reste {money(rest, currency)}</span>}
              </div>
            </div>
          )}
          <SlipRow label="Taxe" value={form.tax_code_id && form.tax_code_id !== NO_TAX ? taxName(form.tax_code_id) : 'Aucun code (hors taxes)'}
            edit={(close) => (
              <SearchableSelect value={form.tax_code_id} onChange={(v) => { set('tax_code_id')(v); close() }}
                options={taxCodes} getOptionValue={(t) => String(t.Id)} getOptionLabel={(t) => t.Name}
                emptyOption="Aucune taxe" placeholder="Aucune taxe" />
            )} />
          <SlipRow label="Mémo" value={form.memo || '—'}
            edit={(close) => (
              <input autoFocus className="w-full border border-slate-300 rounded-lg px-2 py-1 text-sm" value={form.memo}
                onChange={(e) => set('memo')(e.target.value)} onBlur={close}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); close() } }} />
            )} />
          {form.qb_type === 'bill' && (
            <SlipRow label="Type" value={`Facture fournisseur${defaults?.due_date ? ` · échéance ${defaults.due_date}` : ''}`}
              edit={(close) => (
                <select autoFocus className="w-full border border-slate-300 rounded-lg px-2 py-1 text-sm bg-white" value={form.qb_type}
                  onChange={(e) => { set('qb_type')(e.target.value); close() }} onBlur={close}>
                  <option value="purchase">Dépense</option>
                  <option value="bill">Facture fournisseur</option>
                </select>
              )} />
          )}
          {!!form.doc_number && <SlipRow label="N°" value={form.doc_number} />}
          <SlipRow label="Reçu" value={doc
            ? <>{doc.label} <span className="text-green-700">✓</span></>
            : txn.invoice_requested || requested
              ? <span className="font-normal text-slate-500">Manquante</span>
              : <button type="button" className="font-normal text-brand-600 hover:underline"
                  onClick={async () => { await api.bank.addInvoiceRequests([txn.id]); invalidate('/bank'); setRequested(true) }}>Demander</button>} />
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 rounded-xl bg-slate-50 px-3.5 py-2.5 text-[12.5px] tabular-nums">
          <span>Avant taxes</span><span className="text-right font-medium">{money(base, currency)}</span>
          <span className="text-slate-500">Taxes{rate ? ` · ${rate.toFixed(3).replace(/\.?0+$/, '')} %` : ''}</span>
          <span className="text-right text-slate-500">{rate === undefined ? '…' : money(taxCad, currency)}</span>
        </div>

        {error && <div className="text-xs text-red-600">{error}</div>}
        <SlipCta label="Ajouter" busy={busy} busyLabel="Publication…" onClick={submit}
          disabled={!form.vendor || (parts ? (Math.abs(rest) > 0.02 || parts.some((p) => !p.expense_account_id)) : !form.expense_account_id)} />
        {!parts && (
          <button type="button" className="self-center -mt-1 text-xs text-slate-500 hover:underline"
            onClick={() => setParts([{ expense_account_id: form.expense_account_id, amount: base }, { expense_account_id: '', amount: 0 }])}>
            Diviser
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3 text-sm">
      {!compact && <div className="text-xs text-slate-500">
        Comptabiliser {money(total, currency)}{draft?.document ? ` · ${draft.document.label}` : ' sans facture'}.
        {/* La règle qui a rempli ces champs : sans elle, on ne saurait pas
            pourquoi le compte et la taxe sont déjà là. */}
        {txn.rule_name && <span className="text-slate-400"> Préparée par la règle « {txn.rule_name} ».</span>}
      </div>}

      {!compact && !!draft?.hints?.length && (
        <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-500 space-y-0.5">
          {draft.hints.map((h) => <div key={h.label}>{h.label} : {h.value}</div>)}
        </div>
      )}

      {/* Disposition de QuickBooks (choix de Charles, 2026-09-29) : les champs
          côte à côte sur une ligne, l'action dessous. */}
      <div className={`grid ${compact ? 'grid-cols-2' : 'grid-cols-4'} gap-x-3 gap-y-2 items-start`}>
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
          <label className={`block${compact ? ' col-span-2' : ''}`}>
            <span className="text-xs text-slate-500">
              Compte de dépense
              {unsure && <span className="ml-1.5 text-amber-600" data-testid="add-unsure">· à vérifier</span>}
            </span>
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

      {!compact && h && (() => {
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
          {busy ? 'Publication…' : compact ? 'Comptabiliser' : 'Ajouter'}
        </button>
      </div>
    </div>
  )
}

// ── « Transfert » : les deux moitiés d'un mouvement interne ─────────────────
// « Ajouter » pour une ENTRÉE sans document (intérêts, remboursement) : un
// dépôt QuickBooks, au compte du dernier dépôt de même libellé.
function DepositForm({ txn, currency, onDone, line = false, next = null, bankAccounts = null }) {
  const [form, setForm] = useState(null)
  // Sur une carte, l'entrée est un crédit de carte : le formulaire « Ajouter ».
  const [card, setCard] = useState(false)
  const [accounts, setAccounts] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  useEffect(() => {
    let alive = true
    setForm(null)
    const xfer = line && next?.kind === 'virement' ? (bankAccounts || []).find((b) => b.id === next.account_id) : null
    api.bank.depositDefaults(txn.id).then((d) => {
      if (alive && d.card) { setCard(true); return }
      if (alive) setForm({ account_id: (xfer?.qb_account_id && String(xfer.qb_account_id)) || d.account_id || '', memo: d.memo || '', source: d.source })
    })
      .catch((e) => { if (alive) { setForm({ account_id: '', memo: '' }); setError(e.message) } })
    api.quickbooks.accounts({ all: 1 }).then((a) => { if (alive) setAccounts(a || []) }).catch(() => {})
    return () => { alive = false }
  }, [txn.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (card) {
    return line
      ? <AddExpenseForm line txn={txn} currency={currency} next={next} bankAccounts={bankAccounts} onDone={onDone} />
      : <AddExpenseForm receipt txn={txn} currency={currency} onDone={onDone} />
  }
  if (!form) return <div className="py-6 text-center text-xs text-slate-400">Chargement…</div>
  const acct = accounts.find((a) => String(a.Id) === String(form.account_id))
  const submit = async () => {
    setBusy(true); setError(null)
    try { await api.bank.addDeposit(txn.id, { account_id: form.account_id, memo: form.memo }); invalidate('/bank'); onDone() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  if (line) {
    const bank = bankOfQb(form.account_id, bankAccounts)
    const go = async () => {
      if (!bank) { await submit(); return }
      setBusy(true); setError(null)
      try { await transferToBank(txn, bank); await onDone('Virement lié') } catch (e) { setError(e.message) } finally { setBusy(false) }
    }
    return (
      <div className="flex flex-col gap-3" data-testid="line-categorize">
        <div className="grid grid-cols-[1.1fr_1.4fr_1fr_0.9fr] gap-x-3.5 gap-y-2.5 max-w-[980px] items-start">
          <LineField label="Catégorie" className="col-span-2" warn={!!form.source?.startsWith('déduit')}>
            <SearchableSelect value={form.account_id} onChange={(v) => setForm((f) => ({ ...f, account_id: v, source: null }))}
              options={accounts} getOptionValue={(a) => String(a.Id)}
              getOptionLabel={(a) => `${a.AcctNum ? `${a.AcctNum} · ` : ''}${a.Name}`} placeholder="Choisir une catégorie" className={LINE_INPUT} />
          </LineField>
          <LineField label="Montant">
            <span className="flex flex-col justify-center min-h-[34px] tabular-nums">
              <span className="font-semibold text-green-700">+ {money(Math.abs(txn.amount), currency)}</span>
              <span className="text-[11px] text-slate-500">{bank ? `virement de ${bank.name}` : 'dépôt'}</span>
            </span>
          </LineField>
          <span />
          <LineField label="Mémo" className="col-span-2">
            <input className={LINE_INPUT} value={form.memo}
              onChange={(e) => setForm((f) => ({ ...f, memo: e.target.value }))} />
          </LineField>
        </div>
        <LineBar txn={txn} error={error}>
          <button type="button" className={LINE_GO} disabled={busy || !form.account_id} onClick={go}>{busy ? 'Publication…' : 'Ajouter'}</button>
        </LineBar>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <div>
        <SlipRow label="Type" value="Dépôt" />
        <SlipRow label="Compte" defaultOpen={!form.account_id}
          value={acct ? <>{acct.AcctNum ? `${acct.AcctNum} · ` : ''}{acct.Name}{form.source && (form.source.startsWith('déduit')
            ? <span className="font-normal text-amber-600"> · à vérifier</span>
            : <span className="font-normal text-slate-400"> · comme le {form.source.replace(/^dépôt du /, '')}</span>)}</> : '—'}
          edit={(close) => (
            <SearchableSelect value={form.account_id} onChange={(v) => { setForm((f) => ({ ...f, account_id: v, source: null })); close() }}
              options={accounts} getOptionValue={(a) => String(a.Id)}
              getOptionLabel={(a) => `${a.AcctNum ? `${a.AcctNum} · ` : ''}${a.Name}`} placeholder="Choisir un compte" />
          )} />
        <SlipRow label="Montant" value={money(Math.abs(txn.amount), currency)} />
        <SlipRow label="Mémo" value={form.memo || '—'}
          edit={(close) => (
            <input autoFocus className="w-full border border-slate-300 rounded-lg px-2 py-1 text-sm" value={form.memo}
              onChange={(e) => setForm((f) => ({ ...f, memo: e.target.value }))} onBlur={close}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); close() } }} />
          )} />
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}
      <SlipCta label="Ajouter" busy={busy} busyLabel="Publication…" onClick={submit} disabled={!form.account_id} />
    </div>
  )
}

function TransferForm({ txn, currency, onDone, onCancel, receipt = false, preferAccountId = null }) {
  const [candidates, setCandidates] = useState(null)
  const [pick, setPick] = useState(null)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)

  useEffect(() => {
    let alive = true
    api.bank.transferCandidates(txn.id)
      .then((c) => { if (alive) { setCandidates(c); setPick((c.find((x) => preferAccountId && x.account_id === preferAccountId) || c[0])?.id || null) } })
      .catch((e) => { if (alive) { setCandidates([]); setError(e.message) } })
    return () => { alive = false }
  }, [txn.id]) // eslint-disable-line react-hooks/exhaustive-deps

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

  if (receipt) {
    if (candidates == null) return <div className="py-6 text-center text-xs text-slate-400">Recherche…</div>
    const others = candidates.filter((c) => c.id !== pick)
    return (
      <div className="flex flex-col gap-3">
        {chosen ? (
          <div>
            <SlipRow label="Vers" value={chosen.account_name} />
            <SlipRow label="Contrepartie" value={<>{fmtDate(chosen.txn_date)} · {chosen.label}</>} />
            <SlipRow label="Montant" value={<>{money(Math.abs(chosen.amount), chosen.currency)}{chosen.fx
              ? <span className="font-normal text-amber-600"> · change ~{chosen.rate}</span> : <span className="text-green-700"> ✓</span>}</>} />
            {chosen.fx && (
              <SlipRow label={`Transféré (${currency})`} value={
                <input type="number" step="0.01" className="w-full border border-slate-300 rounded-lg px-2 py-1 text-sm"
                  value={amount} onChange={(e) => setAmount(e.target.value)} />
              } />
            )}
            {others.length > 0 && (
              <div className="py-2.5 space-y-1">
                {others.map((c) => (
                  <button key={c.id} type="button" onClick={() => setPick(c.id)}
                    className="w-full flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-left hover:bg-slate-50">
                    <span className="min-w-0 grow truncate">{c.account_name} · {c.label}</span>
                    <span className="text-xs text-slate-500">{fmtDate(c.txn_date)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="py-6 text-center text-xs text-slate-500">Aucune contrepartie au même montant.</div>
        )}
        {note && <div className="text-xs text-amber-700">{note}</div>}
        {error && <div className="text-xs text-red-600">{error}</div>}
        {chosen && <SlipCta label="Transférer" busy={busy} busyLabel="Liaison…" onClick={submit}
          disabled={chosen.fx && !(Number(amount) > 0)} />}
      </div>
    )
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

// ── La ligne qui s'ouvre (maquette L3, choix de Charles, 2026-10-06) ───────
// Comme les Opérations bancaires de QuickBooks : un clic sur la transaction
// l'ouvre DESSOUS (plus de panneau à droite). Deux choix seulement —
// Catégoriser, Trouver une correspondance. Un virement se fait en
// catégorisant vers un compte de banque ou de carte (« Enregistrer comme
// transfert » retiré, décision du même jour).

const LINE_BTN = 'h-9 px-5 rounded-full text-[13px] font-semibold whitespace-nowrap disabled:opacity-40'
const LINE_GO = `${LINE_BTN} bg-[#2ca01c] hover:bg-[#248a17] text-white`
const LINE_GHOST = `${LINE_BTN} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`
const LINE_INPUT = 'w-full h-[34px] border border-slate-300 rounded px-2.5 text-sm bg-white'

// Le compte de banque ERP derrière un compte QuickBooks : choisi comme
// catégorie, il fait de la ligne un virement.
const bankOfQb = (qbId, bankAccounts) => (qbId
  ? (bankAccounts || []).find((b) => b.qb_account_id && String(b.qb_account_id) === String(qbId)) || null
  : null)

// Le virement : l'autre moitié est la ligne du compte choisi, au même montant.
async function transferToBank(txn, bank) {
  const candidates = await api.bank.transferCandidates(txn.id)
  const list = Array.isArray(candidates) ? candidates : candidates?.data || []
  const c = list.find((x) => x.account_id === bank.id)
  if (!c) throw new Error(`Aucune ligne de ${bank.name} au même montant (±5 jours).`)
  if (c.fx) throw new Error('Virement entre devises : passer par le Dossier.')
  const r = await api.bank.transfer(txn.id, { counterpart_txn_id: c.id })
  invalidate('/bank')
  if (r?.qbError) throw new Error(`Virement lié, écriture QuickBooks refusée : ${r.qbError}`)
}

// « Bénéficiaire » : la liste de QuickBooks — fournisseurs, clients, employés —
// chacun avec son genre, comme dans QuickBooks. Le nom proposé par l'app qui
// n'y figure pas encore reste choisi : il sera créé comme fournisseur.
const PAYEE_TYPE_FR = { Vendor: 'Fournisseur', Customer: 'Client', Employee: 'Employé' }
const payeesCache = new Map()
function QbPayeeSelect({ name, payeeId, payeeType, currency, onPick }) {
  const [payees, setPayees] = useState(() => payeesCache.get(currency) || null)
  useEffect(() => {
    if (payeesCache.has(currency)) return
    let alive = true
    api.quickbooks.payees(currency).then((r) => { payeesCache.set(currency, r || []); if (alive) setPayees(r || []) }).catch(() => { if (alive) setPayees([]) })
    return () => { alive = false }
  }, [currency])
  const norm = (v) => String(v || '').trim().toLowerCase()
  const list = payees || []
  const chosen = (payeeId && list.find((p) => p.id === payeeId && p.type === payeeType))
    || (name && list.find((p) => norm(p.name) === norm(name))) || null
  // Le choix de l'app retrouvé dans la liste : on retient l'id QuickBooks.
  useEffect(() => {
    if (chosen && (chosen.id !== payeeId || chosen.type !== payeeType)) onPick(chosen)
  }, [chosen?.id, chosen?.type]) // eslint-disable-line react-hooks/exhaustive-deps
  const options = chosen || !name ? list : [{ id: '', name, type: 'new' }, ...list]
  const key = (p) => `${p.type}:${p.id}`
  return (
    <SearchableSelect value={chosen ? key(chosen) : name ? 'new:' : ''} options={options} getOptionValue={key}
      getOptionLabel={(p) => p.name} placeholder={payees ? 'Choisir un bénéficiaire' : 'Chargement…'} className={LINE_INPUT}
      renderOption={(p) => (
        <span className="flex items-center justify-between gap-3 min-w-0">
          <span className="truncate">{p.name}</span>
          <span className="shrink-0 text-[11px] text-slate-400">{p.type === 'new' ? 'nouveau fournisseur' : PAYEE_TYPE_FR[p.type]}</span>
        </span>
      )}
      onChange={(v) => { const p = options.find((o) => key(o) === v); if (p) onPick(p) }} />
  )
}

function LineField({ label, warn, className = '', children }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="block mb-1 text-[11.5px] text-slate-500">
        {label}{warn && <span className="ml-1.5 text-amber-600" data-testid="add-unsure">· à vérifier</span>}
      </span>
      {children}
    </label>
  )
}

// Le pied de la ligne ouverte : le libellé brut de la banque à gauche, les
// gestes à droite.
function LineBar({ txn, error, children }) {
  const raw = [txn.details, txn.description].filter(Boolean)[0]
  return (
    <div className="flex flex-col gap-2 pt-3 border-t border-slate-200">
      {error && <div className="text-xs text-red-600">{error}</div>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {raw && <span className="min-w-0 truncate text-xs text-slate-500">Détail bancaire <span className="ml-1.5 font-mono text-[11.5px] text-slate-600">{raw}</span></span>}
        <span className="grow" />
        {children}
      </div>
    </div>
  )
}

function QboLine({ txn, currency, next, bankAccounts, accountName, onChanged, collapse }) {
  const sg = txn.suggestion
  const [mode, setMode] = useState(() => (
    next?.kind === 'apparier' || (sg && sg.kind !== 'vendor_expense') ? 'match' : 'cat'))
  const done = async (label) => { celebrate(typeof label === 'string' ? label : 'Fait'); collapse?.(); await onChanged() }
  const modes = [['cat', 'Catégoriser'], ['match', 'Trouver une correspondance']]
  const kind = (bankAccounts || []).find((b) => b.id === txn.account_id)?.kind
  const ops = opTypesFor(txn, kind)
  const [op, setOp] = useState(() => defaultOp(txn, next, kind, bankAccounts))
  return (
    <div className="px-5 py-3.5 flex flex-col gap-3 bg-slate-50 text-sm cursor-default" data-testid="qbo-line"
      onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap gap-6" role="radiogroup">
        {modes.map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => setMode(k)}
            className={`flex items-center gap-2 ${mode === k ? 'font-semibold text-slate-900' : 'text-slate-600'}`}>
            <span className={`relative w-4 h-4 rounded-full border-[1.5px] bg-white ${mode === k ? 'border-[#2ca01c]' : 'border-slate-300'}`}>
              {mode === k && <span className="absolute inset-[3px] rounded-full bg-[#2ca01c]" />}
            </span>
            {l}
          </button>
        ))}
      </div>
      {txn._flag && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800"><b>À vérifier</b> · {txn._flag}</div>
      )}
      {mode === 'cat' && (
        <div className="max-w-[240px]">
          <LineField label="Type d'opération">
            <select className={`${LINE_INPUT} w-full font-semibold`} value={op} data-testid="op-type"
              onChange={(e) => setOp(e.target.value)}>
              {ops.map((k) => <option key={k} value={k}>{OP_TYPES[k]}</option>)}
            </select>
          </LineField>
        </div>
      )}
      {mode === 'cat'
        ? <LineOpForm key={op} op={op} txn={txn} currency={currency} next={next} bankAccounts={bankAccounts} onDone={done} />
        : <LineMatch txn={txn} currency={currency} accountName={accountName} onDone={done} onAdd={() => setMode('cat')} />}
    </div>
  )
}

// « Type d'opération » (maquette K1, Charles 2026-10-06) : comme dans
// QuickBooks, le type choisi refait les champs à remplir.
const OP_TYPES = {
  depense: 'Dépense', cheque: 'Chèque', facture: 'Paiement de facture', virement: 'Virement',
  carte: 'Paiement de carte', depot: 'Dépôt', client: 'Paiement client', credit: 'Remboursement fournisseur',
}
function opTypesFor(txn, kind) {
  if (txn.amount < 0) return kind === 'card' ? ['depense', 'facture', 'virement'] : ['depense', 'cheque', 'facture', 'virement', 'carte']
  return kind === 'card' ? ['carte', 'credit', 'virement'] : ['depot', 'client', 'virement']
}
// Le compte bancaire que la ligne vise déjà : virement détecté, ou catégorie
// d'une règle / d'une habitude qui est le compte QuickBooks d'un autre compte
// (« M/CARD AFFAIRES » → 22000 Mastercard = paiement de la carte).
function targetBank(txn, next, bankAccounts) {
  if (next?.kind === 'virement' && next.account_id) return (bankAccounts || []).find((b) => b.id === next.account_id) || null
  const qb = next?.expense_account_id || (txn.suggestion?.kind === 'vendor_expense' ? txn.suggestion.payload?.expense_account_id : null)
  const b = bankOfQb(qb, bankAccounts)
  return b && b.id !== txn.account_id ? b : null
}
function defaultOp(txn, next, kind, bankAccounts) {
  const target = targetBank(txn, next, bankAccounts)
  if (next?.kind === 'virement' || target) {
    const other = target
    return (other?.kind === 'card' && kind !== 'card') || (kind === 'card' && txn.amount > 0) ? 'carte' : 'virement'
  }
  if (txn.amount < 0) return txn.check_number ? 'cheque' : 'depense'
  if (kind === 'card') return 'credit'
  return /paiement|transfert|interac|virement/i.test(`${txn.description || ''} ${txn.details || ''}`) && !/stripe/i.test(txn.description || '') ? 'client' : 'depot'
}

function LineOpForm({ op, txn, currency, next, bankAccounts, onDone }) {
  // Une dépense ne doit pas reprendre le compte d'un virement détecté.
  const plain = next?.kind === 'virement' ? null : next
  if (op === 'depense' || op === 'cheque') return <AddExpenseForm line opType={op} txn={txn} currency={currency} next={plain} bankAccounts={bankAccounts} onDone={onDone} />
  if (op === 'depot' || op === 'credit') return <DepositForm line txn={txn} currency={currency} next={plain} bankAccounts={bankAccounts} onDone={onDone} />
  if (op === 'virement' || op === 'carte') return <LineTransfer card={op === 'carte'} txn={txn} currency={currency} next={next} bankAccounts={bankAccounts} onDone={onDone} />
  if (op === 'facture') return <LineBillPay txn={txn} currency={currency} onDone={onDone} />
  if (op === 'client') return <LineClientPay txn={txn} currency={currency} onDone={onDone} />
  return null
}

// Virement / Paiement de carte : l'autre compte, et sa ligne au même montant.
function LineTransfer({ card, txn, currency, next, bankAccounts, onDone }) {
  const self = (bankAccounts || []).find((b) => b.id === txn.account_id)
  const options = (bankAccounts || []).filter((b) => b.id !== txn.account_id
    && (!card || (self?.kind === 'card' ? b.kind !== 'card' : b.kind === 'card')))
  const [to, setTo] = useState(() => {
    const t = targetBank(txn, next, bankAccounts)
    return (options.find((b) => b.id === t?.id) || (options.length === 1 ? options[0] : null))?.id || ''
  })
  const [cands, setCands] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  useEffect(() => {
    let alive = true
    api.bank.transferCandidates(txn.id).then((r) => { if (alive) setCands(Array.isArray(r) ? r : r?.data || []) }).catch(() => { if (alive) setCands([]) })
    return () => { alive = false }
  }, [txn.id])
  const bank = options.find((b) => b.id === to)
  const match = bank && cands ? cands.find((c) => c.account_id === bank.id) : null
  const out = txn.amount < 0
  const go = async () => {
    setBusy(true); setError(null)
    try {
      if (match) await transferToBank(txn, bank)
      else {
        const r = await api.bank.qbTransfer(txn.id, { bank_account_id: bank.id })
        invalidate('/bank')
        if (r?.qbError) throw new Error(r.qbError)
      }
      await onDone(card ? 'Carte payée' : 'Virement enregistré')
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const picker = (
    <SearchableSelect value={to} onChange={setTo} options={options} getOptionValue={(b) => b.id}
      getOptionLabel={(b) => b.name} placeholder="Choisir un compte" className={LINE_INPUT} />
  )
  const here = <span className="flex items-center min-h-[34px] font-medium text-slate-800">{self?.name || '—'}</span>
  return (
    <div className="flex flex-col gap-3" data-testid="line-transfer">
      <div className="grid grid-cols-[1.1fr_1.4fr_1fr_0.9fr] gap-x-3.5 gap-y-2.5 max-w-[980px] items-start">
        <LineField label={card ? (out ? 'Depuis' : 'Payée depuis') : 'Depuis'}>{out ? here : picker}</LineField>
        <LineField label={card ? 'Carte payée' : 'Vers'}>{out ? picker : here}</LineField>
        <LineField label="Montant">
          <span className="flex flex-col justify-center min-h-[34px] tabular-nums">
            <span className="font-semibold text-slate-900">{money(Math.abs(txn.amount), currency)}</span>
            {bank && <span className={`text-[11px] ${match ? 'text-green-700' : 'text-slate-500'}`}>
              {cands === null ? '…' : match ? `ligne du ${fmtDate(match.txn_date)} ✓` : 'pas encore au relevé de ce compte'}
            </span>}
          </span>
        </LineField>
      </div>
      <LineBar txn={txn} error={error}>
        <button type="button" className={LINE_GO} disabled={busy || !bank || cands === null || !!match?.fx || (!match && !bank.qb_account_id)} onClick={go}>
          {busy ? 'Publication…' : card ? 'Payer la carte' : 'Enregistrer le virement'}
        </button>
      </LineBar>
    </div>
  )
}

// Paiement de facture : la facture fournisseur ouverte que ce débit règle.
function LineBillPay({ txn, currency, onDone }) {
  const [bills, setBills] = useState(null)
  const [pick, setPick] = useState(null)
  const [vendor, setVendor] = useState('')
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const amt = Math.abs(txn.amount)
  const due = (b) => Number(b.balance_due_cad ?? b.total_cad) || 0
  useEffect(() => {
    let alive = true
    api.treasury.payments.openBills().then((r) => {
      if (!alive) return
      const list = (Array.isArray(r) ? r : r?.data || []).filter((b) => (b.currency || 'CAD') === (currency || 'CAD'))
      list.sort((a, b) => Math.abs(due(a) - amt) - Math.abs(due(b) - amt))
      setBills(list)
      const exact = list.find((b) => Math.abs(due(b) - amt) < 0.01)
      if (exact) { setPick(exact.id); setVendor(exact.vendor || '') }
    }).catch((e) => { if (alive) { setBills([]); setError(e.message) } })
    return () => { alive = false }
  }, [txn.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const vendors = [...new Set((bills || []).map((b) => b.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const shown = (bills || []).filter((b) => !vendor || b.vendor === vendor).slice(0, 8)
  const go = async () => {
    setBusy(true); setError(null)
    try { await api.bank.payBill(txn.id, { achat_id: pick, memo }); invalidate('/bank'); await onDone('Facture payée') }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="flex flex-col gap-3" data-testid="line-billpay">
      <div className="grid grid-cols-[1.1fr_1.4fr_1fr_0.9fr] gap-x-3.5 gap-y-2.5 max-w-[980px] items-start">
        <LineField label="Fournisseur" className="col-span-2">
          <SearchableSelect value={vendor} onChange={(v) => { setVendor(v || ''); setPick(null) }} options={vendors}
            getOptionValue={(v) => v} getOptionLabel={(v) => v} emptyOption="Tous" placeholder="Tous" className={LINE_INPUT} />
        </LineField>
        <LineField label="Montant">
          <span className="flex items-center min-h-[34px] font-semibold text-slate-900 tabular-nums">{money(amt, currency)}</span>
        </LineField>
      </div>
      <div className="max-w-[760px] rounded-md border border-slate-200 bg-white">
        {bills === null ? <div className="px-3 py-3 text-xs text-slate-400">Chargement…</div>
          : !shown.length ? <div className="px-3 py-3 text-xs text-slate-500">Aucune facture ouverte</div>
          : shown.map((b) => {
            const on = pick === b.id
            return (
              <button key={b.id} type="button" onClick={() => { setPick(b.id); setVendor(b.vendor || '') }}
                className={`w-full grid grid-cols-[18px_1fr_110px_90px_110px] items-center gap-3 px-3 py-2 text-left text-[13px] border-b border-slate-100 last:border-0 ${on ? 'bg-green-50' : 'hover:bg-slate-50'}`}>
                <span className={`w-3.5 h-3.5 rounded-[3px] border-[1.5px] ${on ? 'bg-[#2ca01c] border-[#2ca01c]' : 'border-slate-300'}`} />
                <span className="truncate">{b.vendor}</span>
                <span className="truncate text-slate-500">{b.vendor_invoice_number || b.bill_number || '—'}</span>
                <span className="text-slate-500">{b.due_date ? fmtDate(b.due_date) : ''}</span>
                <span className={`text-right tabular-nums ${Math.abs(due(b) - amt) < 0.01 ? 'text-green-700 font-semibold' : ''}`}>{money(due(b), b.currency)}</span>
              </button>
            )
          })}
      </div>
      <div className="grid grid-cols-[1.1fr_1.4fr_1fr_0.9fr] gap-x-3.5 max-w-[980px]">
        <LineField label="Mémo" className="col-span-2">
          <input className={LINE_INPUT} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </LineField>
      </div>
      <LineBar txn={txn} error={error}>
        <button type="button" className={LINE_GO} disabled={busy || !pick} onClick={go}>{busy ? 'Publication…' : 'Payer la facture'}</button>
      </LineBar>
    </div>
  )
}

// Paiement client : la facture que cet encaissement règle (le même reçu que
// le panneau, avec dépôt QuickBooks et Stripe marqué payé).
function LineClientPay({ txn, currency, onDone }) {
  const { dossier } = useDossier(txn.id)
  if (!dossier) return <div className="py-4 text-xs text-slate-400">Chargement…</div>
  return (
    <div className="flex flex-col gap-3 max-w-[520px]" data-testid="line-clientpay">
      <InvoiceSlip txn={txn} invoices={dossier.invoices || []} ambiguous={dossier.invoices_ambiguous} currency={currency} onDone={() => onDone('Paiement reçu')} />
      <LineBar txn={txn} />
    </div>
  )
}

// « Trouver une correspondance » : la proposition d'un moteur s'il y en a une
// (paiement émis, écriture QuickBooks retrouvée…), sinon les pièces au même
// montant, côte à côte avec la ligne de banque.
function LineMatch({ txn, currency, accountName, onDone, onAdd }) {
  const [props, setProps] = useState(txn.proposal_count > 0 ? null : 0)
  return (
    <div className="flex flex-col gap-3 max-w-[760px]">
      {txn.proposal_count > 0 && <ProposalCards line accountName={accountName} txn={txn} currency={currency} onChanged={() => onDone('Apparié')} onCount={setProps} />}
      {props === 0 && <QbMatchPane txn={txn} currency={currency} onChanged={() => onDone('Apparié')} onAdd={onAdd} />}
      <LineBar txn={txn} />
    </div>
  )
}

// La colonne « Catégorie ou correspondance » : ce que la ligne deviendra, en
// un nom ; dessous, seulement ce qui cloche.
const WARN_EVIDENCE = /écart|décal|autre compte/i
function lineWarning(row) {
  if (row._flag) return row._flag
  const e = (row.suggestion?.evidence || []).find((x) => WARN_EVIDENCE.test(x.label || ''))
  return e ? `${e.label}${e.detail ? ` ${e.detail}` : ''}` : null
}
function QboCatCell({ row, next, names, currency, bankAccounts }) {
  const tag = (t, cls) => <span className={`shrink-0 text-[10px] font-semibold rounded px-1.5 py-px ${cls}`}>{t}</span>
  const warn = lineWarning(row)
  const line2 = warn ? <span className="block truncate text-[11.5px] text-amber-600" title={warn}>{warn}</span>
    : row.invoice_requested ? <span className="block truncate text-[11.5px] text-slate-400">facture manquante</span> : null
  const wrap = (name, t, cls = 'text-slate-700') => (
    <span className="block min-w-0" data-testid="qbo-cat">
      <span className="flex items-center gap-1.5 min-w-0"><span className={`truncate ${cls}`}>{name}</span>{t}</span>
      {line2}
    </span>
  )
  const sg = row.suggestion
  if (next?.kind === 'virement' || row.transfer_txn_id) {
    const bank = (bankAccounts || []).find((b) => b.id === next?.account_id)
    return wrap(bank?.name || next?.label || 'Virement', tag('Virement', 'bg-sky-50 text-sky-700'))
  }
  if (sg?.kind === 'qb_habit') {
    const p = sg.payload || {}
    return wrap(p.account_name || p.label, tag(p.entity === 'deposit' ? 'Dépôt' : 'Virement', 'bg-sky-50 text-sky-700'))
  }
  if (sg?.kind === 'vendor_expense') {
    const p = sg.payload || {}
    return wrap(nameIn(names?.accounts, p.expense_account_id) || p.vendor || 'Dépense')
  }
  if (sg) {
    const p = sg.payload || {}
    const what = sg.kind === 'payment_clear' ? (p.label || 'Paiement émis')
      : sg.kind === 'qb_link' ? `${QB_TYPE_FR[String(p.qb_txn_type || '').toLowerCase()] || 'Écriture'}${p.date ? ` du ${fmtDate(p.date)}` : ''}`
        : suggestionText(sg, names, currency).what
    return wrap(what, tag('Correspondance', 'bg-green-50 text-green-700'), 'font-semibold text-green-700')
  }
  if (next?.kind === 'apparier') return wrap(row.matched_label || next?.label || 'Correspondance', tag('Correspondance', 'bg-green-50 text-green-700'), 'font-semibold text-green-700')
  if (next?.kind === 'exclure') return wrap('Hors comptabilité', next?.label ? tag('Règle', 'bg-slate-100 text-slate-500') : null, 'text-slate-500')
  if (next?.kind === 'comptabiliser' && next.label) return wrap(next.label)
  if (next?.kind === 'publier') {
    // Une règle importée de QuickBooks n'a souvent que son nom : on ne le fait
    // pas passer pour une catégorie.
    const acct = nameIn(names?.accounts, next.expense_account_id)
    if (acct) return wrap(acct, tag('Règle', 'bg-slate-100 text-slate-500'))
  }
  // L'habitude du fournisseur : proposée, pas encore décidée.
  const habit = nameIn(names?.accounts, next?.expense_account_id)
  if (habit) return wrap(habit, null, 'text-slate-500 italic')
  return wrap('Non catégorisé', null, 'text-slate-400')
}
// Le lien « Action » : le geste de la ligne. Il ouvre la ligne (tout est déjà
// rempli dessous) ; une règle « Exclure » s'applique d'un clic.
function QboActCell({ row, next, onChanged }) {
  const [busy, setBusy] = useState(false)
  const sg = row.suggestion
  const match = next?.kind === 'apparier' || (sg && sg.kind !== 'vendor_expense')
  const label = next?.kind === 'exclure' ? 'Exclure' : match ? 'Apparier' : 'Ajouter'
  const warn = !!lineWarning(row)
  return (
    <button type="button" disabled={busy} data-testid="qbo-act"
      className={`text-[13px] font-semibold hover:underline disabled:opacity-50 ${warn ? 'text-amber-600' : 'text-[#0077c5]'}`}
      onClick={async (e) => {
        if (next?.kind !== 'exclure') return
        e.stopPropagation(); setBusy(true)
        try { await api.bank.updateTransaction(row.id, { status: 'ignore' }); invalidate('/bank'); celebrate('Exclue'); await onChanged() } finally { setBusy(false) }
      }}>
      {label}
    </button>
  )
}

// ── Drawer latéral : détail + suggestions de matching ────────────────────────
// Ce qu'un moteur a trouvé et qui attend une décision. La preuve est écrite en
// français par le serveur et affichée telle quelle : c'est elle qui permet de
// trancher en une seconde, pas la confiance en pourcentage.
// Un refus est DÉFINITIF — la proposition ne reviendra pas au prochain passage.
const QB_TYPE_FR = { expense: 'Dépense', purchase: 'Dépense', deposit: 'Dépôt', transfer: 'Virement', billpayment: 'Paiement de facture', bill: 'Facture', journalentry: 'Écriture de journal', payment: 'Paiement', check: 'Chèque', creditcardcredit: 'Crédit de carte', creditcardpayment: 'Paiement de carte' }

function ProposalCards({ txn, currency, onChanged, slip = false, line = false, accountName = null, onCount }) {
  const [items, setItems] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const load = () => api.bank.txnProposals(txn.id).then(setItems).catch(() => setItems([]))
  useEffect(() => { setItems(null); setError(null); load() }, [txn.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const openCount = (items || []).filter((p) => p.status === 'proposee').length
  useEffect(() => { if (items) onCount?.(openCount) }, [items, openCount]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // Ligne ouverte (L3) : la banque et ce que le moteur a trouvé côte à côte,
  // ✓ quand ça concorde, ! en orange sur ce qui cloche.
  if (line) {
    const p = open[0]
    const pl = p.payload || {}
    const type = p.kind === 'payment_clear' ? 'Paiement émis'
      : QB_TYPE_FR[String(pl.qb_txn_type || '').toLowerCase()] || PROPOSAL_TITLE[p.kind] || 'Écriture'
    const warns = (p.evidence || []).filter((e) => WARN_EVIDENCE.test(e.label || ''))
    const off = (re) => warns.some((e) => re.test(e.label || ''))
    const amt = pl.payment_amount ?? pl.amount ?? null
    const bank = [
      ['Qui', txn.vendor_name || txnLabel(txn)],
      ['Montant', money(Math.abs(txn.amount), currency)],
      ['Date', fmtDate(txn.txn_date)],
      ['Compte', accountName || '—'],
    ]
    const qb = [
      ['Qui', pl.label || pl.vendor || pl.debt || '—', pl.label || pl.vendor || pl.debt ? false : undefined],
      ['Montant', amt != null ? money(Math.abs(amt), currency) : money(Math.abs(txn.amount), currency), off(/montant/i)],
      ['Date', fmtDate(pl.payment_date || pl.date) || '—', off(/date|décal/i)],
      ['Compte', pl.account_name || accountName || '—', off(/autre compte/i)],
    ]
    const side = (title, rows) => (
      <div className="min-w-0 px-3.5 py-2.5">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{title}</div>
        {rows.map(([k, v, w]) => (
          <div key={k} className="grid grid-cols-[70px_1fr_14px] gap-2 py-0.5 text-[13px]">
            <span className="text-slate-500">{k}</span>
            <span className={`truncate font-medium ${w ? 'text-amber-600' : 'text-slate-800'}`}>{v}</span>
            {w === undefined ? <span /> : w ? <AlertTriangle size={12} className="mt-1 text-amber-600" /> : <Check size={13} className="mt-0.5 text-green-600" />}
          </div>
        ))}
      </div>
    )
    return (
      <div className="flex flex-col gap-3" data-testid="proposal-cards">
        {warns.length > 0 && (
          <div className="rounded-md bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">
            <b>À vérifier</b> · {warns.map((e) => `${e.label}${e.detail ? ` ${e.detail}` : ''}`).join(' · ')}
          </div>
        )}
        <div className="grid grid-cols-2 divide-x divide-slate-300 rounded-md border border-slate-300 bg-white max-w-[640px]">
          {side('Banque', bank)}
          {side(`QuickBooks · ${type}`, qb)}
        </div>
        {error && <div className="text-xs text-red-600">{error}</div>}
        <div className="flex items-center gap-4 max-w-[640px]">
          <button type="button" className="text-[13px] font-medium text-red-600 hover:underline disabled:opacity-50"
            title="Définitif : cette proposition ne reviendra pas" disabled={busy === p.id} onClick={() => decide(p, false)}>
            Ce n'est pas ça
          </button>
          <span className="grow" />
          <button type="button" disabled={busy === p.id} onClick={() => decide(p, true)}
            className={`${LINE_BTN} text-white ${warns.length ? 'bg-amber-600 hover:bg-amber-700' : 'bg-[#2ca01c] hover:bg-[#248a17]'}`}>
            {busy === p.id ? '…' : 'Apparier'}
          </button>
        </div>
      </div>
    )
  }

  // Le panneau « reçu » : la proposition se lit comme le reste — une ligne par
  // fait, les preuves en ✓, un seul gros bouton.
  if (slip) {
    const p = open[0]
    const pl = p.payload || {}
    const type = QB_TYPE_FR[String(pl.qb_txn_type || '').toLowerCase()] || pl.qb_txn_type || 'Écriture'
    return (
      <div className="flex flex-col gap-3" data-testid="proposal-cards">
        <div className="text-center text-xs text-slate-500">
          {PROPOSAL_TITLE[p.kind] || p.kind}{p.confidence != null ? ` · ${Math.round(p.confidence * 100)} %` : ''}
        </div>
        <div>
          {pl.qb_txn_id && <SlipRow label="QuickBooks" value={`${type} n° ${pl.qb_txn_id}`} />}
          {pl.date && <SlipRow label="Date" value={fmtDate(pl.date)} />}
          {pl.account_name && <SlipRow label="Compte" value={pl.account_name} />}
          {(p.evidence || []).map((e, i) => (
            <SlipRow key={i} label={e.label} value={<span className="font-normal">{e.detail || <Check size={13} className="inline text-green-600" />}</span>} />
          ))}
        </div>
        {error && <div className="text-xs text-red-600">{error}</div>}
        <SlipCta label="C'est bien ça" busy={busy === p.id} busyLabel="…" onClick={() => decide(p, true)} />
        <button type="button" className="self-center text-xs text-red-600 hover:underline disabled:opacity-50"
          title="Définitif : cette proposition ne reviendra pas" disabled={busy === p.id} onClick={() => decide(p, false)}>
          Ce n'est pas ça
        </button>
      </div>
    )
  }

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
  qb_habit: 'Comme d\'habitude',
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
    case 'qb_habit':
      return { what: p.label || 'Comme d\'habitude', facts: [p.n && `${p.n} fois`], proof: [] }
    case 'vendor_expense': {
      const acct = nameIn(names?.accounts, p.expense_account_id)
      const tax = p.tax_code_id === '__none__' ? 'sans taxe' : nameIn(names?.taxCodes, p.tax_code_id)
      return { what: `Dépense · ${p.vendor || '?'}`, facts: [acct && `→ ${acct}`, tax], proof: [] }
    }
    default:
      return { what: PROPOSAL_TITLE[sg.kind] || sg.kind, facts: [], proof }
  }
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
// Maquette N4 (choix de Charles, 2026-10-03) : à gauche la ligne du relevé, à
// droite l'écriture que QuickBooks recevra — chaque ligne se clique pour être
// changée. Dépense (sur un ou plusieurs comptes, en % ou en $), virement vers
// un compte, ou exclusion ; mémo facultatif.
const RULE_ACTIONS = [['depense', 'Dépense'], ['virement', 'Virement'], ['exclure', 'Exclure']]

function RuleFromTxnForm({ txn }) {
  const [draft, setDraft] = useState(null)
  const [names, setNames] = useState(null)
  const [banks, setBanks] = useState([])
  const [rate, setRate] = useState(null)
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState(null)
  // Ce libellé revient-il assez pour mériter une règle ? Boréal ne le propose
  // qu'à partir de la troisième fois, et seulement si rien ne le couvre déjà.
  const [chance, setChance] = useState(null)

  useEffect(() => {
    let alive = true
    setDraft(null); setDone(false); setChance(null)
    api.bank.rules.opportunity(txn.id).then((o) => { if (alive) setChance(o) }).catch(() => {})
    return () => { alive = false }
  }, [txn.id])

  const taxId = draft?.tax_code_id
  useEffect(() => {
    if (!taxId || taxId === NO_TAX) { setRate(null); return undefined }
    let alive = true
    api.bank.taxCodeRate(taxId).then((r) => { if (alive) setRate(r.percent) }).catch(() => { if (alive) setRate(null) })
    return () => { alive = false }
  }, [taxId])

  const open = async () => {
    setBusy(true); setError(null)
    try {
      const d = await api.bank.rules.draftFromTxn(txn.id)
      let sp = d.splits
      if (typeof sp === 'string') { try { sp = JSON.parse(sp) } catch { sp = null } }
      setDraft({
        ...d,
        action: d.action || 'depense',
        mode: sp?.mode || 'pct',
        lines: sp?.lines?.length ? sp.lines.map((l) => ({ account_id: String(l.account_id), value: Number(l.value) }))
          : [{ account_id: d.expense_account_id ? String(d.expense_account_id) : '', value: 100 }],
      })
      if (!names) {
        Promise.all([api.quickbooks.accounts(), api.quickbooks.taxCodes()])
          .then(([a, t]) => setNames({ accounts: a || [], taxCodes: t || [] })).catch(() => {})
      }
      if (!banks.length) api.bank.accounts().then((r) => setBanks((r || []).filter((x) => x.id !== txn.account_id))).catch(() => {})
    }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }))
  const setLine = (i, patch) => setDraft((d) => ({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }))

  const save = async () => {
    setBusy(true); setError(null)
    try {
      const { preview: _p, lines, mode, ...rule } = draft
      rule.name = rule.name || rule.label_pattern.slice(0, 40)
      if (rule.action === 'depense') {
        const ok = lines.filter((l) => l.account_id)
        rule.expense_account_id = ok[0]?.account_id || null
        rule.splits = ok.length >= 2 ? { mode, lines: ok } : null
        rule.transfer_account_id = null
      } else {
        // Un virement ou une exclusion ne retient rien de la façon de comptabiliser.
        Object.assign(rule, { vendor_name: null, expense_account_id: null, tax_code_id: null, qb_type: null, splits: null })
        if (rule.action === 'exclure') rule.transfer_account_id = null
      }
      await api.bank.rules.create(rule)
      celebrate('Règle créée')
      setDone(true); setDraft(null)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  if (done) return <Link to="/regles-bancaires" className="text-xs text-emerald-700 hover:underline">Règle créée — la voir</Link>
  if (!draft) {
    if (chance) {
      return (
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 px-3 py-2">
          <span className="text-lg font-bold tabular-nums text-slate-900">{chance.lines}×</span>
          <span className="text-xs text-slate-500 flex-1 min-w-0 truncate">en {chance.months} mois</span>
          <button type="button" className="shrink-0 h-7 px-3 rounded-full bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700"
            disabled={busy} onClick={open}>Chaque fois pareil</button>
          <button type="button" aria-label="Plus tard" className="shrink-0 text-slate-300 hover:text-slate-600"
            onClick={() => setChance(null)}><X size={14} /></button>
        </div>
      )
    }
    return (
      <div>
        <button type="button" className="text-xs text-slate-500 hover:text-brand-600 hover:underline"
          disabled={busy} onClick={open}>Chaque fois pareil</button>
        {error && <div className="text-xs text-red-600">{error}</div>}
      </div>
    )
  }

  const nameOf = (list, id) => (list || []).find((o) => String(o.Id) === String(id))?.Name || null
  const acctName = (id) => (id ? nameOf(names?.accounts, id)?.split(':').pop() || 'compte choisi' : 'Choisir un compte')
  const total = Math.abs(txn.amount)
  const tax = rate ? Math.round((total - total / (1 + rate / 100)) * 100) / 100 : 0
  const base = Math.round((total - tax) * 100) / 100
  const sum = draft.lines.reduce((n, l) => n + (Number(l.value) || 0), 0)
  const amounts = draft.lines.map((l, i) => {
    if (draft.mode === 'amount') return Number(l.value) || 0
    if (i === draft.lines.length - 1 && Math.abs(sum - 100) < 0.01) {
      return Math.round((base - draft.lines.slice(0, -1).reduce((n, x) => n + Math.round(base * x.value) / 100, 0)) * 100) / 100
    }
    return Math.round(base * (Number(l.value) || 0)) / 100
  })
  const off = draft.lines.length > 1 && (draft.mode === 'pct' ? Math.abs(sum - 100) > 0.01 : Math.abs(sum - base) > 0.02)
  const acctPicker = (value, onPick) => (
    <SearchableSelect value={value} onChange={onPick}
      options={names?.accounts || []} getOptionValue={(a) => String(a.Id)}
      getOptionLabel={(a) => `${a.AcctNum ? `${a.AcctNum} · ` : ''}${a.Name}`} placeholder="Choisir un compte" />
  )
  const row = 'grid grid-cols-[1fr_auto_auto] gap-x-3 items-center py-1 px-1 -mx-1 rounded cursor-pointer hover:bg-slate-50'
  const fmt = (n) => n.toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const valid = draft.label_pattern.trim().length >= 3 && (
    draft.action === 'exclure' || (draft.action === 'virement' ? !!draft.transfer_account_id
      : draft.lines.every((l) => l.account_id) && !off))

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 p-3" data-testid="rule-n4">
      <div className="grid grid-cols-[1fr_20px_1.5fr] gap-2 items-center">
        <div className="rounded-lg border border-slate-200 p-2 min-w-0">
          <input value={draft.label_pattern} aria-label="Si le libellé contient"
            className="w-full font-mono text-[11px] text-slate-600 bg-transparent outline-none focus:text-slate-900"
            onChange={(e) => set({ label_pattern: e.target.value, name: e.target.value.slice(0, 40) })} />
          <div className="text-[15px] font-semibold tabular-nums text-right">−{fmt(total)}</div>
        </div>
        <span className="text-center text-slate-300">→</span>
        <div className={`rounded-lg border-[1.5px] p-2 min-w-0 text-[12.5px] ${draft.action === 'exclure' ? 'border-slate-300' : 'border-green-600'}`}>
          {draft.action === 'depense' && (
            <>
              {editing === 'vendor'
                ? <VendorSelect value={draft.vendor_name || ''} onChange={({ vendor }) => { set({ vendor_name: vendor || null }); if (vendor) setEditing(null) }} />
                : <button type="button" className="block w-full text-left text-[11px] text-slate-500 truncate hover:text-slate-800"
                    onClick={() => setEditing('vendor')}>Dépense · {draft.vendor_name || <span className="text-amber-600">fournisseur ?</span>}</button>}
              {draft.lines.map((l, i) => (editing === `l${i}` ? (
                <div key={i} className="flex items-center gap-1.5 py-1">
                  <div className="grow min-w-0">{acctPicker(l.account_id, (v) => setLine(i, { account_id: v }))}</div>
                  {draft.lines.length > 1 && (
                    <input type="number" step="0.01" value={l.value} aria-label={draft.mode === 'pct' ? '%' : '$'}
                      className="w-16 border border-slate-300 rounded px-1.5 py-1 text-right text-xs"
                      onChange={(e) => setLine(i, { value: Number(e.target.value) })} />
                  )}
                  {draft.lines.length > 1 && (
                    <button type="button" aria-label="Retirer" className="text-slate-300 hover:text-red-600"
                      onClick={() => { setDraft((d) => ({ ...d, lines: d.lines.filter((_, j) => j !== i) })); setEditing(null) }}><X size={13} /></button>
                  )}
                  <button type="button" aria-label="OK" className="text-green-600" onClick={() => setEditing(null)}><Check size={14} /></button>
                </div>
              ) : (
                <div key={i} className={row} onClick={() => setEditing(`l${i}`)}>
                  <span className={`pl-3 truncate ${l.account_id ? '' : 'text-amber-600'}`}>{acctName(l.account_id)}</span>
                  <span className="text-[11px] text-slate-400">{draft.lines.length > 1 ? (draft.mode === 'pct' ? `${l.value} %` : '') : ''}</span>
                  <span className="tabular-nums">{fmt(amounts[i])}</span>
                </div>
              )))}
              {editing === 'tax' ? (
                <SearchableSelect value={draft.tax_code_id || ''} onChange={(v) => { set({ tax_code_id: v || null }); setEditing(null) }}
                  options={names?.taxCodes || []} getOptionValue={(t) => String(t.Id)} getOptionLabel={(t) => t.Name}
                  emptyOption="Aucune taxe" placeholder="Aucune taxe" />
              ) : (
                <div className={row} onClick={() => setEditing('tax')}>
                  <span className="pl-3 truncate text-slate-600">{draft.tax_code_id && draft.tax_code_id !== NO_TAX ? nameOf(names?.taxCodes, draft.tax_code_id) || 'Taxe' : 'Sans taxe'}</span>
                  <span />
                  <span className="tabular-nums text-slate-600">{fmt(tax)}</span>
                </div>
              )}
              {off && <div className="text-[11px] text-amber-600 text-right">{draft.mode === 'pct' ? `${Math.round(sum * 10) / 10} %` : `reste ${fmt(base - sum)}`}</div>}
            </>
          )}
          {draft.action === 'virement' && (
            <>
              <div className="text-[11px] text-slate-500">Virement</div>
              <SearchableSelect value={draft.transfer_account_id || ''} onChange={(v) => set({ transfer_account_id: v || null })}
                options={banks} getOptionValue={(b) => b.id} getOptionLabel={(b) => b.name} placeholder="Vers quel compte ?" />
            </>
          )}
          {draft.action === 'exclure' && (
            <div className="py-2 text-center text-slate-500"><span className="text-lg">⊘</span><div className="text-xs">Hors comptabilité</div></div>
          )}
          {draft.memo != null && editing !== 'memo' && draft.action !== 'exclure' && (
            <button type="button" className="block w-full text-left pl-3 text-[11px] italic text-slate-500 truncate" onClick={() => setEditing('memo')}>{draft.memo || '—'}</button>
          )}
          {editing === 'memo' && (
            <input autoFocus value={draft.memo || ''} aria-label="Mémo" className="mt-1 w-full border border-slate-300 rounded px-2 py-1 text-xs"
              onChange={(e) => set({ memo: e.target.value })}
              onBlur={() => { setEditing(null); if (!draft.memo) set({ memo: null }) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur() } }} />
          )}
        </div>
      </div>

      {draft.action !== 'exclure' && (
        <div className="flex justify-center gap-4 text-xs">
          {draft.action === 'depense' && (
            <button type="button" className="text-brand-600 hover:underline" onClick={() => {
              setDraft((d) => {
                const lines = d.lines.length === 1 && d.mode === 'pct' ? [{ ...d.lines[0], value: 50 }, { account_id: '', value: 50 }]
                  : [...d.lines, { account_id: '', value: Math.max(0, Math.round((d.mode === 'pct' ? 100 - sum : base - sum) * 100) / 100) }]
                return { ...d, lines }
              })
              setEditing(`l${draft.lines.length === 1 ? 1 : draft.lines.length}`)
            }}>+ compte</button>
          )}
          {draft.action === 'depense' && draft.lines.length > 1 && (
            <span className="inline-flex rounded border border-slate-300 overflow-hidden">
              {[['pct', '%'], ['amount', '$']].map(([k, l]) => (
                <button key={k} type="button" onClick={() => set({ mode: k, lines: draft.lines.map((x, i) => ({ ...x, value: k === 'pct' ? Math.round((amounts[i] / (base || 1)) * 1000) / 10 : amounts[i] })) })}
                  className={`px-2 ${draft.mode === k ? 'bg-slate-800 text-white' : 'text-slate-500'}`}>{l}</button>
              ))}
            </span>
          )}
          {draft.memo == null && (
            <button type="button" className="text-brand-600 hover:underline" onClick={() => { set({ memo: '' }); setEditing('memo') }}>+ mémo</button>
          )}
        </div>
      )}

      <div className="grid grid-cols-3 gap-1 rounded-full bg-slate-100 p-0.5 text-xs">
        {RULE_ACTIONS.map(([k, l]) => (
          <button key={k} type="button" onClick={() => { set({ action: k }); setEditing(null) }}
            className={`rounded-full py-1.5 ${draft.action === k ? 'bg-white shadow-sm font-semibold text-slate-900' : 'text-slate-500'}`}>{l}</button>
        ))}
      </div>

      {error && <div className="text-xs text-red-600">{error}</div>}
      <button type="button" disabled={busy || !valid} onClick={save}
        className="w-full h-10 rounded-full bg-[#2ca01c] hover:bg-[#248a17] text-white text-[13px] font-semibold disabled:opacity-40">
        {busy ? '…' : `Chaque fois pareil · ${draft.preview?.count ?? 0} ligne${(draft.preview?.count ?? 0) > 1 ? 's' : ''}`}
      </button>
      <div className="flex justify-center gap-4 text-xs">
        <Link to="/regles-bancaires" className="text-slate-400 hover:underline">Compléter</Link>
        <button type="button" className="text-slate-400 hover:underline" onClick={() => setDraft(null)}>Annuler</button>
      </div>
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
        bank_txn_id: txn.id, mark_stripe_paid: true,
      })
      if (!r?.qb_error) celebrate(r?.stripe?.marked ? 'Payée · aussi dans Stripe' : 'Payée')
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
// ── Panneau C2 (choix de Charles, 2026-10-03) : un clic sur une ligne à
// traiter ouvre CE panneau, et lui seul — il remplace la ligne dépliée et le
// dossier. L'écriture arrive déjà remplie (règle, fiche, habitude du
// fournisseur, au même montant quand l'habitude se partage) ; on ne montre pas
// l'historique, seulement le résultat.
// La même feuille pour une ligne déjà réglée (ou en cours) : ce qui est fait,
// et le seul geste qui reste (comptabiliser, rapprocher, rétablir).
function SlipSettled({ txn, currency, dossier, onChanged, onFull }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const act = (fn, label = 'Fait') => async () => {
    setBusy(true); setError(null)
    try { await fn(); invalidate('/bank'); celebrate(label); await onChanged() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const booked = !!(txn.qb_txn_id || txn.qb_url || dossier?.document?.booked)
  // Document apparié pas encore publié : ce que l'écriture portera (compte,
  // taxe, mémo, payé par), lu sur le document et l'habitude du fournisseur.
  const [plan, setPlan] = useState(null)
  useEffect(() => {
    if (!txn.matched_id || booked) { setPlan(null); return undefined }
    let alive = true
    Promise.all([api.bank.addDefaults(txn.id), api.quickbooks.accounts(), api.quickbooks.taxCodes()])
      .then(([d, a, t]) => {
        if (!alive) return
        const acc = (id) => { const x = (a || []).find((y) => String(y.Id) === String(id)); return x ? `${x.AcctNum ? `${x.AcctNum} · ` : ''}${x.Name}` : null }
        const tax = (id) => (!id || id === NO_TAX ? 'Aucun code (hors taxes)' : (t || []).find((y) => String(y.Id) === String(id))?.Name || id)
        setPlan({ vendor: d.vendor, account: acc(d.expense_account_id), tax: tax(d.tax_code_id), memo: d.memo, paidBy: acc(d.payment_account_id), taxCad: d.tax_cad })
      }).catch(() => {})
    return () => { alive = false }
  }, [txn.id, txn.matched_id, booked])
  const qbLink = txn.qb_url
    ? <a href={txn.qb_url} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">Ouvrir <ExternalLink size={11} className="inline" /></a>
    : null
  let rows = null
  let cta = null
  const links = []
  if (txn.status === 'ignore') {
    rows = <SlipRow label="État" value={<span className="text-slate-500">Exclue</span>} />
    cta = <SlipCta label="Rétablir" busy={busy} busyLabel="…" onClick={act(() => api.bank.updateTransaction(txn.id, { status: 'a_traiter' }), 'Rétablie')} />
  } else if (txn.transfer_txn_id) {
    rows = (
      <>
        <SlipRow label="Virement" value={txn.matched_label || 'Virement interne'} />
        <SlipRow label="QuickBooks" value={qbLink || <span className="text-slate-400">—</span>} />
      </>
    )
    links.push({ label: 'Défaire le virement', danger: true, fn: () => api.bank.unlinkTransfer(txn.id) })
  } else if (txn.matched_id) {
    rows = (
      <>
        <SlipRow label="Document" value={<MatchedDocument txn={txn} doc={dossier?.document} onChanged={onChanged} />} />
        {plan && <>
          {plan.vendor && <SlipRow label="Fournisseur" value={plan.vendor} />}
          <SlipRow label="Compte" warn={!plan.account} value={plan.account || 'à choisir'} />
          <SlipRow label="Taxe" value={<>{plan.tax}{plan.taxCad != null && <span className="font-normal text-slate-500"> · {money(plan.taxCad, currency)}</span>}</>} />
          {plan.memo && <SlipRow label="Mémo" value={plan.memo} />}
          {plan.paidBy && <SlipRow label="Payé par" value={plan.paidBy} />}
        </>}
        <SlipRow label="QuickBooks" warn={!booked || !!dossier?.document?.awaiting_payment}
          value={!booked ? 'pas encore comptabilisé' : dossier?.document?.awaiting_payment ? 'facture inscrite, paiement à poser' : (qbLink || <span className="text-green-700">✓ comptabilisé</span>)} />
      </>
    )
    if (!booked) cta = <SlipCta label="Comptabiliser" busy={busy} busyLabel="Comptabilisation…" onClick={act(() => api.bank.publishMatched(txn.id), 'Comptabilisé')} />
    else if (dossier?.document?.awaiting_payment) {
      cta = <SlipCta label="Payer la facture" busy={busy} busyLabel="Paiement…" onClick={act(() => api.bank.publishMatched(txn.id), 'Facture payée')} />
    }
    links.push({ label: 'Délier', danger: true, fn: () => api.bank.match(txn.id, { matched_type: null, matched_id: null }) })
  } else if (booked) {
    rows = <div className="pt-2"><QbEntryCard txn={txn} currency={currency} onChanged={onChanged} /></div>
  }
  if (txn.status === 'rapproche') {
    rows = <>{rows}<SlipRow label="Banque" value={<span className="text-green-700">✓ Rapprochée</span>} /></>
    links.push({ label: 'Annuler le rapprochement', fn: () => api.bank.reconcile([txn.id], true) })
  } else if (txn.status !== 'ignore' && !cta && (booked || txn.transfer_txn_id)) {
    cta = <SlipCta label="Marquer rapproché" busy={busy} busyLabel="…" onClick={act(() => api.bank.reconcile([txn.id]), 'Rapprochée')} />
  }
  return (
    <div className="flex flex-col gap-3">
      <div>{rows}</div>
      {error && <div className="text-xs text-red-600">{error}</div>}
      {cta}
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
        {links.map((l) => (
          <button key={l.label} type="button" disabled={busy} onClick={act(l.fn)}
            className={`hover:underline disabled:opacity-50 ${l.danger ? 'text-slate-400 hover:text-red-600' : 'text-brand-600'}`}>{l.label}</button>
        ))}
        <button type="button" className="text-slate-400 hover:text-slate-700 hover:underline" onClick={onFull}>Dossier complet</button>
      </div>
    </div>
  )
}

function TxnCompose({ txn, currency, next, accountName, onChanged, onClose, onFull }) {
  const { dossier, reload } = useDossier(txn.id)
  // Les pièces candidates s'apparient dans le volet côte à côte (M1), pas dans
  // l'ancienne liste du dossier.
  const found = dossierFocus(dossier)
  const focus = found?.key === 'receipts' ? null : found
  const [pane, setPane] = useState(() => {
    const p = NEXT_META[next?.kind || 'rien']?.pane
    return p === 'match' || p === 'transfer' || p === 'exclude' ? p : 'add'
  })
  const touched = useRef(false)
  useEffect(() => { if (found && !touched.current) setPane(focus ? 'dossier' : 'match') }, [found?.key]) // eslint-disable-line react-hooks/exhaustive-deps
  const [comment, setComment] = useState(txn.comment || '')
  const [noting, setNoting] = useState(false)
  // Une proposition ouverte prend toute la place ; les autres gestes restent
  // en liens dessous.
  const [proposals, setProposals] = useState(0)
  const [chose, setChose] = useState(false)
  const [busy, setBusy] = useState(false)
  const finish = async (label) => { celebrate(typeof label === 'string' ? label : 'Fait'); await onChanged(); onClose() }

  // Maquette P2 (choix de Charles, 2026-10-03) : le reçu. En tête le montant en
  // grand ; dessous, ce qui sera écrit, une ligne par champ ; un seul gros
  // bouton ; les autres gestes en liens discrets sous le bouton.
  const alts = [
    focus && { key: 'dossier', label: focus.label },
    { key: 'add', label: 'Ajouter plutôt' },
    { key: 'match', label: 'Apparier plutôt' },
    { key: 'transfer', label: 'Virement' },
  ].filter((a) => a && a.key !== pane)
  const title = txn.vendor_name || txnLabel(txn)
  const raw = [txn.details, txn.description].filter(Boolean).find((t) => t !== title)
  const done = !!(txn.matched_id || txn.transfer_txn_id || txn.qb_txn_id || txn.status === 'rapproche' || txn.status === 'ignore')

  return (
    <div className="mx-auto max-w-[460px] px-5 pb-6 flex flex-col text-sm" data-testid="txn-compose">
      <div className="pb-4 text-center border-b border-slate-100">
        <div className="text-[15px] font-semibold text-slate-900 truncate">{title}</div>
        <div className={`my-1 text-[30px] leading-tight font-semibold tabular-nums tracking-tight ${txn.amount > 0 ? 'text-green-700' : 'text-slate-900'}`}>
          {txn.amount < 0 ? '−' : '+'}{money(Math.abs(txn.amount), currency)}
        </div>
        <div className="text-xs text-slate-500">{fmtDate(txn.txn_date)}{accountName ? ` · ${accountName}` : ''}</div>
        {raw && <div className="mt-1 text-[11px] text-slate-400 font-mono truncate" title={raw}>{raw}</div>}
      </div>

      {txn.proposal_count > 0 && !done && (
        <div className="pt-3"><ProposalCards slip txn={txn} currency={currency} onChanged={finish} onCount={setProposals} /></div>
      )}

      {done ? (
        <div className="pt-2">
          <SlipSettled txn={txn} currency={currency} dossier={dossier} onChanged={onChanged} onFull={onFull} />
        </div>
      ) : <>
      {!(proposals > 0 && !chose) && <div className="pt-2">
        {pane === 'dossier' && focus && (
          <div className="pt-2">
            <DossierFocus txn={txn} currency={currency} focus={focus} dossier={dossier} reload={reload} onChanged={onChanged}
              onDone={async () => { await onChanged(); onClose() }} />
          </div>
        )}
        {pane === 'add' && txn.amount < 0 && (
          <AddExpenseForm receipt txn={txn} currency={currency} onDone={() => finish('Écriture ajoutée')} onCancel={onClose} />
        )}
        {pane === 'add' && txn.amount > 0 && <DepositForm txn={txn} currency={currency} onDone={() => finish('Écriture ajoutée')} />}
        {pane === 'match' && <QbMatchPane txn={txn} currency={currency} onChanged={() => finish('Apparié')}
          onAdd={() => { touched.current = true; setPane('add') }} />}
        {pane === 'transfer' && <TransferForm receipt txn={txn} currency={currency} onDone={() => finish('Virement lié')} onCancel={onClose}
          preferAccountId={next?.account_id || null} />}
        {pane === 'exclude' && (
          <div className="flex flex-col gap-3 pt-2">
            <div className="py-4 text-center text-slate-500">
              <div className="mx-auto mb-1.5 w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-lg">⊘</div>
              Hors comptabilité{next?.label ? <div className="text-xs text-slate-400">Règle « {next.label} »</div> : null}
            </div>
            <SlipCta label="Exclure" busy={busy} busyLabel="…" onClick={async () => {
              setBusy(true); try { await api.bank.updateTransaction(txn.id, { status: 'ignore' }); await finish('Exclue') } finally { setBusy(false) }
            }} />
          </div>
        )}
      </div>}

      <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
        {(proposals > 0 && !chose ? [...alts, { key: pane, label: { add: 'Ajouter plutôt', match: 'Apparier plutôt', transfer: 'Virement', dossier: focus?.label, exclude: 'Exclure' }[pane] }] : alts).filter((a) => a.label).map((a) => (
          <button key={a.key} type="button" className="text-brand-600 hover:underline"
            onClick={() => { touched.current = true; setChose(true); setPane(a.key) }}>{a.label}</button>
        ))}
        <button type="button" disabled={busy} className="text-slate-400 hover:text-slate-700 hover:underline disabled:opacity-50"
          onClick={async () => { setBusy(true); try { await api.bank.updateTransaction(txn.id, { status: 'ignore' }); await finish('Exclue') } finally { setBusy(false) } }}>
          Exclure
        </button>
        <button type="button" className="text-slate-400 hover:text-slate-700 hover:underline" onClick={onFull}>Dossier complet</button>
      </div>
      </>}

      <div className="mt-6 pt-3 border-t border-slate-100 space-y-2">
        {/* Le champ vide sans étiquette passait pour une barre blanche : il
            n'apparaît qu'au clic, ou s'il a déjà une note. */}
        {noting || comment ? (
          <textarea className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs" rows={1} autoFocus={noting && !comment}
            aria-label="Commentaire" value={comment} onChange={(e) => setComment(e.target.value)}
            onBlur={() => { setNoting(false); if ((txn.comment || '') !== comment) api.bank.updateTransaction(txn.id, { comment: comment || null }).then(onChanged).catch(() => {}) }} />
        ) : (
          <button type="button" className="text-xs text-slate-400 hover:text-slate-700 hover:underline" onClick={() => setNoting(true)}>+ Note</button>
        )}
        <RuleFromTxnForm txn={txn} />
      </div>
    </div>
  )
}

function TxnPeek({ txn, currency, onChanged, initialMode = null, next, accountName, onClose }) {
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

  if (!initialMode && !mode && onClose) {
    return <TxnCompose txn={txn} currency={currency} next={next} accountName={accountName} onChanged={onChanged} onClose={onClose}
      onFull={() => setMode('full')} />
  }

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
// Écriture QuickBooks sans ligne au relevé, au même format que le panneau.
function GhostPeek({ row, currency }) {
  return (
    <div className="mx-auto max-w-[460px] px-5 pb-6 flex flex-col gap-3 text-sm">
      <div className="pb-4 text-center border-b border-slate-100">
        <div className="text-[15px] font-semibold text-slate-900 truncate">{row.label}</div>
        <div className={`my-1 text-[30px] leading-tight font-semibold tabular-nums ${row.amount > 0 ? 'text-green-700' : 'text-slate-900'}`}>
          {row.amount < 0 ? '−' : '+'}{money(Math.abs(row.amount), currency)}
        </div>
        <div className="text-xs text-slate-500">{fmtDate(row.txn_date)} · QuickBooks</div>
      </div>
      <div className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-amber-700 font-medium">
        <AlertTriangle size={14} className="shrink-0" /> Aucune ligne du relevé
      </div>
      <div className="text-center text-xs text-slate-500">Relevé pas encore importé, ou écriture en trop dans QuickBooks.</div>
      {row.qb_url && (
        <a href={row.qb_url} target="_blank" rel="noreferrer"
          className="w-full h-11 rounded-full bg-[#2ca01c] hover:bg-[#248a17] text-white text-[14px] font-semibold inline-flex items-center justify-center gap-1.5">
          Ouvrir dans QuickBooks <ExternalLink size={13} />
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

// ── Clone « Opérations bancaires » de QuickBooks (maquette Q2, 2026-10-03) ───
// Trois étapes comme QBO : ce qui attend un geste, ce qui est classé, ce qu'on
// a mis de côté. Les lignes fantômes vivent avec ce qui attend.
const STAGES = [
  { key: 'rev', label: 'Pour révision' },
  { key: 'cat', label: 'Catégorisées' },
  { key: 'exc', label: 'Exclues' },
]
const stageOf = (r) => (r._ghost ? 'rev'
  : r.status === 'ignore' ? 'exc'
    : r.awaiting_payment ? 'rev'
      : r.status === 'comptabilise' || r.status === 'rapproche' ? 'cat' : 'rev')

// Ce que la ligne attend, dans le vocabulaire de QuickBooks : une catégorie,
// une correspondance, un virement — ou rien encore. Une fonction pour le
// filtre, la cellule et le bouton.
function lineKind(r, next) {
  if (r._ghost) return 'ghost'
  if (r.transfer_txn_id || next?.kind === 'virement') return 'xfer'
  if (r.auto_suggestion || r.suggestion?.kind === 'vendor_expense') return 'cat'
  if (r.matched_id || r.proposal_count > 0 || next?.kind === 'apparier' || next?.kind === 'comptabiliser') return 'match'
  if (next?.kind === 'publier' || r.rule_name) return 'cat'
  return 'none'
}

function Kpi({ label, children, cls = 'text-slate-800', testId }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[11.5px] text-slate-500">{label}</span>
      <span data-testid={testId} className={`text-[15px] font-medium tabular-nums whitespace-nowrap ${cls}`}>{children}</span>
    </div>
  )
}

// En-tête : le compte en grand, ses trois nombres, le seul bouton d'action.
function QboHeader({ account, isTodo, rec, robot, menu }) {
  const { summary, qb, qbLoading, qbError, msg } = rec
  const currency = account?.currency
  const stmt = summary?.statement
  const bal = qb?.balance && !qb.balance.error ? qb.balance : null
  const diff = bal?.difference
  const ok = diff != null && Math.abs(diff) < 0.01
  const bank = stmt?.printed_balance_signed
  const detail = [
    stmt?.date ? `Soldes au ${fmtDate(stmt.date)}` : null,
    bal && Math.abs(bal.qb_current - bal.qb_as_of) >= 0.01 ? `QuickBooks aujourd'hui ${money(bal.qb_current, currency)}` : null,
  ].filter(Boolean).join(' · ')
  return (
    <header className="flex items-end gap-x-8 gap-y-3 flex-wrap px-6 pt-5 pb-3">
      <div className="min-w-0">
        <div className="text-xs text-slate-500">Opérations bancaires</div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 truncate">{isTodo ? 'À comptabiliser' : account?.name || '—'}</h1>
      </div>
      {account && !isTodo && (
        <div data-testid="reconcile-panel" title={detail || undefined}
          data-statement-balance={bank != null ? money(bank, currency) : ''}
          data-qb-balance={bal ? money(bal.qb_as_of, currency) : ''}
          className="flex items-end gap-7 flex-wrap">
          <Kpi label="Banque">{bank != null ? money(bank, currency) : '—'}</Kpi>
          <Kpi label="QuickBooks">{bal ? money(bal.qb_as_of, currency) : !account.qb_account_id ? 'non mappé' : qbLoading ? '…' : '—'}</Kpi>
          <Kpi label="Écart" testId="reconcile-difference" cls={diff == null ? 'text-slate-300' : ok ? 'text-green-700' : 'text-red-600'}>
            <Link to={`/rapprochement-qbo?compte=${account.id}`} data-testid="open-reconcile" title="Rapprocher"
              className="border-b border-dashed border-current hover:opacity-80">
              {qbLoading ? '…' : diff == null ? '—' : <>{money(diff, currency)}{ok ? ' ✓' : ''}</>} ›
            </Link>
          </Kpi>
          <div className="flex items-center gap-2 pb-0.5">
            {robot && <QbRobotPill robot={robot} currency={currency} />}
            {qbError && <span className="text-[11px] text-amber-700">QuickBooks indisponible</span>}
            {msg && <span className="text-[11px] text-slate-400 truncate max-w-xs">{msg}</span>}
            <PlaidDuplicates account={account} rec={rec} />
          </div>
        </div>
      )}
      <div className="ml-auto flex items-center gap-2">
        {account && !isTodo && (
          <button type="button" data-testid="reconcile-auto-btn" disabled={rec.busy} onClick={rec.runUpdate}
            title="Apparier aux documents, vérifier dans QuickBooks, recalculer l'écart"
            className="qbo-go h-9 px-4 rounded-full text-sm font-medium inline-flex items-center gap-2 disabled:opacity-60">
            <RefreshCw size={14} className={rec.busy ? 'animate-spin' : ''} />
            {rec.busy ? 'Mise à jour…' : 'Mettre à jour'}
          </button>
        )}
        {menu}
      </div>
    </header>
  )
}

function StageTabs({ value, onChange, counts, isTodo }) {
  return (
    <nav aria-label="Étapes" className="flex items-end gap-7 px-6 border-b border-slate-200">
      {STAGES.filter((s) => !isTodo || s.key === 'rev').map((s) => (
        <button key={s.key} type="button" data-testid={`stage-${s.key}`} aria-current={value === s.key ? 'page' : undefined}
          onClick={() => onChange(s.key)}
          className={`py-3 -mb-px border-b-2 text-sm ${value === s.key
            ? 'border-slate-900 text-slate-900 font-medium'
            : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
          {s.label}<span className="ml-1.5 text-slate-400 tabular-nums">{counts[s.key] || 0}</span>
        </button>
      ))}
    </nav>
  )
}

// Les filtres de « Pour révision ». Un compteur à zéro n'est pas cliquable —
// sinon la liste se viderait sur l'écran « aucune transaction ».
const LINE_FILTERS = [
  { key: 'review', label: 'À réviser', hint: 'Lignes marquées d\'un rond rouge' },
  { key: 'requested', label: 'Factures manquantes', hint: 'Sorties sans facture' },
  { key: 'match', label: 'Correspondances', hint: 'Un document ou une proposition attend' },
  { key: 'xfer', label: 'Virements', hint: 'Virement interne reconnu' },
  { key: 'none', label: 'À catégoriser', hint: 'Rien trouvé encore' },
  { key: 'ghost', label: 'Hors relevé', hint: 'Écriture QuickBooks sans ligne au relevé' },
]
// La légende du code couleur, toujours sous les yeux : la barre de gauche de
// chaque ligne reprend la couleur pleine.
const LEGEND = [
  ['À traiter', '#dc2626', '#fde0de'], ['Facture reçue', '#2563eb', '#d6e4ff'], ['Comptabilisé', '#d4a106', '#fff0b3'],
  ['Rapproché', '#2ca01c', '#cdeec3'], ['Exclu', '#a3aab3', '#eceef1'],
]
function StatusLegend() {
  return (
    <span className="ml-2 inline-flex items-center gap-3 text-[11.5px] text-slate-500 whitespace-nowrap" data-testid="status-legend">
      {LEGEND.map(([l, c, t]) => (
        <span key={l} className="inline-flex items-center gap-1.5">
          <span className="w-4 h-3.5 rounded-sm" style={{ background: t, boxShadow: `inset 3px 0 0 ${c}` }} />{l}
        </span>
      ))}
    </span>
  )
}

function LineFilters({ counts, value, onChange, onRequests }) {
  return (
    <div role="group" aria-label="Filtrer" className="flex items-center gap-0.5 flex-wrap">
      {LINE_FILTERS.map((f) => {
        const n = counts[f.key] || 0
        if (f.key === 'ghost' && !n) return null
        const on = value === f.key
        return (
          <span key={f.key} className={`inline-flex items-center rounded-lg ${on ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'} ${n ? '' : 'opacity-40'}`}>
            <button type="button" data-testid={`reconcile-legend-${f.key}`} aria-pressed={on} title={f.hint}
              disabled={!n} onClick={() => onChange(on ? null : f.key)}
              className="inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1 text-[13px] whitespace-nowrap disabled:cursor-default">
              {f.key === 'review' && <span className={`w-2.5 h-2.5 rounded-full border-[1.6px] ${on ? 'border-white' : 'border-red-600'}`} />}
              {f.key === 'requested' && <Flag size={12} className={on ? '' : 'text-amber-600'} />}
              {f.label}
              <span className={`text-xs font-semibold tabular-nums ${on ? 'text-white/70' : 'text-slate-400'}`}>{n}</span>
            </button>
            {f.key === 'requested' && n > 0 && (
              <button type="button" data-testid="reconcile-requests-open" title="Demander les factures sur Slack"
                onClick={onRequests} className={`pr-2 py-1 ${on ? '' : 'text-amber-600'}`}>
                <Send size={12} />
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}

// « Catégorie ou correspondance » : ce que la ligne deviendra, une ligne, et
// d'où ça vient en petit dessous.
function CategoryCell({ row, stage, next, names, currency, onChanged }) {
  const [busy, setBusy] = useState(false)
  const sub = (t) => (t ? <span className="block truncate text-[11.5px] text-slate-400">{t}</span> : null)
  if (row._ghost) return <span className="italic text-slate-400">Écriture QuickBooks sans ligne au relevé</span>
  if (stage !== 'rev') {
    const what = row.transfer_txn_id ? 'Transfert' : row.matched_label || (row.qb_txn_id ? 'Écriture QuickBooks' : '—')
    return <span className="block min-w-0"><span className="block truncate text-slate-700">{what}</span>{sub(STATUS_META[row.status]?.label)}</span>
  }
  const auto = row.auto_suggestion
  if (auto && !row.suggestion) {
    const t = suggestionText(auto, names, currency)
    const undo = async (e) => {
      e.stopPropagation(); setBusy(true)
      try { await api.bank.undoProposal(auto.id); invalidate('/bank'); await onChanged() } finally { setBusy(false) }
    }
    return (
      <span className="block min-w-0">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-slate-700">{t.what}</span>
          <span className="shrink-0 text-[10px] font-bold text-white bg-[#2ca01c] rounded px-1">AUTO</span>
          <button type="button" disabled={busy} onClick={undo} className="shrink-0 text-[11px] text-slate-500 hover:underline">annuler</button>
        </span>
        {sub(row.rule_name ? `Règle « ${row.rule_name} »` : null)}
      </span>
    )
  }
  if (row.suggestion) {
    const t = suggestionText(row.suggestion, names, currency)
    const details = [...t.facts, ...t.proof].filter((d) => typeof d === 'string' && d)
    return <span className="block min-w-0" data-testid="row-suggestion"><span className="block truncate text-slate-700">{t.what}</span>{sub(details.join(' · '))}</span>
  }
  const kind = lineKind(row, next)
  if (kind === 'xfer') return <span className="block min-w-0"><span className="block truncate text-slate-700">Transfert</span>{sub(next?.label)}</span>
  if (kind === 'match') {
    return <span className="block min-w-0"><span className="block truncate font-medium text-green-700">1 correspondance</span>{sub(row.matched_label || next?.label)}</span>
  }
  if (kind === 'cat') return <span className="block min-w-0"><span className="block truncate text-slate-700">{next?.label || 'Catégorie prête'}</span>{sub(row.rule_name ? `Règle « ${row.rule_name} »` : null)}</span>
  return <span className="text-slate-400">Non catégorisé</span>
}

// L'ordre de QuickBooks, tenu quelle que soit la vue enregistrée.
// Disposition L3 (2026-10-06) : Date | Description | Catégorie ou correspondance |
// Montant | Action. Ids neufs : les largeurs et vues enregistrées des anciennes
// colonnes ne les touchent pas.
const PINNED_COLUMNS = ['_marks', 'qbo_date', 'r3_vendor', 'l3_cat', 'r3_amount', 'l3_act']

const NEXT_VERB = { virement: 'Lier', apparier: 'Apparier', publier: 'Publier', comptabiliser: 'Comptabiliser', exclure: 'Exclure' }


// R3+ : ce qui sert à décider, par geste. ✓ vert = concorde, ! ambre = à voir.
const Mark = ({ ok }) => (ok
  ? <span className="font-bold text-green-700">✓</span>
  : <span className="font-bold text-amber-600">!</span>)
const normText = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const dayGap = (a, b) => Math.abs((new Date(String(a).slice(0, 10)) - new Date(String(b).slice(0, 10))) / 86400000)
const sameVendor = (bankText, docLabel) => {
  const bank = normText(bankText)
  return normText(docLabel).split(/[^a-z0-9]+/).some((w) => w.length >= 3 && bank.includes(w))
}

// Panneau ancré sous la pastille « À faire ». Lectures seulement ; le bouton
// du bas rappelle EXACTEMENT le geste de la pastille (onConfirm).
function DecisionPanel({ kind, row, sg, names, currency, pos, busy, onConfirm, onOther, onClose }) {
  const [data, setData] = useState(undefined)
  const confirmRef = useRef(null)
  const cb = useRef({ onConfirm, onClose })
  cb.current = { onConfirm, onClose }

  useEffect(() => {
    let alive = true
    const done = (d) => { if (alive) setData(d) }
    const fail = () => done(null)
    if (kind === 'match') api.bank.suggestions(row.id).then((r) => done(r?.[0] || null)).catch(fail)
    else if (kind === 'xfer') api.bank.transferCandidates(row.id).then((r) => done((r?.data || r || [])[0] || null)).catch(fail)
    else if (kind === 'publish' && !sg) api.bank.addDefaults(row.id).then(done).catch(fail)
    else if (kind === 'ask') {
      const id = row.resolved_vendor?.profile_id
      if (!id) done(null)
      else api.achatsFournisseurs.list({ vendor_id: id, limit: 2 }).then((r) => done(r?.data || [])).catch(fail)
    } else done(null)
    return () => { alive = false }
  }, [kind, row.id, row.resolved_vendor?.profile_id, sg])

  useEffect(() => {
    confirmRef.current?.focus()
    const h = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cb.current.onClose() }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); cb.current.onConfirm() }
    }
    document.addEventListener('keydown', h, true)
    return () => document.removeEventListener('keydown', h, true)
  }, [])

  const abs = Math.abs(row.amount || 0)
  const loading = data === undefined
  const line = (k, a, b, ok) => (
    <>
      <span className="text-[11.5px] text-slate-500">{k}</span>
      <span className="truncate">{a}</span>
      {b !== undefined && <span className="truncate">{b}</span>}
      <Mark ok={ok} />
    </>
  )
  let title = ''
  let grid = null
  let links = null
  let verb = ''
  if (kind === 'match') {
    title = 'Apparier'
    verb = 'Apparier'
    const c = data
    const bankText = `${row.vendor_name || ''} ${row.details || ''} ${row.description || ''}`
    grid = (
      <div className="grid gap-x-3 gap-y-1.5 items-center text-[12.5px]" style={{ gridTemplateColumns: '84px 1fr 1fr 18px' }}>
        <span /><span className="text-[11px] text-slate-400">Banque</span><span className="text-[11px] text-slate-400">Document</span><span />
        {c ? (
          <>
            {line('Montant', money(abs, currency), money(Math.abs(c.total), currency), Math.abs(abs - Math.abs(c.total)) < 0.011)}
            {line('Date', fmtDate(row.txn_date), fmtDate(c.date), dayGap(row.txn_date, c.date) <= 5)}
            {line('Fournisseur', row.vendor_name || txnLabel(row), c.label, sameVendor(bankText, c.label))}
          </>
        ) : null}
      </div>
    )
    links = (
      <>
        {c ? <span onClick={(e) => e.stopPropagation()} className="text-[12px]">{docLink(c.type, c.id, 'Voir la facture')}</span> : <span />}
        <span className="grow" />
        <button type="button" className="text-[12px] text-brand-600 hover:underline" onClick={onOther}>Autre</button>
      </>
    )
  } else if (kind === 'publish') {
    title = row.matched_id && !sg ? 'Comptabiliser' : 'Publier'
    verb = title
    const p = sg?.payload || {}
    const d = sg ? { expense_account_id: p.expense_account_id, tax_code_id: p.tax_code_id, tax_cad: p.tax_cad } : data || {}
    const acct = d.expense_account_id ? nameIn(names?.accounts, d.expense_account_id) : null
    const taxName = d.tax_code_id === '__none__' ? 'sans taxe' : d.tax_code_id ? nameIn(names?.taxCodes, d.tax_code_id) : null
    const taxAmt = d.tax_cad != null && d.tax_cad !== '' ? ` · ${money(Math.abs(Number(d.tax_cad)), currency)}` : ''
    const hasDoc = !!row.matched_id
    grid = (
      <div className="grid gap-x-3 gap-y-1.5 items-center text-[12.5px]" style={{ gridTemplateColumns: '84px 1fr 18px' }}>
        {line('Compte', acct || row.rule_name || '—', undefined, !!acct || !!row.rule_name)}
        {line('Taxe', taxName ? `${taxName}${taxAmt}` : '—', undefined, !!taxName)}
        {line('Pièce', hasDoc ? row.matched_label || 'Document joint' : 'Aucune', undefined, hasDoc)}
      </div>
    )
    links = (
      <>
        <button type="button" className="text-[12px] text-brand-600 hover:underline" onClick={onOther}>Changer</button>
        <span className="grow" />
      </>
    )
  } else if (kind === 'xfer') {
    title = 'Lier'
    verb = 'Lier'
    const c = data
    const out = row.amount < 0
    const other = c ? Math.abs(c.amount) : null
    const fx = c && String(c.currency || 'CAD') !== String(currency || 'CAD')
    grid = (
      <div className="grid gap-x-3 gap-y-1.5 items-center text-[12.5px]" style={{ gridTemplateColumns: '84px 1fr 1fr 18px' }}>
        <span /><span className="text-[11px] text-slate-400">{out ? 'Sortie' : 'Entrée'}</span><span className="truncate text-[11px] text-slate-400">{out ? 'Entrée' : 'Sortie'}{c ? ` · ${c.account_name}` : ''}</span><span />
        {c ? (
          <>
            {line('Montant', money(abs, currency), money(other, c.currency || currency), fx || Math.abs(abs - other) < 0.011)}
            {fx && line('Taux', c.rate || '—', '', !!c.rate)}
            {line('Date', fmtDate(row.txn_date), fmtDate(c.txn_date), dayGap(row.txn_date, c.txn_date) <= 3)}
          </>
        ) : null}
      </div>
    )
    links = <span className="grow" />
  } else if (kind === 'ask') {
    title = 'Demander'
    verb = 'Demander'
    const [last, prev] = data || []
    const lastTotal = last ? Number(last.total_cad) : null
    const gap = last && prev ? Math.round((lastTotal - Number(prev.total_cad)) * 100) / 100 : null
    grid = (
      <div className="grid gap-x-3 gap-y-1.5 items-center text-[12.5px]" style={{ gridTemplateColumns: '84px 1fr 18px' }}>
        {line('Dernière', last ? `${fmtDate(last.date_achat)} · ${money(lastTotal, 'CAD')}` : 'Aucune connue', undefined, !!last)}
        {line('Écart', gap == null ? '—' : `${money(gap, 'CAD')} vs précédente`, undefined, gap === 0)}
      </div>
    )
    links = (
      <>
        <button type="button" className="text-[12px] text-brand-600 hover:underline" onClick={onOther}>Déposer moi-même</button>
        <span className="grow" />
      </>
    )
  }

  const style = { position: 'fixed', top: pos.top, left: pos.left, width: 380 }
  // Portail vers <body> : un ancêtre transformé du tableau décalait la position fixe.
  return createPortal(
    <div role="dialog" aria-label={title} data-testid="todo-popover" style={style}
      onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
      className="z-50 rounded-xl border border-slate-200 bg-white shadow-xl px-3.5 py-3 text-left whitespace-normal">
      <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-slate-800 min-w-0">
        {title}
        <span className="font-normal text-slate-400 truncate">· {row.vendor_name || txnLabel(row)}</span>
      </div>
      {loading ? <div className="text-xs text-slate-400">…</div>
        : kind === 'ask' || data || kind === 'publish' ? grid
          : <div className="text-xs text-slate-400">Rien à comparer</div>}
      <div className="mt-3 flex items-center gap-2">
        {links}
        <button ref={confirmRef} type="button" disabled={busy} onClick={onConfirm}
          className={`h-7 px-3 rounded-lg text-[12.5px] font-medium text-white disabled:opacity-50 ${kind === 'ask' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-brand-600 hover:bg-brand-700'}`}>
          {verb} ↵
        </button>
      </div>
    </div>,
    document.body,
  )
}

// Le bouton de la ligne, comme QuickBooks : le geste attendu, et la flèche
// pour le reste. Sans gestionnaire, le clic remonte à la ligne et la déplie sur
// le bon volet. Quand le geste a un panneau R3+ (apparier, publier, lier,
// demander), le clic sur la pastille l'ouvre : le bouton du panneau refait
// exactement ce que faisait la pastille.
function RowAction({ row, stage, next, target, names, currency, onChanged, onOpenPanel }) {
  const [pop, setPop] = useState(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!pop) return undefined
    const h = (e) => {
      if (e.target.closest?.('[data-testid="todo-popover"]')) return
      setPop(null)
    }
    const close = () => setPop(null)
    document.addEventListener('mousedown', h)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', h)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [pop])
  const run = (fn) => async (e) => {
    e.stopPropagation(); setBusy(true)
    try { await fn(); invalidate('/bank'); celebrate('Fait'); await onChanged() } finally { setBusy(false) }
  }
  const pill = 'h-7 px-3 text-[12.5px] font-medium whitespace-nowrap disabled:opacity-50'
  const ghostBtn = `${pill} rounded-full border border-slate-300 text-slate-700 bg-white hover:bg-slate-50`

  if (row._ghost) {
    return row.qb_url
      ? <a href={row.qb_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-[12.5px] font-medium text-blue-700 hover:underline">Ouvrir dans QB</a>
      : null
  }
  if (stage === 'exc') {
    return <button type="button" disabled={busy} className={ghostBtn}
      onClick={run(() => api.bank.updateTransaction(row.id, { status: 'a_traiter' }))}>Rétablir</button>
  }
  if (stage === 'cat') {
    return row.status === 'rapproche'
      ? <button type="button" disabled={busy} className={ghostBtn} title="Annuler le rapprochement"
          onClick={run(() => api.bank.reconcile([row.id], true))}>Annuler</button>
      : <button type="button" className={ghostBtn} onClick={(e) => { e.stopPropagation(); onOpenPanel(row) }}>Dossier</button>
  }

  const sg = row.suggestion
  const settled = (row.matched_id || row.transfer_txn_id) && next?.kind !== 'comptabiliser'
  // Sortie sans proposition ni correspondance : le geste est de réclamer la facture.
  const ask = !sg && !settled && !NEXT_VERB[next?.kind] && row.amount < 0 && !row.invoice_requested
  const verb = sg ? (sg.publishes ? 'Publier' : 'Confirmer') : settled ? 'Ouvrir' : ask ? 'Demander' : NEXT_VERB[next?.kind] || 'Catégoriser'
  const tgt = ask ? 'la facture' : target
  const primary = !!sg || (!settled && !ask && !!NEXT_VERB[next?.kind])
  const cls = ask
    ? 'bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-200'
    : primary ? 'qbo-go' : 'border border-slate-300 text-slate-700 bg-white hover:bg-slate-50'
  const onMain = sg ? run(() => api.bank.acceptProposal(sg.id))
    : next?.kind === 'exclure' && !settled ? run(() => api.bank.updateTransaction(row.id, { status: 'ignore' }))
    : ask ? run(async () => { await api.bank.addInvoiceRequests([row.id]) })
    : undefined
  const from = row.rule_name ? `Préparée par la règle « ${row.rule_name} »` : undefined
  const popKind = sg ? (sg.kind === 'vendor_expense' ? 'publish' : null)
    : settled ? null
      : ask ? 'ask'
        : next?.kind === 'apparier' ? 'match'
          : next?.kind === 'publier' || next?.kind === 'comptabiliser' ? 'publish'
            : next?.kind === 'virement' ? 'xfer' : null
  // Sans gestionnaire propre, le geste de la pastille est d'ouvrir la ligne sur
  // son volet : le clic remonte à la <tr>.
  const expandRow = () => ref.current?.closest('tr')?.click()
  const confirm = () => {
    setPop(null)
    if (onMain) onMain({ stopPropagation() {} })
    else expandRow()
  }
  return (
    <span ref={ref} className="relative inline-flex max-w-full">
      <button type="button" disabled={busy} title={sg?.publishes ? 'Crée l\'écriture dans QuickBooks' : from}
        onClick={popKind ? (e) => { e.stopPropagation(); onOpenPanel(row) } : onMain}
        className={`${pill} rounded-full ${cls} max-w-[320px] truncate`}>
        <b className="font-semibold">{verb}</b>{tgt ? ` ${tgt}` : ''}<span className="ml-1.5 opacity-60">↵</span>
      </button>
      {pop && popKind && (
        <DecisionPanel kind={popKind} row={row} sg={sg} names={names} currency={currency} pos={pop} busy={busy}
          onConfirm={confirm} onOther={() => { setPop(null); expandRow() }} onClose={() => setPop(null)} />
      )}
    </span>
  )
}

// Le clic droit sur une ligne : les gestes secondaires (Charles, 2026-10-06).
function RowContextMenu({ menu, onClose, onDossier, onChanged }) {
  const ref = useRef(null)
  useEffect(() => {
    const h = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    const k = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', h)
      document.removeEventListener('keydown', k)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])
  const { row, x, y } = menu
  const run = (fn, label) => async () => {
    onClose()
    await fn(); invalidate('/bank'); celebrate(label); await onChanged()
  }
  const item = 'w-full text-left px-2.5 py-1.5 rounded-md text-sm text-slate-700 hover:bg-slate-50'
  const items = [
    { label: 'Dossier', onClick: () => { onClose(); onDossier(row) } },
    row.suggestion && { label: 'Refuser la suggestion', onClick: run(() => api.bank.refuseProposal(row.suggestion.id), 'Refusée') },
    row.amount < 0 && !row.invoice_requested && row.status !== 'rapproche'
      && { label: 'Demander la facture', onClick: run(() => api.bank.addInvoiceRequests([row.id]), 'Facture manquante') },
    row.status === 'ignore'
      ? { label: 'Rétablir', onClick: run(() => api.bank.updateTransaction(row.id, { status: 'a_traiter' }), 'Rétablie') }
      : row.status !== 'rapproche' && { label: 'Exclure', onClick: run(() => api.bank.updateTransaction(row.id, { status: 'ignore' }), 'Exclue') },
  ].filter(Boolean)
  return createPortal(
    <div ref={ref} data-testid="bank-row-menu" onContextMenu={(e) => e.preventDefault()}
      style={{ position: 'fixed', top: Math.min(y, window.innerHeight - 40 * items.length - 16), left: Math.min(x, window.innerWidth - 208) }}
      className="z-50 w-48 rounded-lg border border-slate-200 bg-white shadow-lg p-1 text-left">
      {items.map((it) => <button key={it.label} type="button" className={item} onClick={it.onClick}>{it.label}</button>)}
    </div>,
    document.body,
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
  exclure: { label: 'Exclure', pane: 'exclude', cls: 'border border-slate-300 text-slate-600 hover:bg-white' },
  rien: { label: 'Ouvrir', pane: 'add', cls: 'border border-slate-300 text-slate-600 hover:bg-white' },
}

// « Apparier » : les documents au même montant, et le bouton qui lie.
// Maquette M1 (choix de Charles, 2026-10-03) : la ligne du relevé et la pièce
// côte à côte, un ✓ ou un ✕ par ligne. Une pièce déjà portée par une autre
// ligne du relevé (la dépense du mois d'avant) le dit, et le gros bouton
// devient « Créer la dépense » : l'apparier la paierait deux fois.
function QbMatchPane({ txn, currency, onChanged, onAdd }) {
  const [items, setItems] = useState(null)
  const [pick, setPick] = useState(0)
  const [more, setMore] = useState(false)
  const [mine, setMine] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const names = useQbNames(true)

  useEffect(() => {
    let alive = true
    setPick(0); setMore(false); setItems(null); setMine(null)
    api.bank.suggestions(txn.id)
      .then((r) => { if (alive) setItems(r || []) })
      .catch((e) => { if (alive) { setItems([]); setError(e.message) } })
    if (txn.amount < 0) api.bank.addDefaults(txn.id).then((d) => { if (alive) setMine(d) }).catch(() => {})
    return () => { alive = false }
  }, [txn.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const link = async (s) => {
    setBusy(true); setError(null)
    try {
      const r = await api.bank.match(txn.id, { matched_type: s.type, matched_id: s.id })
      invalidate('/bank')
      // L'appariement est posé même si QuickBooks refuse : on le dit, le geste
      // reste rejouable depuis la ligne.
      if (r?.qbError) setError(`Lié, mais pas publié dans QuickBooks — ${r.qbError}`)
      else await onChanged()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  if (items == null) return <div className="py-6 text-center text-xs text-slate-400">Recherche…</div>
  const c = items[pick]
  const others = (
    items.length > 1 && (
      <div className="text-center">
        <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => setMore((m) => !m)}>
          {items.length - 1} autre{items.length > 2 ? 's' : ''}
        </button>
        {more && (
          <div className="mt-2 space-y-1 text-left">
            {items.map((s, i) => (
              <button key={`${s.type}:${s.id}`} type="button" onClick={() => { setPick(i); setMore(false) }}
                className={`w-full flex items-center gap-2 rounded-lg border px-3 py-1.5 ${i === pick ? 'border-green-500 bg-green-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                <span className="min-w-0 grow truncate">{s.vendor || s.label}</span>
                {s.linked_txn && <span className="text-[11px] text-amber-600">déjà liée</span>}
                <span className="text-xs text-slate-500">{fmtDate(s.date)}</span>
                <span className="tabular-nums">{money(Math.abs(s.total), currency)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  )
  if (!c) {
    return (
      <div className="flex flex-col gap-3">
        <div className="py-6 text-center text-xs text-slate-500">Aucune pièce au même montant.</div>
        {error && <div className="text-xs text-red-600">{error}</div>}
        {onAdd && <SlipCta label={txn.amount < 0 ? 'Créer la dépense' : 'Ajouter'} onClick={onAdd} />}
      </div>
    )
  }

  const short = (d) => String(d).slice(0, 10)
  const gap = Math.abs(Math.round((new Date(txn.txn_date) - new Date(c.date)) / 86400000))
  const sameAmt = Math.abs(Math.abs(c.total) - Math.abs(txn.amount)) < 0.011 || (c.reasons || []).some((r) => /converti/.test(r))
  const acctName = (id) => (names?.accounts || []).find((o) => String(o.Id) === String(id))?.Name || null
  const myAcct = mine?.expense_account_id ? acctName(mine.expense_account_id) : null
  const docAcct = c.account_name ? c.account_name.split(':').pop() : (c.account_id ? acctName(c.account_id) : null)
  const myVendor = mine?.vendor || txn.vendor_name || txnLabel(txn)
  const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '')
  const sameVendor = mine?.vendor && c.vendor && (norm(c.vendor).includes(norm(mine.vendor)) || norm(mine.vendor).includes(norm(c.vendor)))
  const rows = [
    ['Qui', myVendor, c.vendor || c.label, sameVendor ? true : null],
    ['Montant', money(Math.abs(txn.amount), currency), money(Math.abs(c.total), currency), sameAmt],
    ['Date', short(txn.txn_date), short(c.date), gap <= 7],
    (myAcct || docAcct) && ['Compte', myAcct || '—', docAcct || '—', myAcct && mine?.expense_account_id && String(mine.expense_account_id) === String(c.account_id) ? true : (myAcct && docAcct ? false : null)],
  ].filter(Boolean)
  const head = [c.kind || 'QuickBooks', c.quickbooks_id].filter(Boolean).join(' ')
  const taken = c.linked_txn
  const mark = (ok) => ok == null ? <span /> : ok
    ? <Check size={13} className="text-green-600 mx-auto" />
    : <X size={13} className="text-red-500 mx-auto" />

  return (
    <div className="flex flex-col gap-3" data-testid="qb-match-m1">
      <div className="rounded-xl border border-slate-200 overflow-hidden text-[13px]">
        <div className="grid grid-cols-[64px_1fr_20px_1fr] bg-slate-50 text-[11.5px] font-semibold text-slate-500">
          <span /><span className="px-2 py-2">Banque</span><span />
          <span className="px-2 py-2 truncate" onClick={(e) => e.stopPropagation()}>{docLink(c.type, c.id, head)}</span>
        </div>
        {rows.map(([k, l, r, ok]) => (
          <div key={k} className="grid grid-cols-[64px_1fr_20px_1fr] items-center border-t border-slate-100">
            <span className="pl-3 py-2 text-xs text-slate-500">{k}</span>
            <span className="px-2 py-2 truncate tabular-nums" title={l}>{l}</span>
            {mark(ok)}
            <span className={`px-2 py-2 truncate tabular-nums ${ok === false ? 'text-red-600' : ''}`} title={r}>{r}</span>
          </div>
        ))}
      </div>
      {taken && (
        <div className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-amber-700 font-medium">
          <AlertTriangle size={14} className="shrink-0" /> Déjà payée par la ligne du {short(taken.txn_date)}
        </div>
      )}
      {error && <div className="text-xs text-red-600">{error}</div>}
      {taken && onAdd ? (
        <>
          <SlipCta label={`${txn.amount < 0 ? 'Créer la dépense' : 'Ajouter le dépôt'} du ${short(txn.txn_date)}`} onClick={onAdd} />
          <div className="flex justify-center gap-4 text-xs">
            <button type="button" disabled={busy} className="text-brand-600 hover:underline disabled:opacity-50" onClick={() => link(c)}>
              {busy ? 'Liaison…' : 'Apparier quand même'}
            </button>
          </div>
          {others}
        </>
      ) : (
        <>
          <SlipCta label="Apparier" busy={busy} busyLabel="Liaison…" onClick={() => link(c)} />
          {others}
        </>
      )}
    </div>
  )
}

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
  if (!rows.length) return <div className="px-5 py-4 text-sm text-slate-400">Aucune facture manquante.</div>

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

// Le signet : un ruban, un seul par compte. Le rond rouge « à réviser » se
// pose sur la date elle-même (maquette Q2, 2026-10-03).
function RowMarks({ row, bookmarked, onBookmark }) {
  const [busy, setBusy] = useState(false)
  const click = async (e) => {
    e.stopPropagation()
    setBusy(true)
    try { await onBookmark(bookmarked ? null : row.id) } finally { setBusy(false) }
  }
  return (
    <span className="lg-marks flex items-center justify-center h-full">
      <button type="button" disabled={busy} data-testid="row-bookmark" aria-pressed={bookmarked}
        aria-label={bookmarked ? 'Retirer le signet' : 'Poser le signet ici'} title={bookmarked ? 'Retirer le signet' : 'Poser le signet ici'}
        onClick={click} className="lg-mark-ribbon" />
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

// Encaissement d'une facture client, version « reçu » : la facture, ce que
// QuickBooks recevra (compte, taxes) et un seul bouton qui enregistre le
// paiement, pose le dépôt QuickBooks, comptabilise la ligne et marque la
// facture payée dans Stripe.
function InvoiceSlip({ txn, invoices, ambiguous, currency, onDone }) {
  const [pick, setPick] = useState(0)
  const [q, setQ] = useState('')
  const [found, setFound] = useState(null)
  const [preview, setPreview] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const list = found ?? invoices
  const f = list[pick] || null
  const amount = f ? (f.balance_due > 0 ? f.balance_due : f.total_amount) : 0
  const method = /interac/i.test(`${txn.description || ''} ${txn.details || ''}`) ? 'interac' : 'virement_bancaire'

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setFound(null); return undefined }
    const t = setTimeout(() => {
      api.bank.invoiceSearch(txn.id, term).then((r) => { setFound(r?.candidates || []); setPick(0) }).catch(() => setFound([]))
    }, 250)
    return () => clearTimeout(t)
  }, [q, txn.id])

  useEffect(() => {
    if (!f) { setPreview(null); return undefined }
    let alive = true
    setPreview(undefined)
    api.payments.previewDeposit({ facture_id: f.id, amount, currency: f.currency || currency || 'CAD', method, received_at: txn.txn_date })
      .then((r) => { if (alive) setPreview(r?.summary || null) })
      .catch(() => { if (alive) setPreview(null) })
    return () => { alive = false }
  }, [f?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const pay = async () => {
    setBusy(true); setError(null)
    try {
      const r = await api.payments.create({
        facture_id: f.id, direction: 'in', method, received_at: txn.txn_date, amount,
        currency: f.currency || currency || 'CAD',
        notes: `Encaissement vu au relevé — ${txnLabel(txn)}`,
        clear_paid_status: !!(f.paid_at && !f.paid_charge_id && !f.paid_payment_intent),
        bank_txn_id: txn.id, mark_stripe_paid: true,
      })
      invalidate('/bank')
      if (r?.qb_error) { setError(`Paiement enregistré, mais pas de dépôt QuickBooks — ${r.qb_error}`); return }
      if (r?.stripe?.error) celebrate('Comptabilisé — Stripe à marquer à la main')
      else celebrate(r?.stripe?.marked ? 'Comptabilisé · payée dans Stripe' : 'Comptabilisé')
      await onDone()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const sum = preview
  return (
    <div className="flex flex-col gap-3">
      {f ? (
        <div>
          <SlipRow label="Client" value={<Link to={`/factures/${f.id}`} className="link-record">{f.company_name || '—'}</Link>} />
          <SlipRow label="Facture" value={<>{f.document_number} <span className="font-normal text-slate-500">· {fmtDate(f.document_date)}</span>
            {f.lien_stripe && <a href={f.lien_stripe} target="_blank" rel="noreferrer" className="ml-1.5 text-slate-300 hover:text-brand-600"><ExternalLink size={11} className="inline" /></a>}</>} />
          <SlipRow label="Montant" warn={Math.abs(amount - Math.abs(txn.amount)) > 0.01}
            value={<>{money(amount, f.currency || currency)} {Math.abs(amount - Math.abs(txn.amount)) <= 0.01 && <span className="text-green-700">✓</span>}</>} />
          <SlipRow label="Compte" value={sum === undefined ? <span className="text-slate-400">…</span> : sum?.credit_account || '—'} />
          <SlipRow label="Taxe" value={sum === undefined ? <span className="text-slate-400">…</span> : sum?.tax_code || 'Aucun code (hors taxes)'} />
          <SlipRow label="Dépôt dans" value={sum === undefined ? <span className="text-slate-400">…</span> : sum?.bank_account || '—'} />
          <SlipRow label="Stripe" value={<span className="font-normal text-slate-600">sera marquée payée</span>} />
        </div>
      ) : (
        <div className="py-6 text-center text-xs text-slate-500">Aucune facture ne correspond.</div>
      )}
      {sum && sum.taxes > 0 && (
        <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 rounded-xl bg-slate-50 px-3.5 py-2.5 text-[12.5px] tabular-nums">
          <span>Avant taxes</span><span className="text-right font-medium">{money(sum.line_ht, sum.currency)}</span>
          <span className="text-slate-500">Taxes</span><span className="text-right text-slate-500">{money(sum.taxes, sum.currency)}</span>
        </div>
      )}
      {error && <div className="text-xs text-red-600">{error}</div>}
      {f && <SlipCta label="Comptabiliser" busy={busy} busyLabel="Comptabilisation…" onClick={pay} />}
      {(ambiguous || list.length > 1) && (
        <div className="space-y-1">
          {list.map((x, i) => i !== pick && (
            <button key={x.id} type="button" onClick={() => setPick(i)}
              className="w-full flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-left text-xs hover:bg-slate-50">
              <span className="min-w-0 grow truncate">{x.company_name} · {x.document_number}</span>
              <span className="tabular-nums">{money(x.balance_due > 0 ? x.balance_due : x.total_amount, x.currency)}</span>
            </button>
          ))}
        </div>
      )}
      <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Chercher une facture"
        className="text-xs border border-slate-200 rounded-lg px-2 py-1 text-slate-700" placeholder="Autre facture…" />
    </div>
  )
}

function DossierFocus({ txn, currency, focus, dossier, reload, onChanged, onDone }) {
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
    if (onDone) return <InvoiceSlip txn={txn} invoices={dossier.invoices} ambiguous={dossier.invoices_ambiguous} currency={currency} onDone={onDone} />
    return <InvoiceCard txn={txn} invoices={dossier.invoices} ambiguous={dossier.invoices_ambiguous} currency={currency} onChanged={onChanged} />
  }
  return <ReceiptCard txn={txn} receipts={dossier.receipts} ambiguous={dossier.receipts_ambiguous} onChanged={onChanged} />
}

export default function RapprochementBancaire() {
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
  // L'étape (Pour révision / Catégorisées / Exclues) et le filtre de ligne.
  const [stage, setStage] = useState('rev')
  const [lineFilter, setLineFilter] = useState(null)
  const account = accounts.find((a) => a.id === accountId) || null

  const loadAccounts = useCallback(async () => {
    const list = await api.bank.accounts()
    setAccounts(list)
    // Au chargement : le compte demandé dans l'URL gagne, sinon on garde le
    // courant, sinon « À comptabiliser » (Charles, 2026-10-06). On passe par le
    // setter brut pour ne pas réécrire l'URL quand personne n'a rien demandé.
    setAccountIdRaw((prev) => {
      const wanted = new URLSearchParams(window.location.search).get('compte')
      if (wanted === TODO_TAB || (wanted && list.some((a) => a.id === wanted))) return wanted
      if (prev === TODO_TAB) return prev
      return prev && list.some((a) => a.id === prev) ? prev : TODO_TAB
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
          .filter((r) => (TODO_STATUSES.has(r.status) || r.awaiting_payment) && (r.txn_date || '') >= TODO_SINCE)
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
  useEffect(() => { setLineFilter(null); setStage('rev') }, [accountId])
  useEffect(() => { setLineFilter(null) }, [stage])

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
  // Panneau « reçu » (ligne à traiter, ouverte par un clic) : il porte son propre
  // en-tête — l'en-tête du tiroir resterait en double.
  const composing = !!peekRow && (peekRow._ghost || !(peekOpen.forId === peekRow.id && peekOpen.mode))
  // Facture retracée : le clic sur la ligne ouvre le document lui-même (reçu
  // extrait, payout, facture fournisseur) plutôt que de déplier la ligne.
  const [achatDoc, setAchatDoc] = useState(null)
  const [rowMenu, setRowMenu] = useState(null)
  const closeRowMenu = useCallback(() => setRowMenu(null), [])
  const navigate = useNavigate()
  // Ligne liée à un document de l'Extraction de données : le clic ouvre CE
  // document, comme depuis l'Extraction (Charles, 2026-10-06 — « comme avant »).
  const receiptOf = (r) => (!r._ghost && r.matched_type === 'receipt' && r.matched_id ? r.matched_id : null)
  const openTransaction = (r) => {
    const doc = receiptOf(r)
    if (doc) { navigate(`/sale-receipts/${doc}`); return }
    setPeekOpen({ id: r.id, mode: null, forId: r.id })
  }

  // « Ouvre CETTE ligne » : l'étape suit la ligne demandée.
  useEffect(() => {
    const r = askedRow && allRows.find((x) => x.id === askedRow)
    if (r) setStage(stageOf(r))
  }, [askedRow, allRows.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const stageCounts = useMemo(() => {
    const c = { rev: 0, cat: 0, exc: 0 }
    for (const r of allRows) if (!r._ghost) c[stageOf(r)] += 1
    return c
  }, [allRows])
  const stageRows = useMemo(() => allRows.filter((r) => stageOf(r) === stage), [allRows, stage])

  // Compteurs sur toute l'étape : ils ne bougent pas quand on filtre.
  const counts = useMemo(() => {
    const c = { review: 0, requested: 0, match: 0, xfer: 0, none: 0, ghost: 0 }
    for (const r of stageRows) {
      if (r.review_flag) c.review += 1
      if (r.invoice_requested) c.requested += 1
      c[lineKind(r, nextActions[r.id])] = (c[lineKind(r, nextActions[r.id])] || 0) + 1
    }
    return c
  }, [stageRows, nextActions])

  const visibleRows = useMemo(() => {
    if (!lineFilter || stage !== 'rev') return stageRows
    if (lineFilter === 'review') return stageRows.filter((r) => r.review_flag)
    // Les plus vieilles d'abord : c'est l'ancienneté qui dit ce qui presse.
    if (lineFilter === 'requested') {
      return stageRows.filter((r) => r.invoice_requested)
        .sort((a, b) => String(a.txn_date).localeCompare(String(b.txn_date)))
    }
    return stageRows.filter((r) => lineKind(r, nextActions[r.id]) === lineFilter)
  }, [stageRows, lineFilter, stage, nextActions])

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

  const qbNames = useQbNames(rows.some((r) => r.suggestion?.kind === 'vendor_expense' || r.auto_suggestion?.kind === 'vendor_expense')
    || Object.values(nextActions).some((n) => n?.expense_account_id))
  // Clone des « Opérations bancaires » de QuickBooks (maquette Q2, 2026-10-03) :
  // lignes neutres, Dépense / Dépôt, « Catégorie ou correspondance », et le
  // geste attendu en bout de ligne. Les marques de Boréal restent : rond rouge
  // sur la date, ruban du signet, drapeau « sans facture ».
  const COLUMNS = useMemo(() => {
    const num = (v, cls = '', cur = currency) => (v == null
      ? null
      : <span className={`block text-right tabular-nums ${cls}`}>{money(v, cur)}</span>)
    const renderers = {
      comment: (r) => (r._ghost ? '—' : <TransactionComment key={r.id} txn={r} onSave={saveComment} />),
      txn_date: (r) => (
        <span className="whitespace-nowrap text-slate-600 tabular-nums">
          {!!r.pending && <span title="En attente à la banque"><Clock size={11} className="inline mr-1 -mt-0.5 text-slate-400" /></span>}
          {r._ghost ? fmtDate(r.txn_date) : (
            <button type="button" data-testid="review-mark" aria-pressed={!!r.review_flag}
              title={r.review_flag ? 'Retirer « à réviser »' : 'Marquer à réviser'}
              onClick={(e) => { e.stopPropagation(); setReview(r, !r.review_flag) }}
              className={`qbo-date ${r.review_flag ? 'lg-pen' : ''}`}>{fmtDate(r.txn_date)}</button>
          )}
        </span>
      ),
      description: (r) => (
        <span className={`block min-w-0 leading-tight ${r._ghost ? 'italic text-slate-400' : ''}`}>
          <span className="flex items-center gap-1.5 min-w-0">
            {r._flag && <span title={r._flag} className="shrink-0"><AlertTriangle size={12} className="text-amber-500" /></span>}
            {r._ghost && <span className="shrink-0">QuickBooks ·</span>}
            <span className="lg-lbl truncate">{txnLabel(r)}</span>
            {!!r.invoice_requested && <span title="Facture manquante" className="shrink-0"><Flag size={11} className="text-amber-600" /></span>}
            {r._acct && <span className="shrink-0 px-1.5 rounded bg-slate-100 text-[11px] text-slate-500">{r._acct.name}</span>}
          </span>
          {txnSubLabel(r) && <span className="block truncate text-[11.5px] text-slate-400 mt-0.5">{txnSubLabel(r)}</span>}
        </span>
      ),
      bank_description: (r) => (txnSubLabel(r)
        ? <span className="block truncate text-slate-500" title={txnSubLabel(r)}>{txnSubLabel(r)}</span>
        : null),
      debit: (r) => num(r._ghost ? (r.amount < 0 ? -r.amount : null) : r.debit, 'text-slate-800', r._acct?.currency || currency),
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
            <Link to="/fournisseurs" onClick={(e) => e.stopPropagation()} className="block truncate text-blue-700 hover:underline"
              title={`Reconnu par ${VENDOR_VIA[r.resolved_vendor.via] || r.resolved_vendor.via}`}>
              {r.resolved_vendor.name}
            </Link>
          )
          : null),
      bank_state: (r) => {
        const m = BANK_STATE_META[r.bank_state]
        return m ? <span className={`block truncate ${m.cls}`}>{m.label}</span> : null
      },
      match_confidence: (r) => (r.match_confidence != null ? `${Math.round(r.match_confidence * 100)} %` : '—'),
    }
    const LABELS = { debit: 'Dépense', credit: 'Dépôt' }
    // Le statut est l'étape ; la description de la banque vit sous le libellé ;
    // l'état à la banque se lit à l'horloge sur la date.
    const meta = Object.fromEntries(TABLE_COLUMN_META.bank_transactions
      .filter((c) => !['status', 'bank_description', 'txn_date', 'description'].includes(c.id))
      .map((c) => [c.id, {
        ...c, label: LABELS[c.id] || c.label, render: renderers[c.id],
        ...(c.id === 'bank_state' ? { defaultVisible: false } : {}),
      }]))
    // Date et libellé sous des ids neufs : les largeurs enregistrées pour
    // l'ancien relevé (174 et 542 px) poussaient Dépense, Dépôt et le bouton
    // hors de l'écran.
    meta.qbo_date = { id: 'qbo_date', label: 'Date', field: 'txn_date', type: 'date', width: 112, render: renderers.txn_date }
    meta.qbo_label = { id: 'qbo_label', label: 'Description', field: 'label', width: 250, render: renderers.description }
    const fixed = { alwaysVisible: true, sortable: false, filterable: false, groupable: false }
    const marks = {
      id: '_marks', label: '', width: 30, ...fixed,
      render: (r) => (r._ghost || accountId === TODO_TAB ? null : (
        <RowMarks row={r} bookmarked={account?.bookmark_txn_id === r.id} onBookmark={setBookmark} />
      )),
    }
    const cur = (r) => r._acct?.currency || currency
    // Fournisseur reconnu en gras, libellé de la banque dessous ; sans
    // fournisseur, le libellé devient la ligne principale.
    meta.r3_vendor = {
      id: 'r3_vendor', label: 'Fournisseur', field: 'vendor_name', width: 280,
      render: (r) => {
        const v = renderers.vendor(r)
        const sub = txnSubLabel(r)
        const flags = (
          <>
            {r._flag && <span title={r._flag} className="shrink-0"><AlertTriangle size={12} className="text-amber-500" /></span>}
            {!!r.invoice_requested && <span title="Facture manquante" className="shrink-0"><Flag size={11} className="text-amber-600" /></span>}
            {r._acct && <span className="shrink-0 px-1.5 rounded bg-slate-100 text-[11px] text-slate-500">{r._acct.name}</span>}
          </>
        )
        const bank = txnLabel(r)
        return (
          <span className={`block min-w-0 leading-tight ${r._ghost ? 'italic' : ''}`}>
            <span className="flex items-center gap-1.5 min-w-0">
              {r._ghost && <span className="shrink-0 text-slate-400">QuickBooks ·</span>}
              {v ? <span className="min-w-0 font-semibold text-slate-800 truncate"><VendorHover name={r.resolved_vendor?.name || r.vendor_name}>{v}</VendorHover></span>
                : <span className="lg-lbl truncate text-slate-700" title={sub || undefined}>{bank}</span>}
              {flags}
            </span>
            {v && <span className="block truncate text-[11.5px] text-slate-400 mt-0.5" title={sub || bank}>{bank}</span>}
          </span>
        )
      },
    }
    meta.r3_amount = {
      id: 'r3_amount', label: 'Montant', field: 'amount', type: 'number', width: 130,
      render: (r) => (r.amount == null ? null : (
        <span className={`block text-right tabular-nums ${r.amount < 0 ? 'text-slate-800' : 'text-green-700'}`}>
          {r.amount < 0 ? money(-r.amount, cur(r)) : `+ ${money(r.amount, cur(r))}`}
        </span>
      )),
    }
    // L3 : ce que la ligne deviendra, puis le geste en lien bleu (QuickBooks).
    // Hors « Pour révision », la cellule et le bouton d'avant restent.
    const category = {
      id: 'l3_cat', label: 'Catégorie ou correspondance', width: 340, ...fixed,
      render: (r) => (r._ghost || stage !== 'rev' || (r.auto_suggestion && !r.suggestion)
        ? <CategoryCell row={r} stage={stage} next={nextActions[r.id]} names={qbNames} currency={cur(r)} onChanged={refresh} />
        : <QboCatCell row={r} next={nextActions[r.id]} names={qbNames} currency={cur(r)} bankAccounts={accounts} />),
    }
    const action = {
      id: 'l3_act', label: 'Action', width: 120, ...fixed,
      render: (r) => (r._ghost || stage !== 'rev'
        ? <RowAction row={r} stage={stage} next={nextActions[r.id]} onChanged={refresh} onOpenPanel={openTransaction} />
        : <QboActCell row={r} next={nextActions[r.id]} onChanged={refresh} />),
    }
    // Solde, Dépense, Dépôt, Description : masqués, réactivables au sélecteur.
    for (const k of ['debit', 'credit', 'balance', 'vendor']) if (meta[k]) meta[k].defaultVisible = false
    meta.qbo_label.defaultVisible = false
    const order = ['qbo_date', 'r3_vendor']
    const rest = Object.values(meta).filter((c) => !order.includes(c.id) && c.id !== 'r3_amount')
    return [marks, ...order.map((k) => meta[k]), category, meta.r3_amount, action, ...rest]
  }, [currency, saveComment, refresh, nextActions, account?.bookmark_txn_id, accountId, setReview, setBookmark, qbNames, stage, accounts]) // eslint-disable-line react-hooks/exhaustive-deps

  // Panneau instantané : ce qu'il lit est demandé dès que la souris passe sur
  // la ligne (cache de 30 s), et les listes QuickBooks dès l'arrivée sur la page.
  useEffect(() => { prefetch(() => api.quickbooks.accounts()); prefetch(() => api.quickbooks.taxCodes()) }, [])
  const warmed = useRef(new Set())
  const warmRow = (e) => {
    const id = e.target.closest?.('tr[data-row-id]')?.getAttribute('data-row-id')
    if (!id || warmed.current.has(id)) return
    const r = allRows.find((x) => String(x.id) === id)
    if (!r || r._ghost || r.matched_id || r.transfer_txn_id) return
    warmed.current.add(id)
    setTimeout(() => warmed.current.delete(id), 25_000)
    if (r.amount < 0) {
      prefetch(() => api.bank.addDefaults(r.id).then((d) => {
        const t = d?.draft?.fields?.tax_code_id?.value || d?.tax_code_id
        if (t && t !== NO_TAX) prefetch(() => api.bank.taxCodeRate(t))
      }))
    }
    prefetch(() => api.bank.suggestions(r.id))
    prefetch(() => api.bank.rules.opportunity(r.id))
  }

  return (
    <Layout>
      <div className="px-3 pt-3">
        {notice && <div className="mb-3 text-sm bg-green-50 text-green-800 rounded-lg px-3 py-2">{notice}</div>}

        <div className="qbo-sheet" onMouseOver={warmRow}>
          <QboHeader account={account} isTodo={accountId === TODO_TAB} rec={rec}
            robot={account?.qb_account_id ? robot : null}
            menu={<MoreMenu onDrop={() => setShowDrop(true)} onRules={() => setRulesOpen(true)} flash={flash} robot={account?.qb_account_id ? robot : null} />} />
          <StageTabs value={stage} onChange={setStage} counts={stageCounts} isTodo={accountId === TODO_TAB} />
        <DataTable
          table="bank_transactions"
          skin="ledger"
          expandToggle={false}
          height="calc(100vh - 290px)"
          rowHeight={52}
          pinnedColumns={PINNED_COLUMNS}
          // Le compte n'est nommé qu'une fois en grand, dans l'en-tête ; les
          // comptes restent en onglets en bas (maquette Q2, 2026-10-03).
          toolsMenu
          toolbarStart={<>
            {stage === 'rev' && <LineFilters counts={counts} value={lineFilter} onChange={setLineFilter} onRequests={() => setRequestsOpen(true)} />}
            <StatusLegend />
          </>}
          columns={COLUMNS}
          openKey={askedRow}
          data={visibleRows}
          loading={loading}
          rowKey="id"
          // Lignes neutres, comme QuickBooks : seule la ligne fantôme se
          // distingue. Une règle de couleur de vue (style inline de DataTable)
          // gagne toujours — la règle explicite de l'utilisateur passe avant.
          // Code couleur du classeur (rouge / bleu / jaune / vert / gris) : la ligne
          // entière prend la couleur de son statut — Charles s'en sert, ne pas retirer.
          rowClassName={(r) => `${r._ghost ? GHOST_META.tint : STATUS_META[r.awaiting_payment ? 'facture_recue' : bucketOf(r)].tint}${r._flag ? ' row-flagged' : ''}`}
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
              },
            },
            {
              // Plusieurs lignes du relevé pour un seul montant ailleurs (10
              // petits crédits Rona contre une ligne de 163,49 $). Si la
              // sélection contient déjà la ligne du total, les autres s'y fondent.
              key: 'group', label: 'Regrouper', icon: Combine, busyLabel: 'Regroupement…',
              show: (rows) => {
                const real = rows.filter((r) => !r._ghost)
                if (real.length === 1) return !!real[0].group_parent_id
                return real.length >= 2 && !real.some((r) => r.group_count)
              },
              onClick: async (ids) => {
                const rows = allRows.filter((r) => ids.includes(r.id) && !r._ghost)
                try {
                  const parents = new Set(rows.map((r) => r.group_parent_id))
                  if (parents.size === 1 && rows[0].group_parent_id) {
                    await api.bank.regroupTxn(rows[0].id)
                  } else {
                    const sum = rows.reduce((s, r) => s + r.amount, 0)
                    const total = rows.find((r) => Math.abs(2 * r.amount - sum) < 0.005)
                    if (total) await api.bank.groupTxns(rows.filter((r) => r !== total).map((r) => r.id), total.id)
                    else await api.bank.groupTxns(rows.map((r) => r.id))
                  }
                } catch (e) { flash(e.message) }
                invalidate('/bank')
                await refresh()
              },
            },
            {
              key: 'ungroup', label: 'Dégrouper', icon: Split, busyLabel: 'Mise à jour…',
              show: (rows) => rows.length === 1 && !!rows[0].group_count,
              onClick: async (ids) => {
                try { await api.bank.ungroupTxn(ids[0]) } catch (e) { flash(e.message) }
                invalidate('/bank')
                await refresh()
              },
            },
            {
              key: 'ignore', label: 'Exclure', icon: Unlink, busyLabel: 'Mise à jour…',
              show: (rows) => rows.some((r) => !r._ghost && r.status !== 'ignore'),
              onClick: async (ids) => {
                await bulkReal(ids, async (real) => {
                  for (const id of real) await api.bank.updateTransaction(id, { status: 'ignore' })
                })
              },
            },
            {
              key: 'reactivate', label: 'Rétablir', icon: Undo2, busyLabel: 'Mise à jour…',
              show: (rows) => rows.length > 0 && rows.every((r) => r.status === 'ignore'),
              onClick: async (ids) => {
                await bulkReal(ids, async (real) => {
                  for (const id of real) await api.bank.updateTransaction(id, { status: 'a_traiter' })
                })
              },
            },
          ]}
          // « Pour révision » : la ligne s'ouvre dessous (L3). Ailleurs, et pour
          // une écriture fantôme, le panneau d'avant.
          singleExpand
          onRowContextMenu={(r, e) => { if (!r._ghost) setRowMenu({ row: r, x: e.clientX, y: e.clientY }) }}
          onRowClick={(r) => {
            if (stage === 'rev' && !r._ghost && !receiptOf(r)) return false
            openTransaction(r)
            return undefined
          }}
          renderExpanded={(r, { collapse }) => (stage === 'rev' && !r._ghost ? (
            <RecordScope id={r.id}>
              <QboLine key={r.id} txn={r} currency={r._acct?.currency || currency} next={nextActions[r.id]} bankAccounts={accounts}
                accountName={r._acct?.name || account?.name}
                onChanged={refresh} collapse={collapse} />
            </RecordScope>
          ) : null)}
          emptyState={stage === 'rev' && rows.length
            ? { title: 'Tout est à jour ✓', description: '' }
            : { title: 'Aucune transaction', description: stage === 'rev' ? 'Importer un relevé pour commencer le rapprochement.' : '' }}
        />
        </div>
        <div className="dt-skin-ledger">
          <AccountTabs accounts={accounts} accountId={accountId} onChange={setAccountId} />
        </div>
      </div>

      <RecordPeekDrawer open={!!peekRow}
        onClose={() => setPeekOpen({ id: null, mode: null, forId: null })}
        title={peekRow && !composing ? txnLabel(peekRow) : ''}
        subtitle={peekRow && !composing ? fmtDate(peekRow.txn_date) : ''} width={480} peekKey="bank-txn-slip">
        {peekRow && <RecordScope id={peekRow.id}>
          {peekRow._ghost
            ? <GhostPeek row={peekRow} currency={currency} />
            : <TxnPeek key={peekRow.id} txn={peekRow} currency={peekRow._acct?.currency || currency} onChanged={refresh}
                initialMode={peekOpen.forId === peekRow.id ? peekOpen.mode : null} next={nextActions[peekRow.id]}
                accountName={peekRow._acct?.name || account?.name}
                onClose={() => setPeekOpen({ id: null, mode: null, forId: null })} />}
        </RecordScope>}
      </RecordPeekDrawer>

      {rowMenu && <RowContextMenu menu={rowMenu} onClose={closeRowMenu} onDossier={(r) => (receiptOf(r) ? openTransaction(r) : setPeekOpen({ id: r.id, mode: 'full', forId: r.id }))} onChanged={refresh} />}

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
        title="Factures manquantes" subtitle="Décocher sort du message, pas de la liste" width={460}>
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
