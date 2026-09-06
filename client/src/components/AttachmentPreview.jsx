import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, X, FileText, Image as ImageIcon, Maximize2, ExternalLink } from 'lucide-react'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// Champ « pièce jointe » réutilisable : une vignette du fichier (PDF ou image)
// qu'on clique pour l'ouvrir en grand dans une modale, avec téléchargement.
//
// Sert partout où une fiche porte un document : étiquette d'expédition, PDF de
// facture client, reçu… L'idée est toujours la même : voir le document sans
// quitter la fiche, et pouvoir l'agrandir d'un clic.
//
//   <AttachmentPreview url={url} fileName="etiquette.pdf" title="Étiquette" />
//
// `url` peut être un chemin same-origin (`/erp/api/…`) ou un blob: URL.
//
// `onUnavailable(reason)` prévient la fiche quand la vignette n'a rien pu
// afficher — `'missing'` (fichier absent/refusé) ou `'error'` (document
// illisible). Une fiche peut alors proposer la réparation qui va bien.

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif)(?:$|[?#])/i
const PDF_RE = /\.pdf(?:$|[?#])/i

// Type de rendu déduit du nom de fichier / de l'URL, avec le type MIME en
// priorité quand on le connaît. Les blob: URLs n'ont pas d'extension : c'est
// alors `fileName` (ou `kind` passé explicitement) qui tranche.
export function attachmentKind({ url, fileName, contentType }) {
  if (contentType) {
    if (contentType.startsWith('image/')) return 'image'
    if (contentType === 'application/pdf') return 'pdf'
  }
  for (const candidate of [fileName, url]) {
    if (!candidate) continue
    if (IMAGE_RE.test(candidate)) return 'image'
    if (PDF_RE.test(candidate)) return 'pdf'
  }
  return 'file'
}

// Visionneuse plein écran. Utilisable seule (quand la vignette n'a pas de sens,
// ex. un bouton « Aperçu ») ou via <AttachmentPreview>, qui la pilote.
export function AttachmentPreviewModal({ url, fileName, title, kind, downloadName, onClose }) {
  const resolved = kind || attachmentKind({ url, fileName })

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.() } }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  if (!url) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title || fileName || 'Pièce jointe'}
      data-testid="attachment-preview-modal"
    >
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-[95vw] max-w-6xl h-[92vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 flex-shrink-0">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900 truncate">{title || fileName || 'Pièce jointe'}</p>
            {title && fileName && <p className="text-xs text-slate-400 truncate">{fileName}</p>}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary btn-sm flex items-center gap-1.5"
              data-testid="attachment-preview-open"
            >
              <ExternalLink size={13} /> Ouvrir
            </a>
            <a
              href={url}
              download={downloadName || fileName || true}
              className="btn-secondary btn-sm flex items-center gap-1.5"
              data-testid="attachment-preview-download"
            >
              <Download size={13} /> Télécharger
            </a>
            <button
              onClick={onClose}
              aria-label="Fermer"
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              data-testid="attachment-preview-close"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        {resolved === 'image' ? (
          <div className="flex-1 min-h-0 overflow-auto bg-slate-100 flex items-center justify-center p-4">
            <img src={url} alt={fileName || 'Pièce jointe'} className="max-w-full max-h-full object-contain" />
          </div>
        ) : resolved === 'pdf' ? (
          <iframe src={url} className="flex-1 w-full" title={title || fileName || 'Document'} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-500">
            <FileText size={32} className="text-slate-300" />
            <p className="text-sm">Aperçu indisponible pour ce type de fichier.</p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

const SIZES = {
  sm: { width: 92, height: 120 },
  md: { width: 154, height: 200 },
}

// Vignette d'un PDF dessinée par nous-mêmes, sur fond blanc.
//
// Le viewer PDF du navigateur (ancienne approche : une <iframe> réduite)
// entoure la page d'un fond gris foncé qu'aucun CSS ne peut atteindre — très
// visible pour une étiquette en paysage dans une vignette en portrait, où la
// page ne couvre que la moitié de la hauteur. On rend donc la 1re page sur un
// canvas rempli de blanc : la vignette est blanche, sans barre d'outils.
function PdfThumb({ url, width, height, label, onFail }) {
  const canvasRef = useRef(null)
  const [failed, setFailed] = useState(null)
  const failRef = useRef(onFail)
  failRef.current = onFail

  useEffect(() => {
    let cancelled = false
    let doc = null
    let task = null
    setFailed(null)
    ;(async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc
        doc = await pdfjs.getDocument({ url }).promise
        if (cancelled) return
        const page = await doc.getPage(1)
        if (cancelled) return
        const canvas = canvasRef.current
        if (!canvas) return
        const base = page.getViewport({ scale: 1 })
        // « object-contain » : la page tient en entier dans la vignette, le
        // reste de la boîte laisse voir le blanc du bouton.
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const fit = Math.min(width / base.width, height / base.height)
        const viewport = page.getViewport({ scale: fit * dpr })
        canvas.width = Math.max(1, Math.round(viewport.width))
        canvas.height = Math.max(1, Math.round(viewport.height))
        canvas.style.width = `${Math.round(base.width * fit)}px`
        canvas.style.height = `${Math.round(base.height * fit)}px`
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        task = page.render({ canvasContext: ctx, viewport })
        await task.promise
      } catch (e) {
        // Le fichier lui-même est absent/refusé (404, 401, réseau) : ce n'est
        // pas « pas d'aperçu », c'est « pas de document ». On le distingue pour
        // que la fiche puisse proposer la bonne réparation.
        const gone = e?.name === 'MissingPDFException' || e?.name === 'UnexpectedResponseException'
        if (!cancelled) { setFailed(gone ? 'missing' : 'error'); failRef.current?.(gone ? 'missing' : 'error') }
      }
    })()
    return () => {
      cancelled = true
      try { task?.cancel() } catch { /* rendu déjà terminé */ }
      doc?.destroy?.()
    }
  }, [url, width, height])

  if (failed) {
    return (
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-slate-400 px-1 text-center">
        <FileText size={20} />
        <span className="text-[11px]">{failed === 'missing' ? 'Fichier introuvable' : 'Aperçu indisponible'}</span>
      </span>
    )
  }
  return (
    <canvas
      ref={canvasRef}
      aria-label={label}
      role="img"
      className="absolute inset-0 m-auto"
    />
  )
}

export default function AttachmentPreview({
  url,
  fileName,
  title,
  kind,
  contentType,
  downloadName,
  size = 'sm',
  showFileName = true,
  className = '',
  testId = 'attachment-preview',
  onUnavailable,
}) {
  const [open, setOpen] = useState(false)
  const [imgFailed, setImgFailed] = useState(false)
  const resolved = kind || attachmentKind({ url, fileName, contentType })
  const dims = SIZES[size] || SIZES.sm
  const notifyRef = useRef(onUnavailable)
  notifyRef.current = onUnavailable

  if (!url) return null

  return (
    <div className={`inline-flex flex-col gap-1.5 ${className}`} data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Agrandir"
        aria-label={`Agrandir ${fileName || title || 'la pièce jointe'}`}
        className="group relative block overflow-hidden rounded-lg border border-slate-200 bg-fixed-white hover:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-400 transition-colors"
        style={{ width: dims.width, height: dims.height }}
        data-testid={`${testId}-thumb`}
      >
        {resolved === 'pdf' ? (
          <PdfThumb
            url={url}
            width={dims.width}
            height={dims.height}
            label={`Aperçu ${fileName || title || 'document'}`}
            onFail={reason => notifyRef.current?.(reason)}
          />
        ) : resolved === 'image' && !imgFailed ? (
          <img
            src={url}
            alt={fileName || 'Pièce jointe'}
            className="absolute inset-0 w-full h-full object-contain"
            onError={() => { setImgFailed(true); notifyRef.current?.('missing') }}
          />
        ) : (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-slate-400 px-1 text-center">
            {resolved === 'image' ? <ImageIcon size={20} /> : <FileText size={20} />}
            <span className="text-[11px]">{imgFailed ? 'Fichier introuvable' : 'Aperçu indisponible'}</span>
          </span>
        )}
        <span className="absolute inset-0 flex items-end justify-center pb-1.5 bg-gradient-to-t from-black/40 opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-fixed-white">
            <Maximize2 size={11} /> Agrandir
          </span>
        </span>
      </button>
      {showFileName && (
        <a
          href={url}
          download={downloadName || fileName || true}
          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline max-w-full"
          style={{ width: dims.width }}
          data-testid={`${testId}-download`}
        >
          <Download size={11} className="flex-shrink-0" />
          <span className="truncate">{fileName || 'Télécharger'}</span>
        </a>
      )}
      {open && (
        <AttachmentPreviewModal
          url={url}
          fileName={fileName}
          title={title}
          kind={resolved}
          downloadName={downloadName}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
