// Douanes — relevé de transactions CARM (GCRA) de l'ASFC.
// Le relevé est téléchargé à la main du portail (GCKey — pas d'API publique),
// puis collé/déposé ici. Tout le reste est automatique : nature de chaque ligne,
// ventilation droits / TPS, détection des lignes réglées par un courtier (leur
// dépense arrive par SA facture), lettrage des versements aux charges, puis
// proposition d'écritures QuickBooks — le bouton « Comptabiliser » les pousse.
// Le compte ASFC est le solde du fournisseur ASFC dans les Comptes fournisseurs.
//
// Le compte CARM est un compte prépayé comme un autre (on avance des fonds à
// l'ASFC, les déclarations les consomment) : ce module n'est plus une page à
// lui seul, il s'affiche comme onglet « Douanes (ASFC) » de la page Comptes
// prépayés. L'URL /douanes redirige vers cet onglet.
import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Ship, Upload, ExternalLink, Link2, Unlink, Trash2, Search, FileText, BookCheck, RotateCcw } from 'lucide-react'
import api from '../lib/api.js'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'

const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'

import { fmtMoney } from '../utils/formatters.js'
import Spinner from '../components/Spinner.jsx'

const COLUMN_LABELS = {
  date: 'Date', due_date: 'Échéance', type: 'Type', number: 'Numéro',
  description: 'Description', amount: 'Montant', balance: 'Solde',
  debit: 'Débit', credit: 'Crédit',
}

