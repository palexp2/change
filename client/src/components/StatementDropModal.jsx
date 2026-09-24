// Dépôt de relevés : on jette les fichiers de la banque (PDF, export, capture
// d'écran), l'ERP dit ce qu'il a lu et de quel compte il pense qu'il s'agit,
// on corrige si besoin, et un seul bouton écrit.
//
// Deux choses portent toute la confiance de l'écran et ne doivent jamais être
// enterrées : le COMPTE (modifiable, avec la preuve du choix) et l'ÉQUILIBRE
// (ouverture + mouvements = fermeture). Un écart non nul veut dire que la
// lecture a sauté ou inventé une ligne — on l'affiche en rouge et on laisse
// importer quand même : c'est l'humain qui tranche.
import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { UploadCloud, Trash2, RefreshCw, ChevronRight } from 'lucide-react'
import api from '../lib/api.js'
import { Modal } from './Modal.jsx'
import { Badge } from './Badge.jsx'
import Spinner from './Spinner.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import { fmtMoney } from '../utils/formatters.js'
import { fmtDate } from '../lib/formatDate.js'

const SOURCE_LABEL = {
  tableur: 'Tableur', pdf_texte: 'PDF', pdf_image: 'PDF scanné', image: 'Capture',
}

// Le contrôle d'équilibre est ce qui distingue une lecture fiable d'une lecture
// inventée : il ne se cache jamais derrière un dépliant.
function BalanceBadge({ up }) {
  if (up.balance_ok == null) return <Badge color="gray">Équilibre non vérifiable</Badge>
  if (up.balance_ok) return <Badge color="green">{up.balance_method === 'chaine' ? 'Soldes enchaînés' : 'Équilibré'}</Badge>
  if (up.balance_method === 'chaine') return <Badge color="red">Soldes qui ne s'enchaînent pas</Badge>
  return <Badge color="red">Écart {fmtMoney(up.balance_check)}</Badge>
}

