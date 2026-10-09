import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Upload, RefreshCw, AlertCircle, CheckCircle, Camera, Trash2, Archive, ArchiveRestore, Receipt, Mail, MailOpen } from 'lucide-react'
import { api } from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { Modal } from '../components/Modal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { useEntityListRealtime } from '../lib/useRealtimeChannel.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtCad, fmtMoney } from '../utils/formatters.js'
import { InvoiceCollectionPanel } from './InvoiceCollection.jsx'
import { ReceiptAttachment } from '../components/ReceiptAttachment.jsx'

// Deux onglets : « Reçus » (l'extraction elle-même) et « Collecte de factures »
// (les portails fournisseurs qui l'alimentent automatiquement). La collecte n'a
// pas d'entrée de menu propre : elle vit dans le sous-menu de cette page (voir
// navSubsections.js).
const TABS = [
  ['recus', 'Reçus'],
  ['collecte', 'Collecte de factures'],
]

import ThinkingOrb from '../components/ThinkingOrb'
import { ReceiptStatePill, sourceLabel } from '../components/ReceiptStatePill.jsx'

const UPLOAD_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']
const UPLOAD_EXTS  = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf']

function isAcceptedFile(file) {
  const ext = (file.name || '').split('.').pop().toLowerCase()
  return UPLOAD_MIMES.includes(file.type) || UPLOAD_EXTS.includes(ext)
}

// Dépôt n'importe où sur la page (plus de boîte dédiée) : un voile s'affiche
// pendant le glisser, et un petit bouton garde l'accès au sélecteur de fichiers.
// On ne réagit qu'à un vrai fichier, pas au déplacement d'une sélection de texte.
function PageDrop({ onUpload, uploading, progress, enabled }) {
  const { addToast } = useToast()
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef()

  // Sélection/glisser multiple : chaque fichier devient un document distinct.
  const handleFiles = useCallback((fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    const accepted = files.filter(isAcceptedFile)
    const rejected = files.length - accepted.length
    if (rejected) {
      addToast({
        message: rejected === files.length
          ? 'Formats acceptés : JPG, PNG, GIF, WEBP, PDF'
          : `${rejected} fichier${rejected > 1 ? 's' : ''} ignoré${rejected > 1 ? 's' : ''} — formats acceptés : JPG, PNG, GIF, WEBP, PDF`,
        type: 'error',
      })
    }
    if (!accepted.length) return
    onUpload(accepted)
  }, [addToast, onUpload])

  const handleRef = useRef(handleFiles)
  handleRef.current = handleFiles

  useEffect(() => {
    if (!enabled) return
    let depth = 0
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
    const onEnter = (e) => { if (hasFiles(e)) { e.preventDefault(); depth++; setDragOver(true) } }
    const onOver = (e) => { if (hasFiles(e)) e.preventDefault() }
    const onLeave = () => { if (--depth <= 0) { depth = 0; setDragOver(false) } }
    const onDrop = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragOver(false)
      handleRef.current(e.dataTransfer.files)
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
      setDragOver(false)
    }
  }, [enabled])

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".jpg,.jpeg,.png,.gif,.webp,.pdf"
        className="hidden"
        data-testid="upload-input"
        onChange={e => { handleFiles(e.target.files); e.target.value = '' }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        data-testid="upload-zone"
        title="Ou glissez des fichiers n'importe où sur la page"
        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 bg-white border border-slate-300 rounded-lg hover:border-brand-400 hover:bg-slate-50 transition-colors disabled:opacity-60"
      >
        {uploading ? <ThinkingOrb size={14} /> : <Upload size={14} />}
        <span data-testid={uploading ? 'upload-progress' : undefined}>
          {uploading
            ? (progress?.total > 1 ? `${Math.min(progress.done + 1, progress.total)} / ${progress.total}` : 'Envoi…')
            : 'Importer'}
        </span>
      </button>
      {dragOver && (
        <div className="fixed inset-0 z-40 pointer-events-none flex items-center justify-center bg-brand-600/10 border-4 border-dashed border-brand-500">
          <span className="px-4 py-2 rounded-lg bg-white text-sm shadow">Lâchez ici</span>
        </div>
      )}
    </>
  )
}