// Modale d'import : le relevé (collé, CSV, TSV ou Excel) est d'abord analysé
// côté serveur — l'aperçu montre les colonnes reconnues, les réparations faites
// et les lignes problématiques avant d'écrire quoi que ce soit.
function ImportModal({ onClose, onImported }) {
  const [text, setText] = useState('')
  const [file, setFile] = useState(null) // { name, base64 } — fichier binaire (Excel) ou CSV brut
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef(null)
  const { addToast } = useToast()
  const lineCount = text.split('\n').filter(l => l.trim()).length

  const payload = file ? { file_base64: file.base64, filename: file.name } : { text }

  function readFile(f) {
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      const b64 = String(reader.result || '').split(',')[1] || ''
      setFile({ name: f.name, base64: b64 })
      setText('')
    }
    reader.readAsDataURL(f) // le serveur décide de l'encodage (UTF-16, latin-1, Excel)
  }

  // Aperçu automatique dès que la source change (debounce court pour le collage).
  useEffect(() => {
    if (!file && !text.trim()) { setPreview(null); return }
    let alive = true
    setPreviewing(true)
    const t = setTimeout(async () => {
      try {
        const r = await api.carm.importPreview(payload)
        if (alive) setPreview(r)
      } catch (e) {
        if (alive) setPreview({ error: e.message, parsed: 0, to_create: 0, errors: [] })
      } finally {
        if (alive) setPreviewing(false)
      }
    }, file ? 0 : 400)
    return () => { alive = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, file])

  async function doImport() {
    setSaving(true)
    try {
      const r = await api.carm.import(payload)
      const bits = [`${r.created} transaction(s) importée(s)`]
      if (r.skipped) bits.push(`${r.skipped} déjà connue(s)`)
      if (r.matched) bits.push(`${r.matched} appariée(s) à un reçu`)
      if (r.errors?.length) bits.push(`${r.errors.length} ligne(s) ignorée(s)`)
      addToast({ message: bits.join(' · '), type: r.created ? 'success' : 'error' })
      onImported()
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const canImport = !!preview?.to_create && !preview?.error

  return (
    <Modal isOpen onClose={onClose} title="Importer un relevé CARM" size="lg">
      <p className="text-xs text-slate-500 mb-2">
        Colle les lignes du relevé de transactions du portail CARM de l'ASFC, ou glisse-dépose le
        fichier téléchargé (CSV, TSV ou Excel) ci-dessous. En-têtes anglaises ou françaises, colonnes
        débit/crédit et relevés sans en-têtes sont reconnus ; l'import est idempotent —
        ré-importer le même relevé ne crée aucun doublon.
      </p>
      <div data-testid="douanes-import-dropzone"
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault(); setDragOver(false)
          readFile(e.dataTransfer.files?.[0])
        }}
        className={`rounded-lg transition-colors ${dragOver ? 'ring-2 ring-brand-400 bg-brand-50/40' : ''}`}
      >
        {file ? (
          <div className="flex items-center justify-between px-3 py-2 border border-slate-200 rounded-lg text-sm">
            <span className="flex items-center gap-2 text-slate-700"><FileText size={14} /> {file.name}</span>
            <button onClick={() => { setFile(null); setPreview(null) }} className="text-xs text-slate-500 hover:text-slate-700">Retirer</button>
          </div>
        ) : (
          <textarea data-testid="douanes-import-text" className={`${inputCls} font-mono`} rows={9}
            value={text} onChange={e => setText(e.target.value)}
            placeholder={dragOver ? 'Dépose le fichier ici…' : undefined}
            autoFocus />
        )}
        <div className="flex items-center justify-between mt-2 text-xs">
          <button onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 px-2 py-1 text-slate-600 border border-slate-200 hover:bg-slate-50 rounded-lg">
            <FileText size={13} /> Choisir un fichier…
          </button>
          <input ref={fileRef} type="file" accept=".csv,.txt,.tsv,.xls,.xlsx" className="hidden"
            onChange={e => { readFile(e.target.files?.[0]); e.target.value = '' }} />
          <span className="text-slate-500">{file ? 'fichier déposé' : `${lineCount} ligne(s) collée(s)`}</span>
        </div>
      </div>

      {previewing && <div className="mt-3 text-xs text-slate-500">Analyse du relevé…</div>}
      {!previewing && preview && (
        <div data-testid="douanes-import-preview" className="mt-3 border border-slate-200 rounded-lg p-3 text-xs space-y-2">
          {preview.error ? (
            <div className="text-red-600">{preview.error}</div>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-700">
                <span><b>{preview.to_create}</b> à importer</span>
                {!!preview.already_known && <span className="text-slate-500">{preview.already_known} déjà connue(s)</span>}
                {!!preview.errors?.length && <span className="text-amber-700">{preview.errors.length} ligne(s) ignorée(s)</span>}
                {!preview.header_found && <span className="text-slate-500">aucune en-tête reconnue — colonnes devinées par le contenu</span>}
              </div>
              {!!Object.keys(preview.columns || {}).length && (
                <div className="text-slate-500">
                  Colonnes : {Object.entries(preview.columns).map(([k, v]) => `${COLUMN_LABELS[k] || k} → « ${v} »`).join(' · ')}
                </div>
              )}
              {preview.notes?.map((n, i) => <div key={i} className="text-slate-500">↳ {n}</div>)}
              {!!preview.sample?.length && (
                <div className="max-h-40 overflow-auto border-t border-slate-100 pt-2">
                  <table className="w-full">
                    <tbody>
                      {preview.sample.map((r, i) => (
                        <tr key={i} className={r.already_known ? 'text-slate-400' : 'text-slate-700'}>
                          <td className="py-0.5 pr-2 whitespace-nowrap">{r.transaction_date}</td>
                          <td className="py-0.5 pr-2 truncate max-w-[10rem]">{r.transaction_type || '—'}</td>
                          <td className="py-0.5 pr-2 truncate max-w-[10rem]">{r.transaction_number || '—'}</td>
                          <td className="py-0.5 text-right tabular-nums">{fmtMoney(r.amount)}</td>
                          <td className="py-0.5 pl-2 text-slate-400">{r.already_known ? 'déjà connue' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!!preview.errors?.length && (
                <details className="text-amber-700">
                  <summary className="cursor-pointer">Lignes ignorées ({preview.errors.length})</summary>
                  <ul className="mt-1 space-y-0.5 max-h-32 overflow-auto font-mono text-[11px]">
                    {preview.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </details>
              )}
              {!preview.parsed && (
                <div className="text-red-600">
                  Aucune transaction lisible. Vérifie que le fichier contient bien l'historique des
                  transactions (une ligne par transaction, avec date et montant) et non un résumé de compte.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Bouton requis : action transactionnelle d'import en lot */}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
        <button data-testid="douanes-import-submit" onClick={doImport} disabled={saving || previewing || !canImport}
          className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
          {saving ? 'Import…' : preview?.to_create ? `Importer ${preview.to_create} ligne(s)` : 'Importer'}
        </button>
      </div>
    </Modal>
  )
}

// Picker de reçu pour le lien manuel — recherche incluse (règle dropdowns >10 options).
function LinkModal({ txn, receipts, onClose, onLinked }) {
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const candidates = receipts.filter(r => !r.linked)
  const q = query.toLowerCase()
  const shown = candidates.filter(r =>
    !q || `${r.company} ${r.original_name} ${r.total} ${r.receipt_date}`.toLowerCase().includes(q))

  async function link(receiptId) {
    setSaving(true)
    try {
      await api.carm.link(txn.id, receiptId)
      onLinked()
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
      setSaving(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={`Lier un reçu — ${fmtDate(txn.transaction_date)} · ${fmtMoney(Math.abs(txn.amount))}`} size="md">
      <div className="relative mb-2">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input className={`${inputCls} pl-8`} value={query}
          onChange={e => setQuery(e.target.value)} autoFocus />
      </div>
      <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 border border-slate-100 rounded-lg">
        {shown.length === 0 && (
          <div className="p-4 text-sm text-slate-400 text-center">
            Aucun reçu ASFC disponible — les factures du portail passent d'abord par l'extracteur de données.
          </div>
        )}
        {shown.map(r => (
          <button key={r.id} onClick={() => link(r.id)} disabled={saving}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left hover:bg-slate-50 disabled:opacity-50">
            <span className="min-w-0">
              <span className="text-slate-800">{fmtDate(r.receipt_date)} · {fmtMoney(r.total, r.currency)}</span>
              <span className="block text-xs text-slate-400 truncate">{r.original_name || r.company}</span>
            </span>
            {r.quickbooks_id ? <Badge color="green">Dans QB</Badge> : <Badge color="amber">À pousser</Badge>}
          </button>
        ))}
      </div>
    </Modal>
  )
}

// Nature comptable d'une ligne. Elle décide de l'écriture : une évaluation se
// ventile en droits (dépense) + TPS à l'importation (CTI récupérable), un
// paiement ne touche que le bilan, des intérêts sont une charge financière.
const CATEGORIES = [
  ['evaluation', 'Évaluation (B3)', 'blue'],
  ['correction', 'Correction', 'blue'],
  ['interet', 'Intérêts', 'amber'],
  ['penalite', 'Pénalité', 'red'],
  ['paiement', 'Paiement', 'green'],
  ['autre', 'Autre', 'gray'],
]

// Champ montant à autosave (blur), utilisé pour la ventilation droits / TPS.
function AmountCell({ value, onSave, title }) {
  const [v, setV] = useState(value == null ? '' : String(value))
  useEffect(() => { setV(value == null ? '' : String(value)) }, [value])
  return (
    <input type="text" inputMode="decimal" value={v} title={title}
      onChange={e => setV(e.target.value)}
      onBlur={() => {
        const raw = v.trim().replace(',', '.')
        const next = raw === '' ? null : Number(raw)
        if (raw !== '' && !Number.isFinite(next)) { setV(value == null ? '' : String(value)); return }
        if ((value ?? null) !== next) onSave(next)
      }}
      className="w-20 px-1.5 py-0.5 text-xs text-right tabular-nums border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/30" />
  )
}

// Une seule ligne de chiffres, scannable : ce qui est dû/disponible, ce qui
// attend une écriture, ce qui passe par un courtier. Les réglages du compte
// (solde d'ouverture, seuil) sont derrière un dépli — on les touche deux fois par an.
function StatBar({ state, statementBalance, config, onSaved }) {
  const [open, setOpen] = useState(false)
  const { addToast } = useToast()

  async function save(patch) {
    try { onSaved(await api.carm.saveConfig(patch)) }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  const alert = state?.negative ? 'text-red-700' : state?.low ? 'text-amber-700' : 'text-slate-800'
  const bits = [
    state?.unpaid ? `${fmtMoney(state.unpaid)} dû` : null,
    state?.to_post ? `${state.to_post} à comptabiliser` : null,
    state?.awaiting ? `${state.awaiting} en attente` : null,
    state?.via_broker ? `${state.via_broker} via courtier` : null,
    statementBalance != null ? `relevé ${fmtMoney(statementBalance)}` : null,
  ].filter(Boolean)

  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className={`text-lg font-semibold tabular-nums ${alert}`}>{fmtMoney(state?.credit_available)}</span>
        <span className="text-xs text-slate-400">de crédit au portail</span>
        {bits.length > 0 && <span className="text-xs text-slate-400">· {bits.join(' · ')}</span>}
        <button onClick={() => setOpen(o => !o)} data-testid="douanes-settings-toggle"
          className="text-xs text-slate-400 hover:text-brand-600 underline decoration-dotted">
          {open ? 'masquer' : 'réglages'}
        </button>
      </div>
      {open && (
        <div className="mt-2 flex items-end gap-3 text-xs">
          <label className="block">
            <span className="text-slate-400">Solde d'ouverture</span>
            <AmountCell value={config?.opening_balance === '' ? null : Number(config?.opening_balance)}
              title="Solde du compte au portail à la date d'ouverture"
              onSave={v => save({ opening_balance: v ?? 0 })} />
          </label>
          <label className="block">
            <span className="text-slate-400">à partir du</span>
            <input type="date" value={config?.opening_date || ''}
              onChange={e => save({ opening_date: e.target.value })}
              className="block w-full px-1.5 py-0.5 text-xs border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/30" />
          </label>
          <label className="block">
            <span className="text-slate-400">Seuil d'alerte</span>
            <AmountCell value={config?.threshold === '' ? null : Number(config?.threshold)}
              title="Alerte Slack quand le solde passe sous ce montant"
              onSave={v => save({ threshold: v ?? 0 })} />
          </label>
        </div>
      )}
    </div>
  )
}

// Seules les charges de déclaration se ventilent en droits + TPS.
const splittable = t => t.category === 'evaluation' || t.category === 'correction'


// État de comptabilisation d'une ligne, tel que le moteur l'a décidé.
const POSTING_BADGES = {
  comptabilise: { label: 'Comptabilisé', color: 'green' },
  a_comptabiliser: { label: 'À comptabiliser', color: 'amber' },
  attente_imputation: { label: 'En attente de règlement', color: 'gray' },
  non_comptabilise: { label: 'Non comptabilisé', color: 'gray' },
  a_verifier: { label: 'À vérifier', color: 'red' },
  erreur: { label: 'Erreur', color: 'red' },
}

function postingBadge(t) {
  const base = POSTING_BADGES[t.posting_state] || { label: '—', color: 'gray' }
  const reason = String(t.skip_reason || '')
  if (reason.startsWith('via_courtier')) {
    const broker = reason.split(':')[1] || 'courtier'
    return { label: `via ${broker}`, color: 'gray',
      title: 'Le courtier a payé l\'ASFC : la dépense et la TPS arrivent par sa facture — rien à comptabiliser ici.' }
  }
  if (reason === 'garantie') return { label: 'Garantie', color: 'gray', title: 'Dépôt de garantie permanent, déjà comptabilisé.' }
  if (reason === 'hors_periode') return { label: 'Hors période', color: 'gray', title: 'Antérieure à la date d\'ouverture du compte.' }
  if (reason.startsWith('manuel:')) return { label: 'Ignorée', color: 'gray', title: reason.slice(7) }
  if (t.posting_state === 'attente_imputation') {
    return { ...base, title: 'Charge pas encore réglée : on attend de savoir si c\'est nous ou le courtier qui paie.' }
  }
  if (t.posting_error) return { ...base, title: t.posting_error }
  return base
}

// Ce que le moteur s'apprête à écrire — contrôlé avant d'engager les livres.
// Bouton de confirmation assumé (action transactionnelle en lot, pas un champ) :
// l'autosave ne s'applique pas à une écriture comptable.
function PostingModal({ onClose, onPosted }) {
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null) // Set d'ids, null = tout ce qui est prêt
  const [posting, setPosting] = useState(false)
  const { addToast } = useToast()

  useEffect(() => {
    api.carm.postingsPreview().then(setPreview).catch(e => setError(e.message))
  }, [])

  const groups = preview?.groups || []
  const ready = groups.filter(g => !g.blockers.length)
  const chosen = selected ?? new Set(ready.map(g => g.id))
  const toggle = id => {
    const next = new Set(chosen)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelected(next)
  }

  const ENTITY_LABELS = { purchase: 'Dépense', bill: 'Facture fournisseur', vendorcredit: 'Note de crédit' }

  async function submit() {
    setPosting(true)
    try {
      const r = await api.carm.postPostings([...chosen])
      addToast({
        message: r.failed
          ? `${r.posted} écriture(s) créée(s), ${r.failed} en erreur`
          : `${r.posted} écriture(s) créée(s) dans QuickBooks`,
        type: r.failed ? 'error' : 'success',
      })
      onPosted()
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally { setPosting(false) }
  }

  return (
    <Modal isOpen onClose={onClose} title="Comptabiliser le relevé ASFC" size="lg">
      <div className="space-y-3">
        {error && <div className="text-sm text-red-600">{error}</div>}
        {preview?.config_error && (
          <div className="px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">{preview.config_error}</div>
        )}
        {!preview && !error && <div className="text-sm text-slate-400">Préparation des écritures…</div>}
        {preview && !groups.length && (
          <div className="text-sm text-slate-500">Rien à comptabiliser.</div>
        )}
        {groups.map(g => {
          const blocked = g.blockers.length > 0
          return (
            <label key={g.id} data-testid="douanes-posting-group"
              className={`flex gap-3 p-3 border rounded-xl text-sm ${blocked ? 'bg-red-50/50 border-red-200' : 'bg-white border-slate-200 hover:border-brand-300 cursor-pointer'}`}>
              <input type="checkbox" disabled={blocked} checked={!blocked && chosen.has(g.id)}
                onChange={() => toggle(g.id)} className="mt-1" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-slate-800">
                    {ENTITY_LABELS[g.entity] || g.type} · {fmtDate(g.date)}
                    {g.number && <span className="ml-1.5 font-mono text-xs text-slate-400">{g.number}</span>}
                    {!g.number && g.declarations > 1 && (
                      <span className="ml-1.5 text-xs text-slate-400">({g.declarations} déclarations)</span>
                    )}
                  </span>
                  <span className="tabular-nums font-medium">{fmtMoney(g.total)}</span>
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {g.type === 'paiement'
                    ? g.account_source || 'carte configurée'
                    : [g.duty > 0 && `droits ${fmtMoney(g.duty)}`, g.gst > 0 && `TPS ${fmtMoney(g.gst)}`,
                      g.interest > 0 && `intérêts ${fmtMoney(g.interest)}`, g.penalty > 0 && `pénalité ${fmtMoney(g.penalty)}`]
                      .filter(Boolean).join(' · ')}
                </div>
                {blocked && <div className="text-xs text-red-700 mt-1">{g.blockers.join(' · ')}</div>}
              </div>
            </label>
          )
        })}
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
          <span className="text-xs text-slate-400">
            {preview ? `${ready.length} prête(s)${preview.blocked ? ` · ${preview.blocked} à ventiler` : ''}` : ''}
          </span>
          <span className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
            <button data-testid="douanes-post-submit" onClick={submit} disabled={posting || !chosen.size}
              className="px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-40 rounded-lg">
              {posting ? 'Comptabilisation…' : `Comptabiliser ${chosen.size} écriture(s)`}
            </button>
          </span>
        </div>
      </div>
    </Modal>
  )
}

export default function DouanesCarmPanel() {
  const [data, setData] = useState(null)
  const [importing, setImporting] = useState(false)
  const [posting, setPosting] = useState(false)
  const [linking, setLinking] = useState(null)
  const { addToast } = useToast()

  const load = useCallback(async () => {
    try { setData(await api.carm.list()) }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
  }, [addToast])

  useEffect(() => { load() }, [load])

  async function unlink(t) {
    try { await api.carm.unlink(t.id); load() }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  // Autosave d'une ligne (nature, ventilation) — mise à jour optimiste puis
  // rechargement pour rafraîchir le sommaire (TPS récupérable, lignes à ventiler).
  async function patch(t, fields) {
    setData(d => ({ ...d, transactions: d.transactions.map(x => x.id === t.id ? { ...x, ...fields } : x) }))
    try { await api.carm.update(t.id, fields); load() }
    catch (e) { addToast({ message: e.message, type: 'error' }); load() }
  }

  async function unskip(t) {
    try { await api.carm.unskip(t.id); load() }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  async function remove(t) {
    if (!confirm(`Supprimer la transaction du ${fmtDate(t.transaction_date)} (${fmtMoney(t.amount)}) ?`)) return
    try { await api.carm.delete(t.id); load() }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  const transactions = data?.transactions || []
  const receipts = data?.receipts || []
  const allocations = data?.allocations || []

  // Lettrage lisible : ce qu'un versement règle, ce qu'il reste en crédit — et
  // pour une charge, ce qui l'a éteinte. C'est ce qui explique qu'un versement
  // de 500 $ corresponde à deux transactions au relevé.
  function allocationOf(t) {
    const isPayment = Number(t.amount) < 0
    const mine = allocations.filter(a => (isPayment ? a.payment_txn_id : a.charge_txn_id) === t.id)
    if (!mine.length) return null
    const used = Math.round(mine.reduce((s, a) => s + a.amount, 0) * 100) / 100
    const total = Math.abs(Number(t.amount) || 0)
    const rest = Math.round((total - used) * 100) / 100
    if (isPayment) {
      return rest > 0.004
        ? `règle ${fmtMoney(used)} · ${fmtMoney(rest)} en crédit`
        : `règle ${mine.length} charge(s)`
    }
    return rest > 0.004 ? `réglée à ${fmtMoney(used)}` : 'réglée'
  }

  const state = data?.state

  return (
    <div data-testid="douanes-panel">
      <div className="flex items-center justify-between gap-4 mb-3">
        <StatBar state={state} statementBalance={data?.summary?.balance} config={data?.config}
          onSaved={r => setData(d => ({ ...d, ...r }))} />
        <span className="flex shrink-0 items-center gap-2">
          <button data-testid="douanes-import-open" onClick={() => setImporting(true)}
            title="Importer un relevé du portail CARM"
            className="flex items-center gap-1.5 px-2.5 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">
            <Upload size={15} /> Importer
          </button>
          {/* Écriture comptable = action transactionnelle : elle se confirme,
              contrairement aux champs de la page qui s'autosauvegardent. */}
          <button data-testid="douanes-post-open" onClick={() => setPosting(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg">
            <BookCheck size={15} /> Comptabiliser{state?.to_post ? ` (${state.to_post})` : ''}
          </button>
        </span>
      </div>

      {/* Relevé */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table data-testid="douanes-table" className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-400 border-b border-slate-100">
              <th className="text-left font-medium px-4 py-2">Date</th>
              <th className="text-left font-medium px-2 py-2">Ligne</th>
              <th className="text-right font-medium px-2 py-2">Montant</th>
              <th className="text-right font-medium px-2 py-2" title="Droits de douane — coût, non récupérable">Droits</th>
              <th className="text-right font-medium px-2 py-2" title="TPS à l'importation — 100 % récupérable en CTI">TPS</th>
              <th className="text-left font-medium px-2 py-2">État</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {data === null && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-400"><Spinner size="xs" label="Chargement…" /></td></tr>
            )}
            {data !== null && transactions.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                <Ship className="mx-auto mb-2 text-slate-300" size={26} />
                Aucune transaction — importer le relevé téléchargé du portail CARM.
              </td></tr>
            )}
            {transactions.map(t => (
                <tr key={t.id} className="border-b border-slate-50 group">
                  <td className="px-4 py-2 whitespace-nowrap">{fmtDate(t.transaction_date)}</td>
                  {/* Type, nature (corrigeable) et numéro tiennent dans une
                      seule colonne : la nature est posée automatiquement, on ne
                      lui donne pas une colonne à elle. */}
                  <td className="px-2 py-2">
                    <select value={t.category || 'autre'} onChange={e => patch(t, { category: e.target.value })}
                      title="Nature de la ligne (posée automatiquement)"
                      className="text-slate-700 bg-transparent border border-transparent hover:border-slate-200 rounded-md px-1 py-0.5 focus:outline-none focus:ring-2 focus:ring-brand-500/30">
                      {CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                    <span className="block px-1 text-xs text-slate-400 font-mono truncate max-w-56">{t.transaction_number || ''}</span>
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums ${t.amount < 0 ? 'text-emerald-700' : ''}`}>{fmtMoney(t.amount, t.currency)}</td>
                  {/* Ventilation : seules les évaluations et corrections portent
                      des droits et de la TPS — un paiement ne touche que le bilan. */}
                  <td className="px-2 py-2 text-right">
                    {splittable(t)
                      ? <AmountCell value={t.duty_amount} title="Droits de douane (dépense, non récupérable)"
                        onSave={v => patch(t, { duty_amount: v })} />
                      : null}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {splittable(t) ? (
                      <span className="inline-flex items-center gap-1">
                        <AmountCell value={t.gst_amount} title="TPS à l'importation (CTI récupérable)"
                          onSave={v => patch(t, { gst_amount: v })} />
                        {t.duty_amount == null && t.gst_amount == null && (
                          <button onClick={() => patch(t, { duty_amount: 0, gst_amount: t.amount })}
                            title="Tout en TPS (marchandise sans droits, ex. origine ACEUM)"
                            className="text-[10px] px-1 py-0.5 text-slate-400 hover:text-brand-600 hover:bg-slate-50 rounded">
                            100 %
                          </button>
                        )}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-2" data-testid="douanes-posting-cell">
                    {(() => {
                      const pb = postingBadge(t)
                      const badge = <Badge color={pb.color}>{pb.label}</Badge>
                      return (
                        <span className="inline-flex items-center gap-1.5" title={pb.title || undefined}>
                          {t.qb_url
                            ? <a href={t.qb_url} target="_blank" rel="noreferrer" title="Ouvrir dans QuickBooks">
                              <Badge color={pb.color}>{pb.label} <ExternalLink size={11} className="inline -mt-0.5 ml-0.5 opacity-60" /></Badge>
                            </a>
                            : badge}
                          {(t.posting_state === 'erreur' || String(t.skip_reason || '').startsWith('manuel:')) && (
                            <button onClick={() => unskip(t)} title="Remettre dans le circuit automatique"
                              className="p-0.5 text-slate-300 hover:text-brand-600 rounded">
                              <RotateCcw size={12} />
                            </button>
                          )}
                          {allocationOf(t) && <span className="text-xs text-slate-400">{allocationOf(t)}</span>}
                          {t.sale_receipt_id && (
                            <Link to={`/sale-receipts/${t.sale_receipt_id}`} title={t.receipt_filename || 'Ouvrir le reçu'}
                              className="text-xs text-brand-600 hover:underline whitespace-nowrap">reçu</Link>
                          )}
                        </span>
                      )
                    })()}
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                      {t.sale_receipt_id ? (
                        <button onClick={() => unlink(t)} title="Délier le reçu"
                          className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-md">
                          <Unlink size={14} />
                        </button>
                      ) : (
                        <button onClick={() => setLinking(t)} title="Lier un reçu"
                          className="p-1 text-slate-400 hover:text-brand-600 hover:bg-slate-50 rounded-md">
                          <Link2 size={14} />
                        </button>
                      )}
                      <button onClick={() => remove(t)} title="Supprimer la transaction"
                        className="p-1 ml-1 text-slate-400 hover:text-red-600 hover:bg-slate-50 rounded-md">
                        <Trash2 size={14} />
                      </button>
                    </span>
                  </td>
                </tr>
            ))}
          </tbody>
        </table>
      </div>

      {importing && <ImportModal onClose={() => setImporting(false)} onImported={load} />}
      {posting && <PostingModal onClose={() => setPosting(false)} onPosted={load} />}
      {linking && <LinkModal txn={linking} receipts={receipts} onClose={() => setLinking(null)} onLinked={load} />}
    </div>
  )
}