function UploadCard({ up, accounts, onChange, onRemove, onReanalyze, onToExtractor, expanded, onToggle }) {
  const rows = up.rows_json || []
  const fresh = rows.filter((r) => r._new)
  const busy = up.status === 'en_analyse'
  const isInvoice = up.document_kind === 'facture'

  return (
    <div className="border border-slate-200 rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium truncate flex-1" title={up.original_name}>{up.original_name}</span>
        {up.source && <Badge color="slate">{SOURCE_LABEL[up.source] || up.source}</Badge>}
        <button className="p-1 text-slate-400 hover:text-slate-700" title="Relire" onClick={() => onReanalyze(up.id)}>
          <RefreshCw size={14} />
        </button>
        <button className="p-1 text-slate-400 hover:text-red-600" title="Retirer" onClick={() => onRemove(up.id)}>
          <Trash2 size={14} />
        </button>
      </div>

      {busy && <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner size="sm" /> Lecture…</div>}
      {up.status === 'erreur' && <div className="text-sm text-red-600">{up.error}</div>}

      {/* Ce n'était pas un relevé : le document est parti à l'extraction de
          données, il n'y a rien à importer au compte. */}
      {isInvoice && (
        <div className="flex items-center gap-2 text-sm">
          <Badge color="blue">Facture</Badge>
          {up.sale_receipt_id ? (
            <Link to={`/sale-receipts/${up.sale_receipt_id}`} className="link-record" data-testid="statement-to-receipt-link">
              Ouvrir dans l'extraction de données
            </Link>
          ) : (
            <span className="text-slate-500">{up.error || 'Envoyée à l’extraction de données'}</span>
          )}
        </div>
      )}

      {!isInvoice && up.status !== 'en_analyse' && up.status !== 'erreur' && (
        <>
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <SearchableSelect
                value={up.account_id || ''}
                options={accounts.map((a) => ({ value: a.id, label: a.name }))}
                onChange={(v) => onChange(api.bank.statements.setAccount(up.id, v || null))}
                placeholder="Choisir le compte"
                testId="statement-account"
              />
            </div>
            {!up.account_id && <Badge color="red">Compte à choisir</Badge>}
            {up.account_id && up.detect_confidence < 0.6 && <Badge color="yellow">À confirmer</Badge>}
            <BalanceBadge up={up} />
          </div>

          {up.detect_evidence?.length > 0 && (
            <div className="text-xs text-slate-500">
              {up.detect_evidence.map((e) => `${e.label} : ${e.detail}`).join(' · ')}
            </div>
          )}
          {up.error && <div className="text-xs text-amber-700">{up.error}</div>}

          <button type="button" className="text-xs text-slate-400 hover:text-brand-600 underline"
            data-testid="statement-to-receipt" onClick={() => onToExtractor(up.id)}>
            c'est une facture
          </button>

          <button className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900" onClick={onToggle}>
            <ChevronRight size={14} className={expanded ? 'rotate-90 transition-transform' : 'transition-transform'} />
            {fresh.length} neuve{fresh.length > 1 ? 's' : ''} · {rows.length - fresh.length} déjà en base
            {up.period_start && <span className="text-slate-400"> · {fmtDate(up.period_start)} → {fmtDate(up.period_end)}</span>}
          </button>

          {expanded && (
            <div className="max-h-56 overflow-auto border-t border-slate-100 pt-1">
              <table className="w-full text-xs">
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className={`border-t border-slate-100 ${r._new ? '' : 'text-slate-400'}`}>
                      <td className="py-0.5 pr-2 whitespace-nowrap">{fmtDate(r.txn_date)}</td>
                      <td className="pr-2 truncate max-w-[20rem]">{r.description || r.details}</td>
                      <td className={`text-right whitespace-nowrap ${!r._new ? '' : r.amount < 0 ? 'text-red-700' : 'text-green-700'}`}>
                        {fmtMoney(r.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function StatementDropModal({ accounts, onClose, onDone, initialFiles = null }) {
  const [uploads, setUploads] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState({})
  const [dragging, setDragging] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const fileRef = useRef(null)
  const dragDepth = useRef(0)
  const seeded = useRef(false)

  const pending = uploads.some((u) => u.status === 'en_analyse')

  const refresh = useCallback(async (ids) => {
    const list = await Promise.all(ids.map((id) => api.bank.statements.get(id).catch(() => null)))
    setUploads(list.filter(Boolean))
  }, [])

  // Fichiers glissés sur la page avant même que la fenêtre existe : elle
  // s'ouvre avec eux déjà en route.
  useEffect(() => {
    if (seeded.current || !initialFiles?.length) return
    seeded.current = true
    addFiles(initialFiles)
  }, [initialFiles])

  // Ctrl+V : une capture d'écran vit dans le presse-papiers, pas sur le disque.
  // L'obliger à passer par un fichier enregistré serait deux gestes de trop.
  useEffect(() => {
    const onPaste = (e) => {
      const files = [...(e.clipboardData?.items || [])]
        .filter((it) => it.kind === 'file')
        .map((it) => it.getAsFile())
        .filter(Boolean)
        // Une capture collée n'a pas de nom : on lui en donne un daté, qui sert
        // aussi de repère d'année à la lecture.
        .map((f) => (f.name && f.name !== 'image.png' ? f
          : new File([f], `capture-${new Date().toISOString().slice(0, 10)}.png`, { type: f.type })))
      if (files.length) { e.preventDefault(); addFiles(files) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  })

  // Tant qu'un fichier est en lecture, on redemande : l'analyse tourne côté
  // serveur, hors de la requête d'upload.
  useEffect(() => {
    if (!pending) return undefined
    const t = setInterval(() => refresh(uploads.map((u) => u.id)), 2000)
    return () => clearInterval(t)
  }, [pending, uploads, refresh])

  const addFiles = async (files) => {
    if (!files?.length) return
    setBusy(true); setError(null)
    try {
      const fd = new FormData()
      for (const f of files) fd.append('file', f)
      const res = await api.bank.statements.upload(fd)
      setUploads((prev) => [...prev, ...res.uploads])
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const addPastedText = async () => {
    const text = pasteText.trim()
    if (!text) return
    const name = `lignes-collees-${new Date().toISOString().slice(0, 10)}.csv`
    await addFiles([new File([text], name, { type: 'text/csv' })])
    setPasteText('')
    setPasteOpen(false)
  }

  const applyChange = async (promise) => {
    try {
      const up = await promise
      if (up?.id) setUploads((prev) => prev.map((u) => (u.id === up.id ? up : u)))
      else setUploads((prev) => [...prev])
    } catch (e) { setError(e.message) }
  }

  // La relecture repart côté serveur : on remet la carte en lecture tout de
  // suite, sinon rien ne redéclenche le rafraîchissement.
  const reanalyze = async (id) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, status: 'en_analyse', error: null } : u)))
    try { await api.bank.statements.reanalyze(id) } catch (e) { setError(e.message) }
  }

  const toExtractor = async (id) => {
    try {
      const up = await api.bank.statements.toReceipt(id)
      setUploads((prev) => prev.map((u) => (u.id === id ? up : u)))
    } catch (e) { setError(e.message) }
  }

  const removeUpload = async (id) => {
    try {
      await api.bank.statements.remove(id)
      setUploads((prev) => prev.filter((u) => u.id !== id))
    } catch (e) { setError(e.message) }
  }

  const ready = uploads.filter((u) => u.status === 'pret' && u.document_kind !== 'facture' && u.account_id && (u.rows_json || []).some((r) => r._new))
  const totalFresh = ready.reduce((n, u) => n + u.rows_json.filter((r) => r._new).length, 0)
  const blocked = uploads.some((u) => u.status === 'pret' && u.document_kind !== 'facture' && !u.account_id)

  const doImport = async () => {
    setBusy(true); setError(null)
    try {
      const results = []
      for (const u of ready) results.push(await api.bank.statements.commit(u.id))
      onDone(results)
    } catch (e) { setError(e.message); setBusy(false) }
  }

  const onDrop = (e) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    addFiles([...(e.dataTransfer?.files || [])])
  }

  return (
    <Modal isOpen onClose={onClose} title="Déposer des relevés ou des factures" size="xl">
      <div
        className="space-y-3"
        onDragEnter={(e) => { e.preventDefault(); dragDepth.current++; setDragging(true) }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) } }}
        onDrop={onDrop}
      >
        <div
          data-testid="statement-drop-zone"
          className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
            dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300 hover:border-brand-400'}`}
          onClick={() => fileRef.current?.click()}
        >
          <UploadCloud className={`mx-auto ${dragging ? 'text-brand-600' : 'text-slate-400'}`} size={28} />
          <div className="text-sm text-slate-600 mt-1">
            {dragging ? 'Lâchez ici' : 'Glissez vos fichiers, collez une capture (Ctrl+V), ou cliquez'}
          </div>
          <input
            ref={fileRef} type="file" multiple className="hidden"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.csv,.tsv,.txt,.xlsx,.xls"
            onChange={(e) => { addFiles([...e.target.files]); e.target.value = '' }}
          />
        </div>

        <div className="text-center">
          <button type="button" className="text-xs text-slate-500 hover:text-slate-800 underline"
            onClick={() => setPasteOpen((v) => !v)}>
            ou coller les lignes du relevé
          </button>
        </div>
        {pasteOpen && (
          <div className="space-y-2">
            <textarea
              className="w-full h-28 border border-slate-300 rounded-lg p-2 font-mono text-xs"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <div className="flex justify-end">
              <button type="button" disabled={!pasteText.trim()}
                className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
                onClick={addPastedText}>
                Lire ces lignes
              </button>
            </div>
          </div>
        )}

        {error && <div className="text-sm text-red-600">{error}</div>}

        <div className="space-y-2 max-h-[50vh] overflow-auto">
          {uploads.map((u) => (
            <UploadCard
              key={u.id} up={u} accounts={accounts}
              expanded={!!open[u.id]}
              onToggle={() => setOpen((o) => ({ ...o, [u.id]: !o[u.id] }))}
              onChange={applyChange}
              onRemove={removeUpload}
              onReanalyze={reanalyze}
              onToExtractor={toExtractor}
            />
          ))}
        </div>

        <div className="flex justify-end items-center gap-2">
          {blocked && <span className="text-sm text-red-600">Un compte reste à choisir</span>}
          <button className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50" onClick={onClose}>Fermer</button>
          <button
            className="px-3 py-1.5 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            disabled={busy || pending || blocked || !totalFresh}
            onClick={doImport}
          >
            {busy ? 'Import…' : `Importer ${totalFresh} transaction${totalFresh > 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </Modal>
  )
}
