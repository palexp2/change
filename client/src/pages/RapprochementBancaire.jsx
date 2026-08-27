import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Upload, Wand2, CheckCheck, Undo2, Link2, Unlink, ExternalLink, RefreshCw, AlertTriangle, ChevronRight, FileSpreadsheet, BookOpen, Download } from 'lucide-react'
import api from '../lib/api.js'
import { invalidate } from '../lib/prefetch.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

// Statuts = l'ancien code couleur du fichier TRX_Orisha.xlsx.
const STATUS_META = {
  a_traiter:     { label: 'À traiter',      color: 'red',    hint: 'Aucun document trouvé — souvent facture manquante' },
  facture_recue: { label: 'Facture reçue',  color: 'blue',   hint: 'Document apparié, pas encore publié à QB' },
  comptabilise:  { label: 'Comptabilisé',   color: 'yellow', hint: 'Publié à QuickBooks, pas encore rapproché' },
  rapproche:     { label: 'Rapproché',      color: 'green',  hint: 'Comptabilisé et validé contre le relevé' },
  ignore:        { label: 'Ignoré',         color: 'gray',   hint: 'Exclu du rapprochement' },
}

function money(n, currency = 'CAD') {
  if (n == null) return <span className="text-slate-300">—</span>
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n)
}

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
          placeholder={'Date\tDescription\tRéférence\tDébit\tCrédit\tSolde\n2026-07-27\tREMB. MCR\t60024937974\t\t73,00\t…'}
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

