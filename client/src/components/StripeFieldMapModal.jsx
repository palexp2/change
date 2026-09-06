import { useState, useEffect, useMemo } from 'react'
import { RefreshCw, AlertCircle, CheckCircle2, ArrowLeft, Lock, RotateCcw } from 'lucide-react'
import api from '../lib/api.js'
import { Modal } from './Modal.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import { SyncDetails } from './SyncDetails.jsx'
import Spinner from './Spinner.jsx'

// Modales de mapping des champs Stripe (pendant Stripe de AirtableCoreMapModal).
// Chaque ligne = colonne ERP fixe ← champ de l'objet Stripe choisi parmi les
// candidats proposés par le serveur. Les champs à logique fixe (statut,
// entreprise, montant…) sont listés en lecture seule. Deux variantes pilotées
// par une config :
// - StripeFieldMapModal            : Stripe Invoice → factures (/factures,
//   routes /stripe-queue/facture-field-map, specs stripeFactureFieldMap.js)
// - StripeSubscriptionFieldMapModal : Stripe Subscription → subscriptions
//   (/abonnements, routes /stripe-queue/subscription-field-map, specs
//   stripeSubscriptionFieldMap.js)

const FACTURES_CONFIG = {
  prefix: 'stripemap',
  table: 'factures', // table ERP alimentée — détails de sync (SyncDetails) en tête de modale
  description: "Chaque colonne ERP ci-dessous est alimentée par le champ choisi de l'objet Stripe Invoice lors de la synchronisation (webhooks temps réel et ré-import batch).",
  sourceLabel: 'Champ Stripe',
  load: () => api.stripeQueue.factureFieldMap(),
  save: draft => api.stripeQueue.saveFactureFieldMap(draft),
  resyncLabel: 'Ré-importer toutes les factures Stripe après enregistrement',
  resyncTitle: 'Repasse toutes les factures Stripe avec le nouveau mapping (peut prendre plusieurs minutes)',
  resyncDefault: false,
  runResync: () => api.stripeQueue.batchEnrich().catch(() => {}),
  savedResyncMsg: 'Mapping enregistré — ré-import Stripe lancé en arrière-plan.',
  savedMsg: 'Mapping enregistré — appliqué aux prochaines synchronisations Stripe.',
}

const SUBSCRIPTIONS_CONFIG = {
  prefix: 'stripesubmap',
  table: 'abonnements',
  description: "Chaque colonne ERP ci-dessous est alimentée par le champ choisi de l'objet Stripe Subscription lors de la synchronisation (webhooks temps réel et sync manuelle).",
  sourceLabel: 'Champ Stripe',
  load: () => api.stripeQueue.subscriptionFieldMap(),
  save: draft => api.stripeQueue.saveSubscriptionFieldMap(draft),
  resyncLabel: 'Resynchroniser les abonnements après enregistrement',
  resyncTitle: 'Ré-importe tous les abonnements Stripe avec le nouveau mapping',
  resyncDefault: true,
  runResync: () => api.stripe.sync().catch(() => {}),
  savedResyncMsg: 'Mapping enregistré — resynchronisation des abonnements lancée en arrière-plan.',
  savedMsg: 'Mapping enregistré — appliqué aux prochaines synchronisations Stripe.',
}

export function StripeFieldMapModal({ isOpen, onClose, onSaved }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Mapping des champs Stripe" size="lg">
      {isOpen && <StripeFieldMapPane onSaved={onSaved} config={FACTURES_CONFIG} />}
    </Modal>
  )
}

// Variante abonnements — `onSyncNow` (optionnel) : sync manuelle immédiate,
// affichée comme bouton secondaire dans le pied de la modale (remplace l'ancien
// bouton « Sync Stripe » direct de la page /abonnements).
export function StripeSubscriptionFieldMapModal({ isOpen, onClose, onSaved, onSyncNow }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Mapping des champs Stripe" size="lg">
      {isOpen && <StripeFieldMapPane onSaved={onSaved} onSyncNow={onSyncNow} config={SUBSCRIPTIONS_CONFIG} />}
    </Modal>
  )
}

