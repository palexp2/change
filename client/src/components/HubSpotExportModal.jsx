import { useState, useMemo } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Modal } from './Modal.jsx'
import { useConfirm } from './ConfirmProvider.jsx'
import api from '../lib/api.js'
import { fmtDateTime } from '../lib/formatDate.js'

// Modale d'export d'une vue filtrée de contacts vers une liste statique
// HubSpot. Ne crée AUCUN contact dans HubSpot — matche uniquement les
// emails existants. Le rapport final liste les emails non trouvés.
export function HubSpotExportModal({ isOpen, onClose, filteredContacts }) {
  const confirm = useConfirm()
  const [name, setName] = useState(`Segment ERP — ${fmtDateTime(new Date())}`)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [errorDetails, setErrorDetails] = useState(null)

  // Emails uniques, valides, normalisés. La normalisation côté serveur fera
  // la même chose, mais on affiche le compte ici pour la transparence.
  const emails = useMemo(() => {
    const set = new Set()
    for (const c of filteredContacts || []) {
      const e = String(c?.email || '').trim().toLowerCase()
      if (e && e.includes('@')) set.add(e)
    }
    return [...set]
  }, [filteredContacts])

  const totalRows = filteredContacts?.length || 0
  const withoutEmail = totalRows - emails.length

  function handleClose() {
    if (submitting) return
    setResult(null)
    setError('')
    setErrorDetails(null)
    onClose()
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setErrorDetails(null)
    if (!name.trim()) { setError('Nom de liste requis'); return }
    if (emails.length === 0) { setError('Aucun email valide à exporter'); return }

    // Confirmation explicite avant la mutation HubSpot (création de liste +
    // matching des contacts existants — side effect dans un système tiers).
    const listName = name.trim()
    const plural = emails.length > 1
    const ok = await confirm({
      title: 'Confirmer le push vers HubSpot',
      message: (
        <>
          {'Cette action va modifier votre compte HubSpot :'}
          {'\n\n'}
          {`• Création d'une liste statique « ${listName} »`}
          {'\n'}
          {`• ${emails.length} email${plural ? 's' : ''} matché${plural ? 's' : ''} contre les contacts HubSpot existants`}
          {'\n'}
          {'• Ajout des contacts trouvés à la liste (aucun nouveau contact créé)'}
        </>
      ),
      confirmLabel: 'Créer la liste',
      danger: false,
    })
    if (!ok) return

    setSubmitting(true)
    try {
      const r = await api.hubspot.createContactSegment(listName, emails)
      setResult(r)
    } catch (err) {
      setError(err.message || 'Erreur inconnue')
      setErrorDetails(err.details || null)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Exporter vers HubSpot" size="md">
      {result ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-green-200 bg-green-50 p-4">
            <div className="text-sm font-medium text-green-900 mb-2">Liste créée dans HubSpot</div>
            <div className="text-sm text-slate-700 space-y-1">
              <div><span className="text-slate-500">Demandés :</span> {result.requested}</div>
              <div><span className="text-slate-500">Trouvés dans HubSpot :</span> {result.matched}</div>
              <div><span className="text-slate-500">Ajoutés à la liste :</span> {result.added}</div>
              <div><span className="text-slate-500">Non trouvés :</span> {result.not_found}</div>
            </div>
            {result.listUrl && (
              <a
                href={result.listUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-3 text-sm text-brand-600 hover:underline"
              >
                <ExternalLink size={14} /> Ouvrir la liste dans HubSpot
              </a>
            )}
          </div>
          {result.not_found > 0 && result.not_found_sample?.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-slate-600 hover:text-slate-900">
                Emails non trouvés dans HubSpot ({result.not_found_sample.length} premiers affichés)
              </summary>
              <ul className="mt-2 max-h-40 overflow-y-auto space-y-0.5 font-mono text-xs text-slate-500">
                {result.not_found_sample.map(e => <li key={e}>{e}</li>)}
              </ul>
            </details>
          )}
          <div className="flex justify-end pt-2">
            <button onClick={handleClose} className="btn-primary">Fermer</button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Nom de la liste HubSpot</label>
            <input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              className="input"
              required
              disabled={submitting}
            />
          </div>

          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 space-y-2 text-sm">
            <div className="font-medium text-slate-700">Effets de bord</div>
            <ul className="text-slate-600 space-y-1 list-disc list-inside">
              <li>Une liste statique <strong className="font-mono">{name || '(nom)'}</strong> sera créée dans HubSpot.</li>
              <li><strong>{emails.length}</strong> email{emails.length > 1 ? 's' : ''} unique{emails.length > 1 ? 's' : ''} sera{emails.length > 1 ? 'ont' : ''} matché{emails.length > 1 ? 's' : ''} contre les contacts HubSpot existants.</li>
              <li>Seuls les contacts <strong>déjà présents</strong> dans HubSpot seront ajoutés à la liste — aucun nouveau contact créé.</li>
              {withoutEmail > 0 && (
                <li className="text-slate-500">{withoutEmail} contact{withoutEmail > 1 ? 's' : ''} de la vue n'{withoutEmail > 1 ? 'ont' : 'a'} pas d'email et ser{withoutEmail > 1 ? 'ont' : 'a'} ignoré{withoutEmail > 1 ? 's' : ''}.</li>
              )}
            </ul>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
              <div className="font-medium text-red-800">{error}</div>
              {errorDetails?.missing_scopes?.length > 0 && (
                <div className="mt-2 text-red-700">
                  <div>Scope(s) HubSpot manquant(s) :</div>
                  <ul className="list-disc list-inside font-mono text-xs mt-1">
                    {errorDetails.missing_scopes.map(s => <li key={s}>{s}</li>)}
                  </ul>
                </div>
              )}
              {errorDetails?.hint && (
                <div className="mt-2 text-red-700">{errorDetails.hint}</div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={handleClose} className="btn-secondary" disabled={submitting}>Annuler</button>
            <button type="submit" className="btn-primary" disabled={submitting || emails.length === 0}>
              {submitting ? <><Loader2 size={14} className="animate-spin" /> Création…</> : 'Créer la liste HubSpot'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}

export default HubSpotExportModal
