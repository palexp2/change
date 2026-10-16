import { useEffect, useState } from 'react'
import { Printer, FileText } from 'lucide-react'
import api from '../lib/api.js'
import { holdReload } from '../lib/serverStatus.js'
import AttachmentPreview from './AttachmentPreview.jsx'
import Spinner from './Spinner.jsx'

// Documents d'installation / de remplacement d'une commande, fusionnés en un
// PDF. Fiche Commande (tous les articles) et fiche Envoi (`shipmentId` : les
// articles de cet envoi seulement).
// `docsLang` = langue proposée par le serveur ({ lang, contact_name }),
// forçable ici par l'opérateur pour cette impression.
// `label` = libellé du bouton (la fiche Commande dit « Documents clients »).
// `thumbnail` : au lieu du bouton, le PDF est généré d'office et montré en
// vignette ; un clic l'ouvre en modale. `refreshKey` le régénère quand les
// articles changent.
export default function InstallationDocsAction({ orderId, shipmentId, docsLang: proposed, label = "Documents d'installation", thumbnail = false, refreshKey }) {
  const [generatingDocs, setGeneratingDocs] = useState(false)
  const [docsError, setDocsError] = useState(null)
  const [docsLangOverride, setDocsLangOverride] = useState(null)
  const [thumbUrl, setThumbUrl] = useState(null)
  const docsLang = docsLangOverride || proposed?.lang || 'fr'
  const docsLangHint = docsLangOverride
    ? 'Langue forcée pour cette impression'
    : proposed?.contact_name
      ? `Langue de ${proposed.contact_name} (contact de l'adresse de livraison)`
      : 'Langue par défaut — aucun contact sur l\'adresse de livraison'

  useEffect(() => {
    if (!thumbnail) return
    let cancelled = false
    let url = null
    setGeneratingDocs(true)
    setDocsError(null)
    setThumbUrl(null)
    api.orders.generateInstallationDocsBlob(orderId, docsLang, shipmentId)
      .then(({ blob }) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setThumbUrl(url)
      })
      .catch(e => { if (!cancelled) setDocsError(e.message || 'Erreur lors de la génération des documents') })
      .finally(() => { if (!cancelled) setGeneratingDocs(false) })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [thumbnail, orderId, shipmentId, docsLang, refreshKey])

  async function handleGenerateInstallationDocs() {
    // L'onglet de la fiche passe en arrière-plan : une nouvelle version en
    // attente le rechargerait et couperait la génération.
    const release = holdReload()
    // Réserver l'onglet pendant le clic pour éviter le blocage des popups.
    const preview = window.open('', '_blank')
    if (!preview) {
      release()
      setDocsError("Autorisez les fenêtres surgissantes pour ouvrir les documents.")
      return
    }
    preview.opener = null
    setGeneratingDocs(true)
    setDocsError(null)
    try {
      const { blob } = await api.orders.generateInstallationDocsBlob(orderId, docsLang, shipmentId)
      const url = URL.createObjectURL(blob)
      preview.location.href = url
      // Note: ne pas révoquer immédiatement — le nouvel onglet en a besoin
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (e) {
      preview.close()
      setDocsError(e.message || 'Erreur lors de la génération des documents')
    } finally {
      release()
      setGeneratingDocs(false)
    }
  }

  const langToggle = (
    <div className="flex rounded-lg border border-slate-200 bg-white overflow-hidden" title={docsLangHint} role="group" aria-label="Langue des documents">
      {['fr', 'en'].map(l => (
        <button
          key={l}
          onClick={() => setDocsLangOverride(l)}
          disabled={generatingDocs}
          aria-pressed={docsLang === l}
          className={`${thumbnail ? 'px-2 py-0.5 text-xs' : 'px-3 py-1.5 text-sm'} font-semibold transition-colors ${
            docsLang === l ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-50'
          }`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  )

  if (thumbnail) {
    return (
      <div className="flex items-start gap-2" data-testid="installation-docs">
        {thumbUrl ? (
          <AttachmentPreview
            url={thumbUrl}
            kind="pdf"
            title={label}
            fileName={`documents-${docsLang}.pdf`}
            showFileName={false}
            testId="installation-docs-preview"
          />
        ) : (
          <div
            className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-slate-200 text-slate-400 text-center px-1"
            style={{ width: 92, height: 120 }}
            title={docsError || undefined}
            role={docsError ? 'alert' : undefined}
          >
            {generatingDocs ? <Spinner size="sm" /> : <><FileText size={18} /><span className="text-[11px]">Aucun document</span></>}
          </div>
        )}
        {langToggle}
      </div>
    )
  }

  return (
    <div className="space-y-2" data-testid="installation-docs">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={handleGenerateInstallationDocs}
          disabled={generatingDocs}
          className="btn-secondary btn-sm flex items-center gap-1.5"
          title={shipmentId
            ? "Documents d'installation et de remplacement des articles de cet envoi"
            : "Ouvrir les documents d'installation et de remplacement de la commande pour les imprimer"}
        >
          <Printer size={14} />
          {generatingDocs ? 'Génération…' : label}
        </button>
        {langToggle}
      </div>
      {docsError && <div role="alert" className="text-xs text-red-600">{docsError}</div>}
    </div>
  )
}