// ── Drawer latéral : détail + suggestions de matching ────────────────────────
function TxnPeek({ txn, currency, onChanged }) {
  const [suggestions, setSuggestions] = useState(null)
  const [busy, setBusy] = useState(false)
  const [comment, setComment] = useState(txn.comment || '')
  const [pushError, setPushError] = useState(null)
  // Besoin de collecte : y a-t-il un portail fournisseur à interroger pour cette
  // ligne ? null = pas encore chargé, false = aucun collecteur.
  const [need, setNeed] = useState(null)
  const [collecting, setCollecting] = useState(false)

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

      {txn.matched_id ? (
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

// ── Panneau de rapprochement — solde calculé, solde QuickBooks, écart ────────
//
// L'équivalent de l'écran « Rapprocher » de QuickBooks : le solde du compte est
// recalculé à partir du relevé importé, comparé au solde QuickBooks à la même
// date, et tout écart est décomposé en transactions précises (au relevé mais
// pas dans QB, dans QB mais pas au relevé, rupture de la chaîne des soldes).

function Figure({ label, value, sub, tone = 'neutral', testId, loading }) {
  const toneClass = tone === 'ok' ? 'text-green-700' : tone === 'bad' ? 'text-red-700' : 'text-slate-900'
  return (
    <div className="px-4 py-3 min-w-0">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-xl font-semibold tabular-nums truncate ${toneClass}`} data-testid={testId}>
        {loading ? <span className="text-slate-300">…</span> : value}
      </div>
      {sub && <div className="text-xs text-slate-400 truncate">{sub}</div>}
    </div>
  )
}

// Une section dépliable de l'écart (liste de lignes fautives).
function GapSection({ id, icon: Icon, color, title, count, open, onToggle, children }) {
  if (!count) return null
  return (
    <div className="border-t border-slate-100">
      <button type="button" data-testid={`reconcile-gap-${id}`}
        className="w-full flex items-center gap-2 px-4 py-2 text-sm text-left hover:bg-slate-50 transition-colors"
        onClick={onToggle}>
        <Icon size={14} className={color} />
        <span className="font-medium text-slate-700">{count}</span>
        <span className="text-slate-600">{title}</span>
        <span className="grow" />
        <ChevronRight size={14} className={`text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && <div className="px-4 pb-3 space-y-1 max-h-72 overflow-auto">{children}</div>}
    </div>
  )
}

function ReconcilePanel({ account, refreshKey, onChanged, onOpenTxn }) {
  const [summary, setSummary] = useState(null)
  const [qb, setQb] = useState(null)
  const [qbLoading, setQbLoading] = useState(false)
  const [qbError, setQbError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(null)

  const accountId = account?.id
  const currency = account?.currency

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

  useEffect(() => { setQb(null); setQbError(null); setOpen(null); loadQb() }, [loadQb])

  const runAuto = async () => {
    setBusy(true)
    try {
      await api.bank.reconcileAuto(accountId)
      await onChanged()
      await loadQb()
    } finally { setBusy(false) }
  }

  if (!account) return null
  const stmt = summary?.statement
  const bal = qb?.balance && !qb.balance.error ? qb.balance : null
  const diff = bal?.difference
  const anomalies = summary?.anomalies || []
  const missingQb = qb?.missing_in_qb || []
  const missingStmt = qb?.missing_in_statement || []
  const toggle = (k) => setOpen((prev) => (prev === k ? null : k))

  return (
    <div data-testid="reconcile-panel" className="mb-4 rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="flex flex-wrap items-stretch divide-x divide-slate-100">
        <Figure label="Solde du relevé" testId="reconcile-statement-balance"
          loading={!summary}
          value={stmt?.balance_signed != null ? money(stmt.balance_signed, currency) : <span className="text-slate-300">—</span>}
          sub={stmt?.date ? `au ${fmtDate(stmt.date)}` : null} />
        <Figure label="Solde QuickBooks" testId="reconcile-qb-balance"
          loading={qbLoading}
          value={bal ? money(bal.qb_as_of, currency) : <span className="text-slate-300">—</span>}
          sub={bal
            ? (Math.abs(bal.qb_current - bal.qb_as_of) < 0.01
              ? 'à la date du relevé'
              : `à la date du relevé · aujourd'hui ${money(bal.qb_current, currency)}`)
            : (account.qb_account_id ? null : 'aucun compte QB mappé')} />
        <Figure label="Écart" testId="reconcile-difference"
          loading={qbLoading}
          tone={diff == null ? 'neutral' : Math.abs(diff) < 0.01 ? 'ok' : 'bad'}
          value={diff == null ? <span className="text-slate-300">—</span> : money(diff, currency)}
          sub={diff == null ? null : Math.abs(diff) < 0.01 ? 'relevé et QuickBooks concordent' : 'relevé moins QuickBooks'} />
        <Figure label="À rapprocher" testId="reconcile-pending"
          loading={!summary}
          value={summary?.totals ? `${summary.totals.pending_count}` : '—'}
          sub={summary?.totals ? `${summary.totals.reconciled_count} rapprochées · ${summary.totals.no_document_count} sans document` : null} />
        <div className="px-4 py-3 flex items-center gap-2 grow justify-end">
          <button type="button" data-testid="reconcile-auto-btn"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            title="Apparier les transactions aux documents de l'ERP puis aux écritures QuickBooks"
            disabled={busy} onClick={runAuto}>
            <Wand2 size={15} /> {busy ? 'Rapprochement…' : 'Rapprocher automatiquement'}
          </button>
          <button type="button" title="Recalculer la comparaison QuickBooks"
            className="inline-flex items-center justify-center p-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
            disabled={qbLoading || !account.qb_account_id} onClick={loadQb}>
            <RefreshCw size={15} className={qbLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {qbError && (
        <div className="border-t border-slate-100 px-4 py-2 text-sm text-amber-700 bg-amber-50">
          Comparaison QuickBooks indisponible : {qbError}
        </div>
      )}

      <GapSection id="missing-qb" icon={AlertTriangle} color="text-red-600" open={open === 'missing-qb'}
        onToggle={() => toggle('missing-qb')} count={missingQb.length}
        title={`transaction${missingQb.length > 1 ? 's' : ''} du relevé sans écriture dans QuickBooks`}>
        {missingQb.map((m) => (
          <button key={m.txn_id} type="button" onClick={() => onOpenTxn(m.txn_id)}
            className="w-full flex items-center gap-2 text-sm rounded-lg px-2 py-1 hover:bg-slate-50 text-left">
            <span className="text-slate-500 whitespace-nowrap w-20 shrink-0">{fmtDate(m.date)}</span>
            <span className="truncate grow text-slate-700">{m.label}</span>
            <span className={`tabular-nums whitespace-nowrap ${m.amount < 0 ? 'text-red-700' : 'text-green-700'}`}>{money(m.amount, currency)}</span>
          </button>
        ))}
      </GapSection>

      <GapSection id="missing-stmt" icon={AlertTriangle} color="text-orange-500" open={open === 'missing-stmt'}
        onToggle={() => toggle('missing-stmt')} count={missingStmt.length}
        title={`écriture${missingStmt.length > 1 ? 's' : ''} QuickBooks absente${missingStmt.length > 1 ? 's' : ''} du relevé`}>
        {missingStmt.map((m) => (
          <a key={`${m.entity}:${m.qb_id}`} href={m.url} target="_blank" rel="noreferrer"
            className="flex items-center gap-2 text-sm rounded-lg px-2 py-1 hover:bg-slate-50">
            <span className="text-slate-500 whitespace-nowrap w-20 shrink-0">{fmtDate(m.date)}</span>
            <span className="truncate grow text-slate-700">{m.entity} #{m.qb_id}</span>
            <span className={`tabular-nums whitespace-nowrap ${m.amount < 0 ? 'text-red-700' : 'text-green-700'}`}>{money(m.amount, currency)}</span>
            <ExternalLink size={12} className="text-slate-400 shrink-0" />
          </a>
        ))}
      </GapSection>

      <GapSection id="anomalies" icon={AlertTriangle} color="text-amber-500" open={open === 'anomalies'}
        onToggle={() => toggle('anomalies')} count={anomalies.length}
        title={`anomalie${anomalies.length > 1 ? 's' : ''} sur le relevé (solde qui ne suit pas, doublon)`}>
        {anomalies.map((a, i) => (
          <button key={`${a.kind}:${a.txn_id}:${i}`} type="button" onClick={() => onOpenTxn(a.txn_id)}
            className="w-full text-left rounded-lg px-2 py-1 hover:bg-slate-50">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-slate-500 whitespace-nowrap w-20 shrink-0">{fmtDate(a.date)}</span>
              <span className="truncate grow text-slate-700">{a.label}</span>
              <span className="tabular-nums whitespace-nowrap text-slate-600">{money(a.amount, currency)}</span>
            </div>
            <div className="text-xs text-slate-400 pl-[5.5rem]">{a.explanation}</div>
          </button>
        ))}
        {summary?.anomalies_older_count > 0 && (
          <div className="text-xs text-slate-400 px-2 pt-1">
            + {summary.anomalies_older_count} anomalie{summary.anomalies_older_count > 1 ? 's' : ''} antérieure{summary.anomalies_older_count > 1 ? 's' : ''} au {fmtDate(summary.anomalies_since)} (historique, non listées)
          </div>
        )}
      </GapSection>
    </div>
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

function TrxSheetBanner({ onSynced, onGoToAccount }) {
  const [status, setStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState(null)
  const [showAnomalies, setShowAnomalies] = useState(null)

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

  if (!status) return null
  const last = status.last_run
  const anomalies = last?.anomalies || []
  const toBook = last?.to_book || []
  const gaps = last?.gaps || []

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
      className={`mb-4 rounded-xl border px-4 py-3 ${anomalies.length ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <span className="inline-flex items-center gap-1.5 font-medium text-slate-800">
          <FileSpreadsheet size={15} className="text-green-700" /> Fichier TRX_Orisha (Drive)
        </span>
        {status.active
          ? <Badge color="green" size="xs">sync auto aux 20 min</Badge>
          : <Badge color="gray" size="xs">automation désactivée</Badge>}
        {last ? (
          <span className="text-slate-500">
            Dernier passage {fmtDateTime(last.executed_at)} —{' '}
            {last.status === 'success'
              ? <span>{last.summary}</span>
              : <span className="text-red-600">échec : {last.error}</span>}
          </span>
        ) : (
          <span className="text-slate-500">Jamais synchronisé — lancer une première sync.</span>
        )}
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
  const [statusFilter, setStatusFilter] = useState(null)

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
  useEffect(() => { setStatusFilter(null) }, [accountId])

  // Incrémenté à chaque refresh : le panneau de rapprochement recalcule son
  // résumé local (la comparaison QuickBooks, elle, reste à la demande).
  const [reconcileKey, setReconcileKey] = useState(0)
  // Transaction à ouvrir dans le side-peek, demandée depuis le panneau d'écarts.
  const [peekOpenId, setPeekOpenId] = useState(null)
  const refresh = useCallback(async () => {
    await Promise.all([loadTxns(), loadAccounts()])
    setReconcileKey((k) => k + 1)
  }, [loadTxns, loadAccounts])

  const statusCounts = useMemo(() => {
    const c = {}
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1
    return c
  }, [rows])

  const filteredRows = useMemo(
    () => statusFilter ? rows.filter((r) => r.status === statusFilter) : rows,
    [rows, statusFilter]
  )

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(null), 6000) }


  const COLUMNS = useMemo(() => {
    const RENDERS = {
      txn_date: (r) => <span className="text-slate-600 whitespace-nowrap">{fmtDate(r.txn_date)}</span>,
      // « Autres détails » du relevé en principal (c'est lui qui dit la nature
      // de la transaction), description de la banque en second.
      description: (r) => (
        <div className="min-w-0">
          <div className="truncate">{txnLabel(r)}</div>
          {txnSubLabel(r) && <div className="truncate text-xs text-slate-400">{txnSubLabel(r)}</div>}
        </div>
      ),
      amount: (r) => <span className={`font-medium whitespace-nowrap ${r.amount < 0 ? 'text-red-700' : 'text-green-700'}`}>{money(r.amount, account?.currency)}</span>,
      balance: (r) => money(r.balance, account?.currency),
      status: (r) => {
        const m = STATUS_META[r.status] || STATUS_META.a_traiter
        const sheet = SHEET_COLOR_META[r.sheet_color]
        const how = MATCH_METHOD[r.qb_match_method]
        return (
          <span className="inline-flex items-center gap-1.5">
            {sheet && <span className={`h-2 w-2 shrink-0 rounded-full ${sheet.dot}`} title={sheet.label} />}
            <Badge color={m.color}>{m.label}</Badge>
            {r.qb_url && (
              <a href={r.qb_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                title={how
                  ? `Ouvrir dans QuickBooks — retrouvée par ${how}${r.qb_match_rate ? ` ${r.qb_match_rate}` : ''}${r.qb_match_account ? ` (${r.qb_match_account})` : ''}${r.qb_match_delta ? `, écart de ${r.qb_match_delta.toFixed(2)} $` : ''}`
                  : 'Ouvrir dans QuickBooks'}
                className={`inline-flex items-center hover:text-brand-600 ${r.qb_match_delta ? 'text-amber-500' : 'text-slate-400'}`}>
                <ExternalLink size={13} />
              </a>
            )}
          </span>
        )
      },
      matched_label: (r) => r.matched_id ? docLink(r.matched_type, r.matched_id, r.matched_label) : <span className="text-slate-300">—</span>,
      match_confidence: (r) => r.match_confidence != null ? `${Math.round(r.match_confidence * 100)} %` : '—',
    }
    return TABLE_COLUMN_META.bank_transactions.map((meta) => ({ ...meta, render: RENDERS[meta.id] }))
  }, [account?.currency])

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold text-slate-900">Rapprochement bancaire</h1>
          <div className="flex items-center gap-2">
            {/* L'appariement (documents ERP + écritures QuickBooks) a migré dans
                le panneau de rapprochement, en un seul bouton. */}
            <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
              disabled={!accountId} onClick={() => setShowImport(true)}>
              <Upload size={15} /> Importer un relevé
            </button>
          </div>
        </div>

        <TrxSheetBanner onSynced={refresh} onGoToAccount={(id) => setAccountId(id)} />

        {/* Onglets par compte — les anciens onglets du xlsx */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {accounts.map((a) => (
            <button key={a.id}
              className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${a.id === accountId
                ? 'bg-brand-600 text-white border-brand-600'
                : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`}
              onClick={() => setAccountId(a.id)}>
              {a.name}
              {a.a_traiter_count > 0 && (
                <span className={`ml-1.5 text-xs rounded-full px-1.5 ${a.id === accountId ? 'bg-white/25' : 'bg-red-100 text-red-700'}`}>
                  {a.a_traiter_count}
                </span>
              )}
            </button>
          ))}
        </div>

        <ReconcilePanel account={account} refreshKey={reconcileKey} onChanged={refresh}
          onOpenTxn={(id) => { setStatusFilter(null); setPeekOpenId(id) }} />

        {account && (
          <div className="flex flex-wrap items-center gap-3 mb-4 text-sm text-slate-600">
            <span>{account.institution || ''} {account.account_number ? `· ${account.account_number}` : ''} · {account.currency}</span>
            {Object.entries(STATUS_META).map(([k, m]) => statusCounts[k] ? (
              <button key={k} type="button"
                title={statusFilter === k ? 'Retirer le filtre' : m.hint}
                className={`inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 -mx-0.5 transition-colors ${statusFilter === k
                  ? 'bg-slate-200 text-slate-900 ring-1 ring-slate-300'
                  : 'hover:bg-slate-100'}`}
                onClick={() => setStatusFilter((prev) => prev === k ? null : k)}>
                <Badge color={m.color} size="xs">{statusCounts[k]}</Badge> {m.label}
              </button>
            ) : null)}
            {statusFilter && (
              <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => setStatusFilter(null)}>
                Tout afficher
              </button>
            )}
            {account.last_txn_date && <span className="text-slate-400">Dernière trx : {fmtDate(account.last_txn_date)}</span>}
          </div>
        )}

        {notice && <div className="mb-3 text-sm bg-green-50 text-green-800 rounded-lg px-3 py-2">{notice}</div>}

        <DataTable
          table="bank_transactions"
          manageViews
          columns={COLUMNS}
          data={filteredRows}
          loading={loading}
          rowKey="id"
          searchFields={['details', 'description', 'reference', 'amount', 'comment', 'matched_label']}
          bulkActions={[
            {
              key: 'reconcile', label: 'Marquer rapproché', icon: CheckCheck, busyLabel: 'Rapprochement…',
              onClick: async (ids) => { await api.bank.reconcile(ids); await refresh() },
            },
            {
              key: 'automatch-hint', label: 'Ignorer', icon: Undo2, busyLabel: 'Mise à jour…',
              onClick: async (ids) => {
                for (const id of ids) await api.bank.updateTransaction(id, { status: 'ignore' })
                await refresh()
              },
            },
          ]}
          peek={{
            title: (r) => txnLabel(r),
            subtitle: (r) => fmtDate(r.txn_date),
            width: 420,
            openId: peekOpenId,
            onOpenConsumed: () => setPeekOpenId(null),
            render: (r) => <TxnPeek txn={r} currency={account?.currency} onChanged={refresh} />,
          }}
          emptyState={{ title: 'Aucune transaction', description: 'Importer un relevé pour commencer le rapprochement.' }}
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
