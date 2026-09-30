import { useState } from 'react'
import { Printer } from 'lucide-react'
import api from '../lib/api.js'

// Documents d'installation / de remplacement d'une commande, fusionnés en un
// PDF. Fiche Commande (tous les articles) et fiche Envoi (`shipmentId` : les
// articles de cet envoi seulement).
// `docsLang` = langue proposée par le serveur ({ lang, contact_name }),
// forçable ici par l'opérateur pour cette impression.
// `label` = libellé du bouton (la fiche Commande dit « Documents clients »).
export default function InstallationDocsAction({ orderId, shipmentId, docsLang: proposed, label = "Documents d'installation" }) {
  const [generatingDocs, setGeneratingDocs] = useState(false)
  const [docsError, setDocsError] = useState(null)
  const [docsLangOverride, setDocsLangOverride] = useState(null)
  const docsLang = docsLangOverride || proposed?.lang || 'fr'
  const docsLangHint = docsLangOverride
    ? 'Langue forcée pour cette impression'
    : proposed?.contact_name
      ? `Langue de ${proposed.contact_name} (contact de l'adresse de livraison)`
      : 'Langue par défaut — aucun contact sur l\'adresse de livraison'

  async function handleGenerateInstallationDocs() {
    // Réserver l'onglet pendant le clic pour éviter le blocage des popups.
    const preview = window.open('', '_blank')
    if (!preview) {
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
      setGeneratingDocs(false)
    }
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
        <div className="flex rounded-lg border border-slate-200 bg-white overflow-hidden" title={docsLangHint} role="group" aria-label="Langue des documents">
          {['fr', 'en'].map(l => (
            <button
              key={l}
              onClick={() => setDocsLangOverride(l)}
              disabled={generatingDocs}
              aria-pressed={docsLang === l}
              className={`px-3 py-1.5 text-sm font-semibold transition-colors ${
                docsLang === l ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-50'
              }`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {docsError && <div role="alert" className="text-xs text-red-600">{docsError}</div>}
    </div>
  )
}
