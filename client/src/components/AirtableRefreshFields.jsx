import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import api from '../lib/api.js'
import { invalidate } from '../lib/prefetch.js'

// « Rafraîchir » épinglé au bas de TOUT menu de sélection d'un champ Airtable
// (mapping dynamique d'une colonne comme clé de mapping « cœur »). Le serveur
// garde les métadonnées d'une base Airtable 60 s en mémoire : un champ créé à
// l'instant côté Airtable n'apparaissait donc pas dans la liste, sans autre
// recours que d'attendre. Ce bouton fait oublier ces métadonnées et recharge —
// le menu reste ouvert, la nouvelle option s'y ajoute.
//
// Fichier à part (et non dans AirtableModuleFields) pour ne pas créer de cycle
// d'import avec AirtableCoreMapModal, qui l'utilise aussi.

// Purge le cache serveur puis le cache prefetch du client. `module` peut être
// null : le serveur vide alors tout ce qu'il a mémorisé.
export async function refreshAirtableSchema(module) {
  await api.airtable.refreshSchema(module || null)
  invalidate('/connectors')
}

export function RefreshFieldsButton({ onClick, refreshing, testId }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={refreshing}
      title="Relire les champs de la table Airtable (pour voir un champ qui vient d'y être créé)"
      className="w-full text-left px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50 hover:text-brand-700 rounded flex items-center gap-2 disabled:opacity-50"
    >
      <RefreshCw size={12} className={`flex-shrink-0 ${refreshing ? 'animate-spin' : ''}`} />
      <span className="truncate">Rafraîchir</span>
    </button>
  )
}

// Version autonome : porte son propre état « en cours » et son erreur. Pour les
// pickers qui n'ont qu'un rechargement à fournir.
export function useRefreshFields(onRefresh) {
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  async function run() {
    if (!onRefresh || refreshing) return
    setRefreshing(true)
    setError(null)
    try { await onRefresh() } catch (e) { setError(e.message || 'Erreur') }
    finally { setRefreshing(false) }
  }
  return { refreshing, error, run }
}

export default RefreshFieldsButton
