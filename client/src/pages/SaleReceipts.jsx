import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, RefreshCw, AlertCircle, CheckCircle, Clock, Camera, BookOpen, Trash2 } from 'lucide-react'
import { api } from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { Modal } from '../components/Modal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { useEntityListRealtime } from '../lib/useRealtimeChannel.js'
import { fmtDate } from '../lib/formatDate.js'

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

function StatusBadge({ status }) {
  if (status === 'done')       return <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full"><CheckCircle size={10} /> Complété</span>
  if (status === 'processing') return <span className="inline-flex items-center gap-1 text-xs text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full"><RefreshCw size={10} className="animate-spin" /> En cours</span>
  if (status === 'error')      return <span className="inline-flex items-center gap-1 text-xs text-red-700 bg-red-100 px-2 py-0.5 rounded-full"><AlertCircle size={10} /> Erreur</span>
  return <span className="inline-flex items-center gap-1 text-xs text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full"><Clock size={10} /> En attente</span>
}

function UploadZone({ onUpload, uploading, compact }) {
  const { addToast } = useToast()
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef()

  function handleFiles(files) {
    if (!files?.length) return
    const file = files[0]
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']
    const ext = file.name.split('.').pop().toLowerCase()
    if (!allowed.includes(file.type) && !['jpg','jpeg','png','gif','webp','pdf'].includes(ext)) {
      addToast({ message: 'Formats acceptés : JPG, PNG, GIF, WEBP, PDF', type: 'error' })
      return
    }
    const fd = new FormData()
    fd.append('file', file)
    onUpload(fd)
  }

  return (
    <div
      className={`relative border-2 border-dashed rounded-xl ${compact ? 'px-4 py-3' : 'p-8'} text-center transition-colors cursor-pointer
        ${dragOver ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-white hover:border-brand-400 hover:bg-slate-50'}
        ${uploading ? 'opacity-60 pointer-events-none' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
      onClick={() => inputRef.current?.click()}
      data-testid="upload-zone"
    >
      <input ref={inputRef} type="file" accept=".jpg,.jpeg,.png,.gif,.webp,.pdf" className="hidden" onChange={e => handleFiles(e.target.files)} />
      {uploading ? (
        <div className="flex items-center justify-center gap-2 text-slate-600">
          <RefreshCw size={16} className="text-brand-500 animate-spin" />
          <span className="text-sm font-medium">Téléversement en cours…</span>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-3 text-slate-600">
          <Upload size={18} className="text-brand-600" />
          <span className="text-sm font-medium">Glissez un fichier ici ou cliquez pour parcourir</span>
          <span className="text-xs text-slate-400">JPG, PNG, GIF, WEBP, PDF — max 20 Mo</span>
        </div>
      )}
    </div>
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
                    <RefreshCw size={28} className="animate-spin" />
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
                  {uploading ? <><RefreshCw size={14} className="animate-spin" /> Téléversement…</> : <><CheckCircle size={14} /> Utiliser cette photo</>}
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
  company: row => <span className="font-medium text-slate-900">{row.company || row.original_name || '—'}</span>,
  receipt_date: row => <span className="text-slate-500">{row.receipt_date ? fmtDate(row.receipt_date) : '—'}</span>,
  receipt_number: row => row.receipt_number
    ? <span className="font-mono text-xs text-slate-600">#{row.receipt_number}</span>
    : <span className="text-slate-300">—</span>,
  total: row => <span className="font-medium text-slate-700">{fmtCad(row.total)}</span>,
  currency: row => row.currency
    ? <span className="font-mono text-xs text-slate-600">{row.currency}</span>
    : <span className="text-slate-300">—</span>,
  payment_method: row => <span className="text-slate-600">{row.payment_method || '—'}</span>,
  status: row => <StatusBadge status={row.status} />,
  quickbooks_id: row => row.quickbooks_id
    ? (row.quickbooks_url
        ? <a href={row.quickbooks_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
             className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 hover:bg-green-200 px-2 py-0.5 rounded-full">
            <BookOpen size={10} /> #{row.quickbooks_id}
          </a>
        : <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
            <BookOpen size={10} /> #{row.quickbooks_id}
          </span>)
    : <span className="text-slate-300">—</span>,
  original_name: row => <span className="text-slate-500 text-xs">{row.original_name || '—'}</span>,
  created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.sale_receipts.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function SaleReceipts() {
  const navigate = useNavigate()
  const { addToast } = useToast()
  const [receipts, setReceipts]       = useState([])
  const [loading, setLoading]         = useState(true)
  const [uploading, setUploading]     = useState(false)
  const [webcamOpen, setWebcamOpen]   = useState(false)
  const [toDelete, setToDelete]       = useState(null)
  const displayedIdsRef               = useRef([])

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
      const { id } = await api.saleReceipts.upload(formData)
      await load()
      navigate(`/sale-receipts/${id}`)
    } catch (err) {
      addToast({ message: 'Erreur: ' + err.message, type: 'error' })
    } finally {
      setUploading(false)
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
            <h1 className="text-2xl font-bold text-slate-900">Extraction de données</h1>
            <p className="text-xs text-slate-400 mt-0.5">Extraction automatique par IA</p>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="sale_receipts" />
          </div>
        </div>

        <div className="flex items-stretch gap-3 mb-4">
          <div className="flex-1">
            <UploadZone onUpload={handleUpload} uploading={uploading} compact />
          </div>
          <button
            type="button"
            onClick={() => setWebcamOpen(true)}
            disabled={uploading}
            data-testid="open-webcam"
            className="inline-flex items-center justify-center gap-2 px-4 text-sm text-slate-700 bg-white border border-slate-300 rounded-xl hover:border-brand-400 hover:bg-slate-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <Camera size={16} />
            Capturer
          </button>
        </div>

        <DataTable
          table="sale_receipts"
          columns={COLUMNS_WITH_ACTIONS}
          data={receipts}
          searchFields={['company', 'original_name', 'receipt_number', 'total']}
          loading={loading}
          onFilteredDataChange={rows => { displayedIdsRef.current = rows.map(r => String(r.id)) }}
          onRowClick={row => {
            // Mémoriser l'ordre courant de la vue (filtrée/triée) pour la nav
            // prev/next dans la fiche détail. sessionStorage = scope onglet,
            // suffisant pour une session de navigation.
            try {
              sessionStorage.setItem('sale_receipts:nav_ids', JSON.stringify(displayedIdsRef.current))
            } catch {}
            navigate(`/sale-receipts/${row.id}`)
          }}
        />
      </div>

      {webcamOpen && (
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
