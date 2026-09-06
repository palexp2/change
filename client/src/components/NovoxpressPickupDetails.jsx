import { Package, XCircle, AlertTriangle } from 'lucide-react'
import { fmtDate, fmtDateTime } from '../lib/formatDate.js'
import { PICKUP_LOCATIONS } from './NovoxpressPickupModal.jsx'

function locationLabel(value) {
  return PICKUP_LOCATIONS.find(l => l.value === value)?.label || value || '—'
}

function Row({ label, children, testId }) {
  return (
    <div className="flex items-start gap-3 py-2 border-b border-slate-100 last:border-0">
      <span className="w-44 shrink-0 text-xs uppercase tracking-wide text-slate-400 pt-0.5">{label}</span>
      <span className="text-sm text-slate-800 flex-1" data-testid={testId}>{children}</span>
    </div>
  )
}

// Contenu de la modale « Détails du ramassage » : ce qui a été commandé chez
// Novoxpress (date, fenêtre horaire, emplacement, consignes). Novoxpress n'a pas
// d'endpoint de relecture d'un ramassage : la source est ce qu'on a mémorisé au
// moment de la commande, d'où le repli explicite pour les ramassages plus anciens.
export default function NovoxpressPickupDetails({ envoi, onCancel, cancelling, onClose }) {
  let details = null
  try {
    const raw = envoi.novoxpress_pickup_details
    details = typeof raw === 'string' ? JSON.parse(raw) : raw || null
  } catch { details = null }

  return (
    <div className="space-y-4" data-testid="pickup-details">
      <div className="flex items-center gap-2 text-sm text-brand-700 bg-brand-50 border border-brand-200 rounded-lg px-3 py-2">
        <Package size={14} />
        <span>Ramassage planifié · <span className="font-mono">{envoi.novoxpress_pickup_id}</span></span>
      </div>

      {details ? (
        <div>
          <Row label="Date" testId="pickup-details-date">{fmtDate(details.date)}</Row>
          <Row label="Fenêtre de ramassage" testId="pickup-details-window">
            {details.ready_at && details.ready_until
              ? `${details.ready_at} — ${details.ready_until}`
              : (details.ready_at || '—')}
          </Row>
          <Row label="Emplacement du colis">{locationLabel(details.pickup_location)}</Row>
          <Row label="Colis">
            {details.quantity || 1} colis{details.weight ? ` · ${details.weight} lb` : ''}
          </Row>
          <Row label="Instructions">
            {details.pickup_instructions
              ? details.pickup_instructions
              : <span className="text-slate-400">Aucune</span>}
          </Row>
          <Row label="Commandé le">
            {fmtDateTime(details.scheduled_at)}
            {details.scheduled_by ? ` · ${details.scheduled_by}` : ''}
          </Row>
          {envoi.carrier && <Row label="Transporteur">{envoi.carrier}</Row>}
          {details.message && <Row label="Réponse Novoxpress">{details.message}</Row>}
        </div>
      ) : (
        <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2" data-testid="pickup-details-missing">
          <AlertTriangle size={15} className="text-amber-600 mt-0.5 shrink-0" />
          <span>
            Ce ramassage a été commandé avant l'enregistrement des détails : seule sa
            référence est connue. Les prochains ramassages afficheront date, fenêtre
            horaire et consignes.
          </span>
        </div>
      )}

      <div className="flex justify-between gap-3 pt-1">
        <button
          onClick={onCancel}
          disabled={cancelling}
          className="inline-flex items-center gap-1.5 text-sm text-red-600 hover:text-red-700 hover:underline disabled:opacity-50"
          data-testid="pickup-details-cancel"
        >
          <XCircle size={14} /> {cancelling ? 'Annulation…' : 'Annuler le ramassage'}
        </button>
        <button onClick={onClose} className="btn-secondary">Fermer</button>
      </div>
    </div>
  )
}
