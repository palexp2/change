import { useState } from 'react'
import { Pencil, Trash2, Check, X, Plus } from 'lucide-react'
import api from '../lib/api.js'
import { useConfirm } from './ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { fmtDate, localISODate } from '../lib/formatDate.js'
import { CATEGORIES, CATEGORY_LABELS, CATEGORY_COLORS } from '../lib/subscriptionEvents.js'
import { Badge } from './Badge.jsx'
import { RachatPicker } from './RachatPicker.jsx'

// Préserve la portion horaire du timestamp original quand l'utilisateur ne
// modifie que la date — évite de tasser l'historique vers minuit UTC.
function combineEventDate(newDate, originalIso) {
  const m = (originalIso || '').match(/T(\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/)
  return newDate + 'T' + (m ? m[1] : '12:00:00.000Z')
}

// Formule officielle (alignée sur server/src/services/subscriptionEvents.js
// → recordEvent). Le delta est ce qui contribue au Net MRR du dashboard.
function autoComputeDelta(category, prev, next) {
  if (category === 'creation') return next
  if (category === 'churn') return prev != null ? -prev : null
  if (category === 'reactivation') return next
  if (prev != null && next != null) return next - prev
  return null
}

function parseAmount(s) {
  if (s === '' || s == null) return null
  const v = parseFloat(s)
  return Number.isFinite(v) ? v : null
}

function fmtAmount(v) {
  return v == null ? '' : String(v)
}

export function SubscriptionHistory({ subscriptionId, history, onChanged }) {
  const confirm = useConfirm()
  const { addToast } = useToast()
  const [editingId, setEditingId] = useState(null)
  const [editDate, setEditDate] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [editCurrency, setEditCurrency] = useState('CAD')
  const [editPrev, setEditPrev] = useState('')
  const [editNew, setEditNew] = useState('')
  const [editDelta, setEditDelta] = useState('')
  const [savingEvent, setSavingEvent] = useState(false)
  const [deletingId, setDeletingId] = useState(null)

  function recomputeDelta(cat, prevStr, newStr) {
    const d = autoComputeDelta(cat, parseAmount(prevStr), parseAmount(newStr))
    setEditDelta(d == null ? '' : String(Math.round(d * 100) / 100))
  }

  function onChangeCategory(v) {
    setEditCategory(v)
    recomputeDelta(v, editPrev, editNew)
  }
  function onChangePrev(v) {
    setEditPrev(v)
    recomputeDelta(editCategory, v, editNew)
  }
  function onChangeNew(v) {
    setEditNew(v)
    recomputeDelta(editCategory, editPrev, v)
  }

  function startEditEvent(h) {
    setEditingId(h.id)
    setEditDate((h.date || '').slice(0, 10))
    setEditCategory(h.category || '')
    setEditCurrency(h.currency || 'CAD')
    setEditPrev(fmtAmount(h.previous_amount_cad))
    setEditNew(fmtAmount(h.new_amount_cad))
    setEditDelta(fmtAmount(h.amount_cad_delta))
  }

  function cancelEditEvent() {
    setEditingId(null)
    setEditDate('')
    setEditCategory('')
    setEditCurrency('CAD')
    setEditPrev('')
    setEditNew('')
    setEditDelta('')
  }

  async function saveEvent(originalIso) {
    if (!editingId) return
    setSavingEvent(true)
    try {
      const payload = {
        event_date: combineEventDate(editDate, originalIso),
        category: editCategory || null,
        currency: editCurrency || null,
        previous_amount_cad: parseAmount(editPrev),
        new_amount_cad: parseAmount(editNew),
        amount_cad_delta: parseAmount(editDelta),
      }
      if (editingId === '__new__') {
        await api.abonnements.eventCreate(subscriptionId, payload)
      } else {
        await api.abonnements.eventPatch(subscriptionId, editingId, payload)
      }
      cancelEditEvent()
      onChanged?.()
    } finally {
      setSavingEvent(false)
    }
  }

  // Autosave d'un événement existant : PATCH sur blur de chaque champ. Pas de
  // bouton « Enregistrer » (règle autosave) — seule la création (__new__) garde
  // un bouton car le record n'a pas encore d'id.
  async function autosaveEvent(originalIso) {
    if (!editingId || editingId === '__new__') return
    setSavingEvent(true)
    try {
      const payload = {
        event_date: combineEventDate(editDate, originalIso),
        category: editCategory || null,
        currency: editCurrency || null,
        previous_amount_cad: parseAmount(editPrev),
        new_amount_cad: parseAmount(editNew),
        amount_cad_delta: parseAmount(editDelta),
      }
      await api.abonnements.eventPatch(subscriptionId, editingId, payload)
      onChanged?.()
    } catch (e) {
      addToast({ message: e.message || 'Échec de l\'enregistrement', type: 'error' })
    } finally {
      setSavingEvent(false)
    }
  }

  function startAddEvent() {
    setEditingId('__new__')
    setEditDate(localISODate())
    setEditCategory('')
    setEditCurrency('CAD')
    setEditPrev('')
    setEditNew('')
    setEditDelta('')
  }

  async function handleDeleteEvent(eventId) {
    const ok = await confirm({
      title: 'Supprimer l\'entrée',
      message: 'Cette entrée d\'historique sera supprimée définitivement.',
      confirmLabel: 'Supprimer',
      danger: true,
    })
    if (!ok) return
    setDeletingId(eventId)
    try {
      await api.abonnements.eventDelete(subscriptionId, eventId)
      onChanged?.()
    } finally {
      setDeletingId(null)
    }
  }

  const renderEditRow = (originalIso, rowKey, isNew) => {
    // Édition d'un record existant → autosave on blur. Création (__new__) →
    // bouton manuel (pas encore d'id, exception à la règle autosave).
    const onBlurSave = isNew ? undefined : () => autosaveEvent(originalIso)
    const inputsDisabled = isNew && savingEvent
    return (
    <div key={rowKey} data-testid={rowKey === '__new__' ? 'event-row-new' : `event-row-${rowKey}-edit`} className="px-4 py-3 bg-amber-50/40 space-y-2">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-32 space-y-1.5">
          <input
            type="date"
            value={editDate}
            onChange={e => setEditDate(e.target.value)}
            onBlur={onBlurSave}
            disabled={inputsDisabled}
            className="w-full text-xs border border-slate-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <select
            data-testid="event-category"
            value={editCategory}
            onChange={e => onChangeCategory(e.target.value)}
            onBlur={onBlurSave}
            disabled={inputsDisabled}
            className="w-full text-xs border border-slate-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            <option value="">— aucun mouvement —</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div>
          <label className="block text-[10px] text-slate-500 mb-0.5">Devise</label>
          <input
            data-testid="event-currency"
            type="text"
            value={editCurrency}
            onChange={e => setEditCurrency(e.target.value.toUpperCase().slice(0, 3))}
            onBlur={onBlurSave}
            disabled={inputsDisabled}
            placeholder="CAD"
            className="w-full border border-slate-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono uppercase"
          />
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-0.5">Avant (CAD)</label>
          <input
            data-testid="event-prev-amount"
            type="number"
            step="0.01"
            value={editPrev}
            onChange={e => onChangePrev(e.target.value)}
            onBlur={onBlurSave}
            disabled={inputsDisabled}
            className="w-full border border-slate-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
          />
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-0.5">Après (CAD)</label>
          <input
            data-testid="event-new-amount"
            type="number"
            step="0.01"
            value={editNew}
            onChange={e => onChangeNew(e.target.value)}
            onBlur={onBlurSave}
            disabled={inputsDisabled}
            className="w-full border border-slate-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
          />
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-0.5" title="Contribue au Net MRR du dashboard. Recalculé auto sur changement de Avant/Après/Catégorie ; éditable manuellement.">Δ Net MRR (CAD)</label>
          <input
            data-testid="event-delta"
            type="number"
            step="0.01"
            value={editDelta}
            onChange={e => setEditDelta(e.target.value)}
            onBlur={onBlurSave}
            disabled={inputsDisabled}
            className="w-full border border-slate-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
          />
        </div>
      </div>
      {isNew ? (
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={cancelEditEvent}
            disabled={savingEvent}
            className="text-xs px-3 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={() => saveEvent(originalIso)}
            disabled={savingEvent}
            data-testid="event-save"
            className="text-xs px-3 py-1 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 inline-flex items-center gap-1"
          >
            <Check size={12} /> {savingEvent ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      ) : (
        <div className="flex justify-end items-center gap-2">
          <span className="text-[10px] text-slate-400" data-testid="event-autosave-status">
            {savingEvent ? 'Enregistrement…' : 'Enregistré automatiquement'}
          </span>
          <button
            type="button"
            onClick={cancelEditEvent}
            data-testid="event-done"
            className="text-xs px-3 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1"
          >
            <Check size={12} /> Terminé
          </button>
        </div>
      )}
    </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-slate-700">Historique des changements</h4>
        <button
          type="button"
          onClick={startAddEvent}
          disabled={editingId !== null}
          data-testid="event-add"
          className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-30 inline-flex items-center gap-1"
        >
          <Plus size={12} /> Ajouter une entrée
        </button>
      </div>
      <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
        {editingId === '__new__' && renderEditRow(null, '__new__', true)}
        {!history?.length && editingId !== '__new__' && (
          <div className="px-4 py-3 text-xs text-slate-400 italic">Aucune entrée d'historique.</div>
        )}
        {history?.map((h, i) => {
          const rowKey = h.id || i
          if (h.id && editingId === h.id) {
            return renderEditRow(h.date, h.id, false)
          }
          const isDeleting = deletingId === h.id
          return (
            <div key={rowKey} data-testid={h.id ? `event-row-${h.id}` : undefined} className="group flex items-start gap-3 px-4 py-2.5 text-sm">
              <div className="flex-shrink-0 pt-0.5 w-32 space-y-1">
                <div className="text-xs text-slate-400">{fmtDate(h.date)}</div>
                {h.category
                  ? <Badge color={CATEGORY_COLORS[h.category] || 'gray'}>{CATEGORY_LABELS[h.category] || h.category}</Badge>
                  : <span className="text-[10px] text-slate-400">— aucun mouvement —</span>
                }
              </div>
              <div className="flex-1 space-y-1">
                {h.amount_cad_delta != null && (
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    Δ MRR : {h.amount_cad_delta >= 0 ? '+' : ''}{h.amount_cad_delta.toFixed(2)} CAD
                  </div>
                )}
                {h.category === 'churn' && h.id && (
                  <RachatPicker event={h} />
                )}
              </div>
              {h.id && (
                <div className="flex-shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => startEditEvent(h)}
                    disabled={isDeleting || editingId !== null}
                    data-testid="event-edit"
                    title="Modifier"
                    className="p-1 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-700 disabled:opacity-30"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteEvent(h.id)}
                    disabled={isDeleting || editingId !== null}
                    data-testid="event-delete"
                    title="Supprimer"
                    className="p-1 rounded hover:bg-red-50 text-slate-500 hover:text-red-600 disabled:opacity-30"
                  >
                    {isDeleting ? <X size={13} className="animate-pulse" /> : <Trash2 size={13} />}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