// Une ligne colonne ERP ← champ Stripe. Pour les champs personnalisés
// (f.custom, défaut '' = non synchronisé), le select offre une entrée vide
// « Non synchronisé » et le bouton de reset revient à cet état.
function FieldRow({ f, prefix, draft, setDraft, setSavedMsg }) {
  return (
    // minmax(0,1fr) (et non 1fr, dont le minimum implicite est min-content) :
    // un libellé Stripe long et insécable élargirait sa colonne et casserait
    // l'alignement — on contraint, et chaque cellule tronque avec tooltip.
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-3 items-start">
      <div className="pt-1.5 min-w-0">
        <div className="text-sm text-slate-700 truncate" title={f.label}>{f.label}</div>
        {f.hint && <div className="text-[11px] text-slate-400 mt-0.5">{f.hint}</div>}
      </div>
      <span
        title="Stripe → ERP — import seulement, jamais réécrit vers Stripe"
        className="inline-flex pt-2 cursor-help text-slate-400"
      >
        <ArrowLeft size={13} />
      </span>
      <div className="min-w-0">
        <SearchableSelect
          className="input"
          size="sm"
          value={draft[f.key] || ''}
          onChange={v => { setDraft(d => ({ ...d, [f.key]: v })); setSavedMsg('') }}
          options={f.candidates}
          getOptionValue={o => o.path}
          getOptionLabel={o => o.label}
          getOptionKey={o => o.path}
          emptyOption={f.custom ? 'Non synchronisé (défaut)' : undefined}
          placeholder={f.custom ? 'Non synchronisé' : '—'}
          searchPlaceholder="Rechercher un champ…"
          testId={`${prefix}-${f.key}`}
        />
        {draft[f.key] && draft[f.key] !== f.default && (
          <button
            type="button"
            onClick={() => { setDraft(d => ({ ...d, [f.key]: f.default })); setSavedMsg('') }}
            className="max-w-full text-[11px] text-slate-500 hover:text-slate-700 mt-0.5 inline-flex items-center gap-1"
            title={`Revenir au champ Stripe par défaut : ${f.default || 'non synchronisé'}`}
            data-testid={`${prefix}-${f.key}-reset`}
          >
            <RotateCcw size={11} className="flex-shrink-0" />
            <span className="truncate">Défaut : {f.default || 'non synchronisé'}</span>
          </button>
        )}
      </div>
    </div>
  )
}

