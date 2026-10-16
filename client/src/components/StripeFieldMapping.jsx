import { useState, useEffect, useMemo, useCallback } from 'react'
import { RefreshCw, Lock, RotateCcw } from 'lucide-react'
import api from '../lib/api.js'
import { SearchableSelect } from './SearchableSelect.jsx'
import { SyncDetails } from './SyncDetails.jsx'

// Correspondance des champs Stripe, fusionnée dans la page des champs
// (/champs/:table, colonne « Champ Stripe ») — ex-modales « Sync Stripe » de
// /factures et /abonnements. Chaque colonne ERP alimentée par Stripe y porte
// le champ de l'objet Stripe choisi parmi les candidats du serveur ; les
// champs à logique fixe (statut, entreprise…) s'affichent cadenassés.
// Le choix s'enregistre tout de suite (comme la cellule Airtable voisine) ; le
// ré-import reste explicite — bouton de l'en-tête « Source Stripe ».

const CONFIGS = {
  factures: {
    load: () => api.stripeQueue.factureFieldMap(),
    save: map => api.stripeQueue.saveFactureFieldMap(map),
    resyncTitle: 'Repasse toutes les factures Stripe avec la correspondance actuelle (plusieurs minutes)',
    resync: () => api.stripeQueue.batchEnrich(),
    resyncMsg: 'Ré-import lancé',
  },
  abonnements: {
    load: () => api.stripeQueue.subscriptionFieldMap(),
    save: map => api.stripeQueue.saveSubscriptionFieldMap(map),
    resyncTitle: 'Importer tous les abonnements depuis Stripe avec la correspondance actuelle',
    resync: () => api.stripe.sync(),
    resyncMsg: 'Synchronisation terminée',
  },
}

export function hasStripeMapping(table) {
  return !!CONFIGS[table]
}

export function useStripeMap(table) {
  const config = CONFIGS[table] || null
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [savingKey, setSavingKey] = useState(null)

  const load = useCallback(() => {
    if (!config) return
    config.load().then(setData).catch(e => setError(e.message))
  }, [config])
  useEffect(() => { load() }, [load])

  // colonne ERP → spec configurable / entrée fixe
  const byColumn = useMemo(() => {
    const m = new Map()
    for (const f of (data?.fields || [])) if (f.column) m.set(f.column, f)
    return m
  }, [data])
  const fixedByColumn = useMemo(() => {
    const m = new Map()
    for (const f of (data?.fixed || [])) for (const c of (f.columns || [])) m.set(c, f)
    return m
  }, [data])

  async function pick(key, path) {
    if (!config || !data) return
    setSavingKey(key); setError('')
    try {
      const r = await config.save({ ...data.field_map, [key]: path })
      setData(d => ({ ...d, field_map: r.field_map }))
    } catch (e) {
      setError(e.message)
    } finally {
      setSavingKey(null)
    }
  }

  return { config, data, error, byColumn, fixedByColumn, savingKey, pick, reload: load }
}

// Cellule « Champ Stripe » d'une ligne de la page des champs.
export function StripeFieldCell({ stripe, column }) {
  const f = stripe.byColumn.get(column)
  const fixed = !f && stripe.fixedByColumn.get(column)
  if (fixed) {
    return (
      <span
        className="flex items-center gap-1 text-[11px] text-slate-600 cursor-help min-w-0"
        title={fixed.source}
        data-testid={`stripemap-fixed-${column}`}
      >
        <Lock size={11} className="flex-shrink-0" />
        <span className="truncate font-mono">{fixed.source.split(' — ')[0]}</span>
      </span>
    )
  }
  if (!f) return <span className="text-[11px] text-slate-600">—</span>
  const value = stripe.data.field_map[f.key] || ''
  return (
    <div className="min-w-0">
      <SearchableSelect
        value={value}
        onChange={v => stripe.pick(f.key, v || '')}
        options={f.candidates}
        getOptionValue={o => o.path}
        getOptionLabel={o => o.label}
        getOptionKey={o => o.path}
        emptyOption={f.custom ? 'Non synchronisé' : undefined}
        disabled={stripe.savingKey === f.key}
        searchPlaceholder="Rechercher un champ…"
        testId={`stripemap-${f.key}`}
      />
      {value !== (f.default || '') && (
        <button
          type="button"
          onClick={() => stripe.pick(f.key, f.default || '')}
          className="max-w-full text-[11px] text-slate-600 hover:text-slate-900 mt-0.5 inline-flex items-center gap-1"
          title={`Revenir au défaut : ${f.default || 'non synchronisé'}`}
          data-testid={`stripemap-${f.key}-reset`}
        >
          <RotateCcw size={11} className="flex-shrink-0" />
          <span className="truncate">{f.default || 'non synchronisé'}</span>
        </button>
      )}
    </div>
  )
}

// En-tête « Source Stripe » : déclenchement + ré-import explicite.
export function StripeSourceStatus({ table, stripe, onResynced, showSyncDetails = true }) {
  const [running, setRunning] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const { config } = stripe

  async function resync() {
    setRunning(true); setMsg(''); setErr('')
    try {
      await config.resync()
      setMsg(config.resyncMsg)
      onResynced?.()
    } catch (e) {
      setErr(e.message)
    } finally {
      setRunning(false)
    }
  }

  // Même gabarit et mêmes mots que l'en-tête « Source Airtable » (ModuleSourceStatus).
  const ready = !!stripe.data && !stripe.error
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4" data-testid="fieldcfg-stripe-source">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-800">Source Stripe</h2>
          <div className="text-xs text-slate-600 flex items-center gap-2 mt-0.5">
            <span className={`w-1.5 h-1.5 rounded-full ${ready ? 'bg-green-500' : 'bg-amber-400'}`} />
            <span className={ready ? '' : 'text-amber-600'}>{ready ? 'Configurée' : stripe.error ? 'Indisponible' : 'Chargement…'}</span>
            {running && <span className="text-amber-600 font-medium animate-pulse">Synchronisation en cours…</span>}
          </div>
          {showSyncDetails && <div className="mt-2"><SyncDetails table={table} connector="Stripe" /></div>}
        </div>
        <button
          onClick={resync}
          disabled={running || !ready}
          className="btn-primary btn-sm flex items-center gap-1.5 flex-shrink-0"
          title={config.resyncTitle}
          data-testid="stripemap-resync"
        >
          <RefreshCw size={13} className={running ? 'animate-spin' : ''} />
          {running ? 'Synchronisation…' : 'Synchroniser'}
        </button>
      </div>
      {(msg || err || stripe.error) && (
        <p className={`text-xs mt-2 ${msg && !err && !stripe.error ? 'text-green-700' : 'text-red-600'}`}>
          {err || stripe.error || msg}
        </p>
      )}
    </div>
  )
}