function WebcamCaptureModal({ onClose, onCapture, uploading }) {
  const videoRef  = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const [error, setError]       = useState(null)
  const [starting, setStarting] = useState(true)
  const [preview, setPreview]   = useState(null)
  const previewBlobRef          = useRef(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width:  { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
        setStarting(false)
      } catch (e) {
        if (cancelled) return
        setStarting(false)
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
          setError("Permission refusée. Autorisez l'accès à la caméra dans votre navigateur.")
        } else if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') {
          setError("Aucune caméra détectée sur cet appareil.")
        } else {
          setError(`Erreur caméra : ${e.message || e.name}`)
        }
      }
    })()
    return () => {
      cancelled = true
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!preview) return
    return () => URL.revokeObjectURL(preview)
  }, [preview])

  function capture() {
    const video  = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    const w = video.videoWidth, h = video.videoHeight
    if (!w || !h) return
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d').drawImage(video, 0, 0, w, h)
    canvas.toBlob(blob => {
      if (!blob) return
      previewBlobRef.current = blob
      setPreview(URL.createObjectURL(blob))
    }, 'image/jpeg', 0.92)
  }

  function retake() {
    previewBlobRef.current = null
    setPreview(null)
  }

  async function confirmUpload() {
    const blob = previewBlobRef.current
    if (!blob) return
    const fd = new FormData()
    const filename = `webcam-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`
    fd.append('file', blob, filename)
    await onCapture(fd)
    onClose()
  }

  return (
    <Modal isOpen={true} onClose={onClose} title="Capturer avec la caméra" size="lg">
      {error ? (
        <div className="flex flex-col items-center gap-3 py-6">
          <AlertCircle size={32} className="text-red-500" />
          <p className="text-sm text-slate-700 text-center max-w-sm">{error}</p>
          <button className="btn-secondary text-sm" onClick={onClose}>Fermer</button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <div className="w-full bg-black rounded-lg overflow-hidden aspect-video flex items-center justify-center relative">
            {preview ? (
              <img src={preview} alt="Capture" className="max-w-full max-h-full object-contain" data-testid="webcam-preview" />
            ) : (
              <>
                {starting && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
                    <ThinkingOrb size={28} ink />
                    <p className="text-xs">Démarrage de la caméra…</p>
                  </div>
                )}
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`w-full h-full object-contain ${starting ? 'opacity-0' : ''}`}
                  data-testid="webcam-video"
                />
              </>
            )}
          </div>
          <canvas ref={canvasRef} className="hidden" />

          <div className="flex gap-2 justify-center">
            {preview ? (
              <>
                <button type="button" className="btn-secondary inline-flex items-center gap-1" onClick={retake} disabled={uploading}>
                  <RefreshCw size={14} /> Reprendre
                </button>
                <button type="button" className="btn-primary inline-flex items-center gap-1" onClick={confirmUpload} disabled={uploading} data-testid="webcam-confirm">
                  {uploading ? <><ThinkingOrb size={14} ink /> Téléversement…</> : <><CheckCircle size={14} /> Utiliser cette photo</>}
                </button>
              </>
            ) : (
              <button type="button" className="btn-primary inline-flex items-center gap-1" onClick={capture} disabled={starting} data-testid="webcam-capture">
                <Camera size={14} /> Capturer
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

const RENDERS = {
  // Point bleu à la Gmail devant le nom : visible tant que le document n'a pas
  // été ouvert (read_at NULL). L'espace est réservé même une fois lu pour que
  // les noms restent alignés d'une ligne à l'autre.
  company: row => (
    <span className="inline-flex items-center gap-2.5 min-w-0">
      <span
        className={`h-2 w-2 rounded-full shrink-0 ${row.read_at ? 'bg-transparent' : 'bg-blue-500'}`}
        title={row.read_at ? undefined : 'Non consulté'}
        data-testid={row.read_at ? undefined : 'receipt-unread-dot'}
      />
      {/* Le nom seul (maquette E3, 2026-10-03) : gras tant que non lu ; le
          numéro a sa propre colonne. */}
      <span className={`min-w-0 truncate text-slate-900 ${row.read_at ? '' : 'font-semibold'}`}>{row.company || row.original_name || '—'}</span>
    </span>
  ),
  source: row => <span className="text-slate-500">{sourceLabel(row.source)}</span>,
  receipt_date: row => <span className="text-slate-500">{row.receipt_date ? fmtDate(row.receipt_date) : '—'}</span>,
  receipt_number: row => row.receipt_number
    ? <span className="font-mono text-xs text-slate-600">#{row.receipt_number}</span>
    : <span className="text-slate-300">—</span>,
  total: row => <span className="font-medium text-slate-700 tabular-nums">
    {row.currency && row.currency !== 'CAD' ? fmtMoney(row.total, row.currency) : fmtCad(row.total)}
  </span>,
  currency: row => row.currency
    ? <span className="font-mono text-xs text-slate-600">{row.currency}</span>
    : <span className="text-slate-300">—</span>,
  payment_method: row => <span className="text-slate-600">{row.payment_method || '—'}</span>,
  // `obsolete` (serveur) : document sans objet comptable — 0 $ ou copie d'un document
  // déjà publié sur QB. Le badge signale dès la liste ce qui peut être archivé.
  // Une seule pastille : ce qu'il reste à faire pour ce document (voir receiptState).
  // Seuls les problèmes s'écrivent (voir la variante `quiet`).
  status: row => <ReceiptStatePill row={row} quiet />,
  original_name: row => <span className="text-slate-500 text-xs">{row.original_name || '—'}</span>,
  justificatif: row => <ReceiptAttachment receipt={row} />,
  created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
  archived_at: row => row.archived_at
    ? <span className="text-slate-500">{fmtDate(row.archived_at)}</span>
    : <span className="text-slate-300">—</span>,
  read_at: row => row.read_at
    ? <span className="text-slate-500">{fmtDate(row.read_at)}</span>
    : <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700"><span className="h-2 w-2 rounded-full bg-blue-500" /> Non lu</span>,
}

// La colonne QuickBooks est retirée de la liste (Charles, 2026-10-03) : le ✓ de
// l'état mène déjà à l'écriture. Les filtres des onglets lisent le champ, pas la
// colonne — ils restent intacts.
const COLUMNS = TABLE_COLUMN_META.sale_receipts
  .filter(meta => meta.id !== 'quickbooks_id')
  .map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function SaleReceipts() {
  const navigate = useNavigate()
  const { addToast } = useToast()
  const [params, setParams] = useSearchParams()
  const askedTab = params.get('onglet')
  const tab = TABS.some(([k]) => k === askedTab) ? askedTab : 'recus'
  const setTab = (v) => setParams(v === 'recus' ? {} : { onglet: v }, { replace: true })
  const [receipts, setReceipts]       = useState([])
  const [loading, setLoading]         = useState(true)
  const [uploading, setUploading]     = useState(false)
  const [uploadProgress, setUploadProgress] = useState(null) // { done, total } en import multiple
  const [webcamOpen, setWebcamOpen]   = useState(false)
  const [toDelete, setToDelete]       = useState(null)
  const displayedIdsRef               = useRef([])

  // Consommer la demande d'ouverture pour que fermer/recharger la page ne
  // redémarre pas la caméra. Les liens ordinaires vers les reçus restent libres.
  useEffect(() => {
    if (params.get('capture') !== 'camera') return
    setWebcamOpen(true)
    const next = new URLSearchParams(params)
    next.delete('capture')
    next.delete('onglet')
    setParams(next, { replace: true })
  }, [params, setParams])

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.saleReceipts.list({ limit, page }),
      setReceipts, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  useEntityListRealtime('sale_receipt', setReceipts)

  async function handleUpload(formData) {
    setUploading(true)
    try {
      await api.saleReceipts.upload(formData)
      await load()
      // Pas de navigation auto : on reste sur la liste, le document s'ajoute simplement
    } catch (err) {
      addToast({ message: 'Erreur: ' + err.message, type: 'error' })
    } finally {
      setUploading(false)
    }
  }

  // Import multi-documents : un fichier = un document (une extraction chacun).
  // Séquentiel pour garder un compteur de progression fiable et ne pas lancer
  // vingt extractions IA d'un coup ; l'extraction reste async côté serveur.
  async function handleUploadFiles(files) {
    if (!files?.length) return
    setUploading(true)
    setUploadProgress({ done: 0, total: files.length })
    const failed = []
    let ok = 0
    for (const file of files) {
      try {
        const fd = new FormData()
        fd.append('file', file)
        await api.saleReceipts.upload(fd)
        ok++
      } catch (err) {
        failed.push(`${file.name} (${err.message})`)
      }
      setUploadProgress(p => ({ total: files.length, done: (p?.done || 0) + 1 }))
    }
    await load()
    setUploadProgress(null)
    setUploading(false)
    if (failed.length) {
      addToast({ message: `Erreur sur ${failed.length} document${failed.length > 1 ? 's' : ''} : ${failed.slice(0, 3).join(', ')}`, type: 'error' })
    } else if (ok > 1) {
      addToast({ message: `${ok} documents importés — extraction en cours`, type: 'success' })
    }
  }

  async function handleDelete(id) {
    try {
      await api.saleReceipts.delete(id)
      await load()
    } catch (err) {
      addToast({ message: 'Erreur: ' + err.message, type: 'error' })
    }
    setToDelete(null)
  }

  // Suppression groupée : DataTable affiche déjà sa propre confirmation avant
  // d'appeler ce callback, on ne re-confirme donc pas ici.
  async function handleBulkDelete(ids) {
    try {
      await Promise.all(ids.map(id => api.saleReceipts.delete(id)))
      await load()
      addToast({ message: `${ids.length} reçu${ids.length > 1 ? 's' : ''} supprimé${ids.length > 1 ? 's' : ''}`, type: 'success' })
    } catch (err) {
      addToast({ message: 'Erreur: ' + err.message, type: 'error' })
    }
  }

  async function handleBulkArchive(ids) {
    try {
      await Promise.all(ids.map(id => api.saleReceipts.archive(id)))
      await load()
      addToast({ message: `${ids.length} reçu${ids.length > 1 ? 's' : ''} archivé${ids.length > 1 ? 's' : ''}`, type: 'success' })
    } catch (err) {
      addToast({ message: 'Erreur: ' + err.message, type: 'error' })
    }
  }

  async function handleBulkUnarchive(ids) {
    try {
      await Promise.all(ids.map(id => api.saleReceipts.unarchive(id)))
      await load()
      addToast({ message: `${ids.length} reçu${ids.length > 1 ? 's' : ''} désarchivé${ids.length > 1 ? 's' : ''}`, type: 'success' })
    } catch (err) {
      addToast({ message: 'Erreur: ' + err.message, type: 'error' })
    }
  }

  // Lu / non lu à la Gmail : optimiste côté client (le gras disparaît tout de
  // suite), l'écho realtime du serveur confirme.
  const setReadState = useCallback((ids, readAt) => {
    const idSet = new Set(ids.map(String))
    setReceipts(rs => rs.map(r => idSet.has(String(r.id)) ? { ...r, read_at: readAt } : r))
  }, [])

  async function handleBulkMarkRead(ids) {
    setReadState(ids, new Date().toISOString())
    try { await Promise.all(ids.map(id => api.saleReceipts.markRead(id))) }
    catch (err) { addToast({ message: 'Erreur: ' + err.message, type: 'error' }); load() }
  }

  async function handleBulkMarkUnread(ids) {
    setReadState(ids, null)
    try { await Promise.all(ids.map(id => api.saleReceipts.markUnread(id))) }
    catch (err) { addToast({ message: 'Erreur: ' + err.message, type: 'error' }); load() }
  }

  // Actions groupées : « Archiver » quand aucune des lignes sélectionnées n'est
  // archivée, « Désarchiver » quand elles le sont toutes (onglet Archivés).
  const BULK_ACTIONS = [
    {
      key: 'mark-read',
      label: 'Marquer lu',
      busyLabel: 'Marquage...',
      icon: MailOpen,
      className: 'inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 px-3 py-1.5 rounded transition-colors',
      show: rows => rows.length > 0 && rows.some(r => !r.read_at),
      onClick: handleBulkMarkRead,
    },
    {
      key: 'mark-unread',
      label: 'Marquer non lu',
      busyLabel: 'Marquage...',
      icon: Mail,
      className: 'inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 px-3 py-1.5 rounded transition-colors',
      show: rows => rows.length > 0 && rows.every(r => r.read_at),
      onClick: handleBulkMarkUnread,
    },
    {
      key: 'archive',
      label: 'Archiver',
      busyLabel: 'Archivage...',
      icon: Archive,
      className: 'inline-flex items-center gap-1.5 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 px-3 py-1.5 rounded transition-colors',
      show: rows => rows.length > 0 && rows.every(r => !r.archived_at),
      onClick: handleBulkArchive,
    },
    {
      key: 'unarchive',
      label: 'Désarchiver',
      busyLabel: 'Désarchivage...',
      icon: ArchiveRestore,
      className: 'inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 px-3 py-1.5 rounded transition-colors',
      show: rows => rows.length > 0 && rows.every(r => r.archived_at),
      onClick: handleBulkUnarchive,
    },
  ]

  const COLUMNS_WITH_ACTIONS = [
    ...COLUMNS,
    {
      id: '_actions', label: '', field: null, sortable: false, filterable: false, groupable: false,
      render: row => (
        <button
          onClick={e => { e.stopPropagation(); setToDelete(row) }}
          className="p-1 rounded text-slate-400 hover:bg-red-100 hover:text-red-600"
          title="Supprimer"
          aria-label="Supprimer"
        >
          <Trash2 size={13} />
        </button>
      ),
    },
  ]

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <PageTitle>Extraction de données</PageTitle>
            <p className="text-xs text-slate-400 mt-0.5">Extraction automatique par IA</p>
          </div>
          <div className="flex items-center gap-2">
          {tab === 'recus' && (
            <>
              <PageDrop onUpload={handleUploadFiles} uploading={uploading} progress={uploadProgress} enabled={!webcamOpen} />
              <button
                type="button"
                onClick={() => setWebcamOpen(true)}
                disabled={uploading}
                data-testid="open-webcam"
                className="inline-flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 bg-white border border-slate-300 rounded-lg hover:border-brand-400 hover:bg-slate-50 transition-colors disabled:opacity-60"
              >
                <Camera size={14} />
                Capturer
              </button>
            </>
          )}
          <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
            {TABS.map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} data-testid={`tab-${k}`}
                className={`px-3 py-1.5 text-sm rounded-md ${tab === k ? 'bg-white shadow-sm font-medium text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                {label}
              </button>
            ))}
          </div>
          </div>
        </div>

        {tab === 'collecte' ? <InvoiceCollectionPanel /> : (
        <>
        {/* Lu / non lu à la Gmail : les non-lus ressortent (gras, texte plein,
            point bleu dans la cellule Fournisseur), les lus passent en retrait
            (fond légèrement teinté, titre atténué) ; transition-colors adoucit
            le passage au clic — voir rowClassName. */}
        <DataTable
          table="sale_receipts"
          manageViews
          columns={COLUMNS_WITH_ACTIONS}
          data={receipts}
          searchFields={['company', 'original_name', 'receipt_number', 'total']}
          loading={loading}
          onBulkDelete={handleBulkDelete}
          bulkActions={BULK_ACTIONS}
          bulkDeleteAlways
          onFilteredDataChange={rows => { displayedIdsRef.current = rows.map(r => String(r.id)) }}
          rowClassName={row => (row.read_at
            ? 'transition-colors bg-slate-50/70 hover:bg-slate-100 [&_.text-slate-900]:text-slate-600 [&_.text-slate-700]:text-slate-500'
            : 'transition-colors bg-white font-semibold [&_.text-slate-500]:text-slate-700 [&_.text-slate-600]:text-slate-800')
            // Lié à une transaction du relevé : même bleu que Transactions
            // (maquette X1, 2026-10-06) — ligne bleutée + trait à gauche.
            + (row.bank_txn ? ' !bg-sky-100 hover:!bg-sky-200 [&>td:first-child]:shadow-[inset_5px_0_0_#0284c7]' : '')}
          onRowClick={row => {
            // Ouvrir un reçu le marque lu (comme un courriel Gmail).
            if (!row.read_at) {
              setReadState([row.id], new Date().toISOString())
              api.saleReceipts.markRead(row.id).catch(() => {})
            }
            // Mémoriser l'ordre courant de la vue (filtrée/triée) pour la nav
            // prev/next dans la fiche détail. sessionStorage = scope onglet,
            // suffisant pour une session de navigation.
            try {
              sessionStorage.setItem('sale_receipts:nav_ids', JSON.stringify(displayedIdsRef.current))
            } catch {}
            navigate(`/sale-receipts/${row.id}`)
          }}
          emptyState={{ icon: Receipt, title: 'Aucun reçu de vente', description: "Aucun reçu n'a encore été importé. Glisse des fichiers sur la page ou prends une photo.", cta: { label: 'Prendre en photo', icon: Camera, onClick: () => setWebcamOpen(true) } }}
        />
        </>
        )}
      </div>

      {tab === 'recus' && webcamOpen && (
        <WebcamCaptureModal
          onClose={() => setWebcamOpen(false)}
          onCapture={handleUpload}
          uploading={uploading}
        />
      )}

      {toDelete && (
        <Modal isOpen={true} title="Supprimer ce reçu" onClose={() => setToDelete(null)} size="sm">
          <p className="text-slate-600 text-sm">Voulez-vous supprimer le reçu <strong>{toDelete.company || toDelete.original_name}</strong> ? Cette action est irréversible.</p>
          <div className="flex justify-end gap-2 mt-4">
            <button className="btn-secondary" onClick={() => setToDelete(null)}>Annuler</button>
            <button className="btn-danger" onClick={() => handleDelete(toDelete.id)}>Supprimer</button>
          </div>
        </Modal>
      )}
    </Layout>
  )
}