function StripeFieldMapPane({ onSaved, onSyncNow, config }) {
  const { prefix } = config
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [draft, setDraft] = useState({})
  const [resyncAfter, setResyncAfter] = useState(config.resyncDefault)
  const [saving, setSaving] = useState(false)
  const [syncingNow, setSyncingNow] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedMsg, setSavedMsg] = useState('')

  useEffect(() => {
    config.load()
      .then(d => { setData(d); setDraft({ ...d.field_map }) })
      .catch(e => setLoadError(e.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => {
    if (!data) return false
    return data.fields.some(f => (draft[f.key] || '') !== (data.field_map[f.key] || ''))
  }, [data, draft])

  async function save() {
    setSaving(true); setSaveError(''); setSavedMsg('')
    try {
      const r = await config.save(draft)
      setData(d => ({ ...d, field_map: r.field_map }))
      setDraft({ ...r.field_map })
      if (resyncAfter) {
        config.runResync()
        setSavedMsg(config.savedResyncMsg)
      } else {
        setSavedMsg(config.savedMsg)
      }
      onSaved?.()
    } catch (e) {
      setSaveError(e.message)
    } finally {
      setSaving(false)
    }
  }

  // Sync manuelle immédiate (variante abonnements) — attend la fin réelle du
  // sync côté serveur (le parent fournit le polling) avant de confirmer.
  async function syncNow() {
    setSyncingNow(true); setSaveError(''); setSavedMsg('')
    try {
      await onSyncNow()
      setSavedMsg('Synchronisation Stripe terminée.')
    } catch (e) {
      setSaveError(e.message)
    } finally {
      setSyncingNow(false)
    }
  }

  // Détails de sync de la table ERP alimentée — affichés en tête du panneau,
  // y compris pendant le chargement et en cas d'erreur.
  const syncDetails = <SyncDetails table={config.table} connector="Stripe" />

  if (loadError) {
    return (
      <div className="space-y-4">
        {syncDetails}
        <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> {loadError}
        </div>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="space-y-4">
        {syncDetails}
        <p className="text-sm text-slate-400 py-6 text-center"><Spinner size="xs" label="Chargement…" /></p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {syncDetails}
      <p className="text-xs text-slate-500">{config.description}</p>

      <div className="space-y-2.5">
        {/* En-têtes de colonnes (à la Airtable) : colonne ERP à gauche, champ Stripe à droite */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-3 pb-1.5 border-b border-slate-200" data-testid={`${prefix}-headers`}>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Champ ERP</div>
          {/* Colonne centrale : sens du mapping (toujours Stripe → ERP) — invisible pour caler la largeur */}
          <div aria-hidden="true" className="invisible"><ArrowLeft size={13} /></div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{config.sourceLabel}</div>
        </div>
        {data.fields.filter(f => !f.custom).map(f => (
          <FieldRow key={f.key} f={f} prefix={prefix} draft={draft} setDraft={setDraft} setSavedMsg={setSavedMsg} />
        ))}
      </div>

      {/* Champs personnalisés (kind='data') — tout champ de l'ERP doit pouvoir
          être mappé. Non synchronisés par défaut. */}
      {data.fields.some(f => f.custom) && (
        <div className="space-y-2.5 pt-1" data-testid={`${prefix}-custom`}>
          <div className="pb-1.5 border-b border-slate-200">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Champs personnalisés</div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              Non synchronisés par défaut — choisir un champ Stripe pour les alimenter à chaque sync.
            </div>
          </div>
          {data.fields.filter(f => f.custom).map(f => (
            <FieldRow key={f.key} f={f} prefix={prefix} draft={draft} setDraft={setDraft} setSavedMsg={setSavedMsg} />
          ))}
        </div>
      )}

      {/* Champs à logique fixe — affichés pour la visibilité, non configurables */}
      <div className="pt-1" data-testid={`${prefix}-fixed`}>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5 flex items-center gap-1">
          <Lock size={11} /> Champs à logique fixe
        </div>
        <div className="space-y-1">
          {data.fixed.map(f => (
            <div key={f.label} className="grid grid-cols-[1fr_2fr] gap-3 text-[11px]">
              <span className="text-slate-500">{f.label}</span>
              <span className="text-slate-400 font-mono truncate" title={f.source}>{f.source}</span>
            </div>
          ))}
        </div>
      </div>

      {saveError && <p className="text-sm text-red-600">{saveError}</p>}
      {savedMsg && (
        <p className="text-sm text-green-700 flex items-center gap-1.5" data-testid={`${prefix}-saved`}>
          <CheckCircle2 size={14} /> {savedMsg}
        </p>
      )}

      <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
        <label className="flex items-center gap-2 text-xs text-slate-600" title={config.resyncTitle}>
          <input
            type="checkbox"
            checked={resyncAfter}
            onChange={e => setResyncAfter(e.target.checked)}
            data-testid={`${prefix}-reimport`}
          />
          {config.resyncLabel}
        </label>
        <div className="flex items-center gap-2 flex-shrink-0">
          {onSyncNow && (
            <button
              onClick={syncNow}
              disabled={syncingNow || saving}
              className="btn-secondary btn-sm"
              title="Importer immédiatement tous les abonnements depuis Stripe avec le mapping enregistré"
              data-testid={`${prefix}-sync-now`}
            >
              <RefreshCw size={13} className={syncingNow ? 'animate-spin' : ''} />
              {syncingNow ? 'Synchronisation…' : 'Synchroniser maintenant'}
            </button>
          )}
          {/* Pas d'autosave : changer le mapping est transactionnel (peut déclencher
              un ré-import complet) — enregistrement explicite, comme AirtableCoreMapModal. */}
          <button
            onClick={save}
            disabled={saving || syncingNow || !dirty}
            className="btn-primary btn-sm"
            data-testid={`${prefix}-save`}
          >
            {saving ? <RefreshCw size={13} className="animate-spin" /> : null}
            {saving ? 'Enregistrement…' : 'Enregistrer le mapping'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default StripeFieldMapModal
