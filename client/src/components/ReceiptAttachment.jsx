import { AttachmentChip } from '../lib/customFieldDisplay.jsx'
import { api } from '../lib/api.js'

// Pièce justificative d'un document d'extraction : le fichier réellement
// récupéré (courriel, portail fournisseur, téléversement, photo). Rendu comme un
// champ « Attachement » — même pastille/vignette que partout ailleurs, le clic
// ouvre le fichier en modale. Une page = une pièce : un document multipage en
// porte plusieurs (/:id/file?page=N).
//
// Aucune copie des octets : le descripteur est construit des métadonnées déjà
// servies par la liste (`pages`), les fichiers restent servis par leur route.

const MIME = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
}

function pageName(page, index, count) {
  const base = page?.original_name || `document${page?.file_type || ''}`
  return count > 1 ? `${base} — p. ${index + 1}` : base
}

export function ReceiptAttachment({ receipt, compact = true }) {
  const pages = receipt?.pages?.length
    ? receipt.pages
    : (receipt?.original_name || receipt?.file_type
        ? [{ file_type: receipt.file_type, original_name: receipt.original_name }]
        : [])
  if (!receipt?.id || !pages.length) return <span className="text-slate-400">—</span>
  return (
    <div className="flex items-center gap-1 overflow-hidden" data-testid="receipt-justificatif">
      {pages.map((p, i) => (
        <AttachmentChip
          key={i}
          compact={compact}
          href={api.saleReceipts.fileUrl(receipt.id, i)}
          file={{ name: pageName(p, i, pages.length), type: MIME[p?.file_type] }}
        />
      ))}
    </div>
  )
}
