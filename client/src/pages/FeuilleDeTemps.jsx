import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Plus, Trash2, Clock, Search, X } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useAuth } from '../lib/auth.jsx'
import { parseDurationToMinutes, formatMinutes, weekKey } from '../lib/duration.js'

const inp = 'w-full border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-900 focus:outline-none focus:border-brand-400 bg-white'

function todayStr() { return new Date().toISOString().slice(0, 10) }
function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}
function weekdayLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('fr-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}
function timeToMin(t) {
  if (!t || typeof t !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(t)
  if (!m) return null
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}
function minToTime(min) {
  if (min == null || !Number.isFinite(min)) return ''
  const t = ((Math.round(min) % (24 * 60)) + 24 * 60) % (24 * 60)
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

// ---- Reusable searchable picker for FK (company / activity code) ----
// Rendered via portal so the popup isn't clipped by its scrolling ancestor (table wrapper).
function RefPicker({ value, items, labelOf, placeholder, onChange, disabled, autoFocus }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const btnRef = useRef(null)
  const popupRef = useRef(null)
  const highlightRef = useRef(null)

  useEffect(() => {
    if (autoFocus) btnRef.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    if (!open) return
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) {
      const popupH = 280
      const spaceBelow = window.innerHeight - rect.bottom
      const openUp = spaceBelow < popupH && rect.top > popupH
      setPos({
        top: openUp ? rect.top - popupH - 4 : rect.bottom + 4,
        left: rect.left,
        width: Math.max(rect.width, 240),
      })
    }
    const onDown = (e) => {
      if (!btnRef.current?.contains(e.target) && !popupRef.current?.contains(e.target)) {
        setOpen(false)
        setQuery('')
      }
    }
    const onReposition = () => {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      const popupH = 280
      const spaceBelow = window.innerHeight - r.bottom
      const openUp = spaceBelow < popupH && r.top > popupH
      setPos({
        top: openUp ? r.top - popupH - 4 : r.bottom + 4,
        left: r.left,
        width: Math.max(r.width, 240),
      })
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onReposition, true)
    window.addEventListener('resize', onReposition)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onReposition, true)
      window.removeEventListener('resize', onReposition)
    }
  }, [open])

  const q = query.trim().toLowerCase()
  const filtered = (q ? items.filter(it => labelOf(it).toLowerCase().includes(q)) : items).slice(0, 100)
  const selected = items.find(it => it.id === value)

  // Reset highlight quand la liste filtrée change
  useEffect(() => {
    setHighlightIdx(i => Math.min(i, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  // Scroll l'item courant en vue
  useEffect(() => {
    if (open && highlightRef.current) highlightRef.current.scrollIntoView({ block: 'nearest' })
  }, [highlightIdx, open])

  const closeAndFocusBtn = () => {
    setOpen(false)
    setQuery('')
    setHighlightIdx(0)
    btnRef.current?.focus()
  }
  const selectAt = (idx) => {
    const it = filtered[idx]
    if (!it) return
    onChange(it.id)
    closeAndFocusBtn()
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (disabled) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlightIdx(0)
            setOpen(true)
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setHighlightIdx(0)
            setOpen(o => !o)
          } else if (e.key === 'Escape') {
            if (open) { e.preventDefault(); setOpen(false); setQuery('') }
          } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            // Caractère imprimable → ouvre + démarre le filtrage
            e.preventDefault()
            setQuery(e.key)
            setHighlightIdx(0)
            setOpen(true)
          }
        }}
        disabled={disabled}
        className={`${inp} text-left flex items-center justify-between`}
      >
        <span className={selected ? 'text-slate-900 truncate' : 'text-slate-400 truncate'}>{selected ? labelOf(selected) : (placeholder || '—')}</span>
        <span className="text-slate-300 text-xs ml-1 flex-shrink-0">▾</span>
      </button>
      {open && createPortal(
        <div
          ref={popupRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
          className="bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden"
        >
          <div className="p-2 border-b border-slate-100 flex items-center gap-2">
            <Search size={12} className="text-slate-400" />
            <input
              autoFocus
              className="w-full text-sm focus:outline-none"
              placeholder="Rechercher…"
              value={query}
              onChange={e => { setQuery(e.target.value); setHighlightIdx(0) }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setHighlightIdx(i => Math.min(filtered.length - 1, i + 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setHighlightIdx(i => Math.max(0, i - 1))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  selectAt(highlightIdx)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  closeAndFocusBtn()
                } else if (e.key === 'Tab') {
                  setOpen(false)
                  setQuery('')
                }
              }}
            />
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            <button type="button" onClick={() => { onChange(null); closeAndFocusBtn() }} className="w-full text-left px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-50 italic">— aucun —</button>
            {filtered.length === 0
              ? <div className="px-3 py-2 text-xs text-slate-500">Aucun résultat</div>
              : filtered.map((it, i) => {
                const isHighlighted = i === highlightIdx
                const isSelected = value === it.id
                return (
                  <button
                    key={it.id}
                    type="button"
                    ref={isHighlighted ? highlightRef : null}
                    onClick={() => selectAt(i)}
                    onMouseEnter={() => setHighlightIdx(i)}
                    className={`w-full text-left px-3 py-1.5 text-sm truncate ${isHighlighted ? 'bg-slate-100' : ''} ${isSelected ? 'text-brand-700' : 'text-slate-700'}`}
                  >
                    {labelOf(it)}
                  </button>
                )
              })
            }
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

// ---- Duration input — accepts "90" / "1:30", shows H:MM on blur ----
function DurationInput({ minutes, onCommit, disabled }) {
  const [raw, setRaw] = useState(formatMinutes(minutes || 0))
  useEffect(() => { setRaw(formatMinutes(minutes || 0)) }, [minutes])
  const commit = () => {
    const parsed = parseDurationToMinutes(raw)
    if (parsed == null) {
      setRaw(formatMinutes(minutes || 0))
      return
    }
    setRaw(formatMinutes(parsed))
    if (parsed !== (minutes || 0)) onCommit(parsed)
  }
  return (
    <input
      className={inp + ' text-right w-24'}
      value={raw}
      onChange={e => setRaw(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      disabled={disabled}
    />
  )
}

// Parse "8:30", "08:30", "8h30", "8h", "8" → "HH:MM" (or null si invalide)
function parseTimeInput(raw) {
  if (raw == null) return null
  const v = String(raw).trim()
  if (!v) return ''
  let m = /^(\d{1,2}):(\d{2})$/.exec(v)
  if (!m) m = /^(\d{1,2})h(\d{0,2})$/.exec(v)
  if (!m) m = /^(\d{1,2})$/.exec(v) ? [v, v, '0'] : null
  if (!m) return null
  const h = parseInt(m[1], 10)
  const min = m[2] ? parseInt(m[2], 10) : 0
  if (!Number.isFinite(h) || !Number.isFinite(min) || h >= 24 || min >= 60) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

// Ne garde que chiffres et ":" (utile pour onChange / paste)
const sanitizeTimeInput = (raw) => String(raw || '').replace(/[^\d:]/g, '')

// ---- Plain text time input — pas de picker natif, parsing manuel ----
function TimeTextInput({ value, onCommit, disabled, title }) {
  const [local, setLocal] = useState(value || '')
  useEffect(() => { setLocal(value || '') }, [value])
  const commit = () => {
    if ((local || '') === (value || '')) return
    const parsed = parseTimeInput(local)
    if (parsed === null) { setLocal(value || ''); return }
    setLocal(parsed)
    onCommit(parsed)
  }
  return (
    <input
      type="text"
      className={inp + ' w-24 tabular-nums'}
      value={local}
      inputMode="numeric"
      onChange={e => setLocal(sanitizeTimeInput(e.target.value))}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      disabled={disabled}
      title={title}
    />
  )
}

// ---- End-time input — user types an end time, we derive duration from startMin ----
function EndTimeInput({ value, startMin, onCommitDuration, disabled }) {
  const [local, setLocal] = useState(value || '')
  useEffect(() => { setLocal(value || '') }, [value])
  const commit = () => {
    if ((local || '') === (value || '')) return
    const parsed = parseTimeInput(local)
    if (!parsed) { setLocal(value || ''); return }
    const endMin = timeToMin(parsed)
    if (endMin == null || startMin == null || endMin < startMin) {
      setLocal(value || '')
      return
    }
    setLocal(parsed)
    onCommitDuration(endMin - startMin)
  }
  return (
    <input
      type="text"
      className={inp + ' w-24 tabular-nums'}
      value={local}
      inputMode="numeric"
      onChange={e => setLocal(sanitizeTimeInput(e.target.value))}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      disabled={disabled || startMin == null}
      title={startMin == null ? 'Renseigne d’abord l’heure de début' : undefined}
    />
  )
}

function TextCell({ value, onCommit, disabled, placeholder }) {
  const [local, setLocal] = useState(value ?? '')
  useEffect(() => { setLocal(value ?? '') }, [value])
  const commit = () => {
    const v = (local || '').trim()
    if (v === (value ?? '')) return
    onCommit(v === '' ? null : v)
  }
  return (
    <input
      className={inp}
      value={local ?? ''}
      placeholder={placeholder}
      onChange={e => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      disabled={disabled}
    />
  )
}

export default function FeuilleDeTemps() {
  const { user } = useAuth()
  const [date, setDate] = useState(todayStr())
  const [day, setDay] = useState(null)
  const [loading, setLoading] = useState(false)
  const [savingField, setSavingField] = useState({})
  const [activityCodes, setActivityCodes] = useState([])
  const [history, setHistory] = useState([])
  const [prefMode, setPrefMode] = useState('simple')
  const [focusEntryId, setFocusEntryId] = useState(null)
  const confirm = useConfirm()
  const { addToast } = useToast()

  // Load reference data once
  useEffect(() => {
    api.activityCodes.list().then(r => setActivityCodes(r.data || r)).catch(() => setActivityCodes([]))
    api.timesheets.getPreferences().then(p => setPrefMode(p.default_mode || 'simple')).catch(() => {})
  }, [])

  const loadDay = useCallback(async () => {
    setLoading(true)
    try {
      const existing = await api.timesheets.getDay({ date })
      setDay(existing)
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => { loadDay() }, [loadDay])

  // Charge 12 mois de feuilles : sert à la sidebar historique (filtrée à 12 semaines)
  // ET au cumul mensuel par code en bas de page.
  const loadHistory = useCallback(async () => {
    const t = new Date()
    const from = new Date(t.getFullYear(), t.getMonth() - 11, 1).toISOString().slice(0, 10)
    const r = await api.timesheets.list({ from })
    setHistory(r.data || [])
  }, [])
  useEffect(() => { loadHistory() }, [loadHistory])

  // Sidebar : ne montrer que les 12 dernières semaines pour rester compact.
  const sidebarHistory = useMemo(() => {
    const cutoff = shiftDate(todayStr(), -84)
    return history.filter(d => d.date >= cutoff)
  }, [history])

  async function ensureDay(mode = prefMode) {
    if (day) return day
    const created = await api.timesheets.createDay({ date, mode })
    setDay(created)
    return created
  }

  async function patchDay(patch) {
    const d = await ensureDay(patch.mode || day?.mode || prefMode)
    const k = Object.keys(patch)[0] || 'day'
    setSavingField(s => ({ ...s, [k]: true }))
    try {
      const updated = await api.timesheets.updateDay(d.id, patch)
      setDay(updated)
      // Le backend synchronise déjà la pref quand le user change le mode de sa propre journée —
      // on reflète le changement côté client pour les prochains rendus (défaut sur un jour non créé).
      if (patch.mode && (patch.mode === 'simple' || patch.mode === 'detailed')) {
        setPrefMode(patch.mode)
      }
      loadHistory()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSavingField(s => ({ ...s, [k]: false }))
    }
  }

  async function addEntry() {
    const d = await ensureDay('detailed')
    if (d.mode !== 'detailed') {
      await patchDay({ mode: 'detailed' })
    }
    const updated = await api.timesheets.addEntry(d.id, { duration_minutes: 0 })
    setDay(updated)
    // Focus le picker de code d'activité de la nouvelle ligne (la dernière).
    const newEntry = updated?.entries?.[updated.entries.length - 1]
    if (newEntry?.id) setFocusEntryId(newEntry.id)
    loadHistory()
  }

  async function patchEntry(entryId, patch) {
    const key = `entry-${entryId}-${Object.keys(patch)[0]}`
    setSavingField(s => ({ ...s, [key]: true }))
    try {
      const updated = await api.timesheets.updateEntry(entryId, patch)
      setDay(updated)
      loadHistory()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSavingField(s => ({ ...s, [key]: false }))
    }
  }

  async function deleteEntry(entryId) {
    if (!(await confirm('Supprimer cette activité ?'))) return
    const updated = await api.timesheets.deleteEntry(entryId)
    setDay(updated)
    loadHistory()
  }

  // Raccourcis clavier de la page : Enter = nouvelle activité, a = aujourd'hui,
  // flèche gauche = jour précédent, flèche droite = jour suivant.
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // On filtre sur e.target ET document.activeElement : quand un picker se
      // ferme via Enter, le focus saute sur le bouton avant que le keydown
      // remonte ici — sans le check sur e.target on créerait une nouvelle
      // entrée à chaque sélection dans le picker code d'activité.
      const isInteractive = el => {
        if (!el) return false
        const tag = el.tagName
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || el.isContentEditable
      }
      if (isInteractive(e.target) || isInteractive(document.activeElement)) return
      if (e.key === 'Enter') {
        e.preventDefault()
        addEntry()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setDate(d => shiftDate(d, -1))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setDate(d => shiftDate(d, 1))
      } else if (e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setDate(todayStr())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // addEntry est stable (closure sur day/prefMode), on le recalcule à chaque
    // render — pas besoin de le mettre en dépendance car la closure se renouvelle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, prefMode])

  // Totaux — un entry ne compte que si le code d'activité est payable (payable !== 0).
  // Les entrées sans code d'activité comptent (par défaut on assume payable).
  const entries = day?.entries || []
  const isPayable = (e) => e.activity_code_payable == null || e.activity_code_payable === 1
  const detailedTotalMin = entries
    .filter(isPayable)
    .reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0)
  const simpleTotalMin = (() => {
    if (!day?.start_time || !day?.end_time) return 0
    const toMin = (t) => { const [h, m] = t.split(':').map(n => parseInt(n, 10) || 0); return h * 60 + m }
    const total = toMin(day.end_time) - toMin(day.start_time) - (Number(day.break_minutes) || 0)
    return Math.max(0, total)
  })()
  const effectiveMode = day?.mode || prefMode
  const dailyTotal = effectiveMode === 'detailed' ? detailedTotalMin : simpleTotalMin

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Clock size={20} className="text-slate-400" />
          <h1 className="text-2xl font-bold text-slate-900">Feuille de temps</h1>
          <span className="text-sm text-slate-400">— {user?.name}</span>
        </div>

        <div className="flex flex-col lg:flex-row gap-6">
          {/* History — gauche en desktop, bas en mobile */}
          <aside className="lg:w-72 lg:flex-shrink-0 order-2 lg:order-1">
            <HistoryTable
              history={sidebarHistory}
              currentDate={date}
              onJump={d => { setDate(d); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
            />
          </aside>

          {/* Édition du jour */}
          <main className="flex-1 min-w-0 order-1 lg:order-2">
            {/* Date nav */}
            <div className="card p-4 mb-4 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <button onClick={() => setDate(d => shiftDate(d, -1))} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" aria-label="Jour précédent">
                  <ChevronLeft size={18} />
                </button>
                <div className="text-sm font-medium text-slate-700 capitalize tabular-nums min-w-[14rem] text-center">{weekdayLabel(date)}</div>
                <button onClick={() => setDate(d => shiftDate(d, 1))} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" aria-label="Jour suivant">
                  <ChevronRight size={18} />
                </button>
                <button onClick={() => setDate(todayStr())} className="ml-1 text-xs text-brand-600 hover:underline">Aujourd'hui</button>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-400 uppercase tracking-wide">Total payable du jour</div>
                <div className="text-xl font-semibold text-slate-900 tabular-nums">{formatMinutes(dailyTotal)}</div>
              </div>
            </div>

            {/* Mode toggle */}
            <div className="card p-4 mb-4 flex items-center gap-3">
              <span className="text-sm font-medium text-slate-500">Mode :</span>
              <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                <button
                  onClick={() => patchDay({ mode: 'simple' })}
                  disabled={day?.mode === 'detailed' && entries.length > 0}
                  title={day?.mode === 'detailed' && entries.length > 0 ? 'Supprimez d\'abord les activités détaillées pour revenir au mode simplifié.' : undefined}
                  className={`px-3 py-1.5 text-sm ${effectiveMode === 'simple' ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'} disabled:bg-slate-50 disabled:text-slate-300 disabled:cursor-not-allowed disabled:hover:bg-slate-50`}
                  aria-pressed={effectiveMode === 'simple'}
                >Simplifié</button>
                <button
                  onClick={() => patchDay({ mode: 'detailed' })}
                  className={`px-3 py-1.5 text-sm border-l border-slate-200 ${effectiveMode === 'detailed' ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                  aria-pressed={effectiveMode === 'detailed'}
                >Détaillé</button>
              </div>
              {day?.mode === 'detailed' && entries.length > 0 && (
                <span className="text-xs text-slate-400">Mode verrouillé — {entries.length} activité{entries.length > 1 ? 's' : ''} présente{entries.length > 1 ? 's' : ''}</span>
              )}
              {savingField.mode && <span className="text-xs text-brand-500">enregistrement…</span>}
            </div>

            {/* Edit area */}
            {loading ? (
              <div className="text-sm text-slate-400">Chargement…</div>
            ) : effectiveMode === 'simple' ? (
              <SimpleDayForm day={day} date={date} saving={savingField} onPatch={patchDay} />
            ) : (
              <DetailedDayForm
                day={day}
                entries={entries}
                activityCodes={activityCodes}
                saving={savingField}
                onAddEntry={addEntry}
                onPatchEntry={patchEntry}
                onPatchDay={patchDay}
                onDeleteEntry={deleteEntry}
                focusEntryId={focusEntryId}
                onFocusConsumed={() => setFocusEntryId(null)}
              />
            )}

            <MonthlyCumul history={history} activityCodes={activityCodes} />
          </main>
        </div>
      </div>
    </Layout>
  )
}

function SimpleDayForm({ day, date: _date, saving, onPatch }) {
  return (
    <div className="card p-5">
      <div className="grid grid-cols-3 gap-4 max-w-xl">
        <div>
          <label className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1 block">Heure de début</label>
          <TimeTextInput value={day?.start_time || ''} onCommit={v => onPatch({ start_time: v })} disabled={saving.start_time} />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1 block">Heure de fin</label>
          <TimeTextInput value={day?.end_time || ''} onCommit={v => onPatch({ end_time: v })} disabled={saving.end_time} />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1 block">Temps de pause</label>
          <DurationInput minutes={day?.break_minutes || 0} onCommit={v => onPatch({ break_minutes: v })} disabled={saving.break_minutes} />
        </div>
      </div>
    </div>
  )
}

function DetailedDayForm({ day, entries, activityCodes, saving, onAddEntry, onPatchEntry, onPatchDay, onDeleteEntry, focusEntryId, onFocusConsumed }) {
  // Quand le parent demande à focuser une entrée précise, on consomme la
  // demande après mount du picker correspondant.
  useEffect(() => {
    if (focusEntryId) onFocusConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEntryId])
  // Première entrée → l'heure de début vient de day.start_time. Pour les suivantes,
  // start = end de l'entrée précédente (cumul des durées).
  const dayStartMin = timeToMin(day?.start_time)
  const startMins = []
  let acc = dayStartMin
  for (const e of entries) {
    startMins.push(acc)
    if (acc != null) acc += Number(e.duration_minutes) || 0
  }

  return (
    <div className="card p-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">
              <th className="px-2 py-2 w-28">Début</th>
              <th className="px-2 py-2 w-48">Code d'activité</th>
              <th className="px-2 py-2 w-28">Fin</th>
              <th className="px-2 py-2">Description</th>
              <th className="px-2 py-2 w-20 text-right">Durée</th>
              <th className="px-2 py-2 w-16 text-center">RSDE</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr><td colSpan={7} className="text-center text-sm text-slate-400 py-6">Aucune activité. Cliquez sur « Ajouter » ci-dessous.</td></tr>
            )}
            {entries.map((e, i) => {
              const nonPayable = e.activity_code_id && e.activity_code_payable === 0
              const startMin = startMins[i]
              const dur = Number(e.duration_minutes) || 0
              // Champ Fin vide tant qu'aucune durée n'est saisie (sinon afficherait l'heure de début)
              const endMin = startMin != null && dur > 0 ? startMin + dur : null
              const isFirst = i === 0
              return (
                <tr key={e.id} className={`border-t border-slate-100 ${nonPayable ? 'bg-amber-50/40' : ''}`}>
                  <td className="px-2 py-1.5">
                    {isFirst ? (
                      <TimeTextInput
                        value={day?.start_time || ''}
                        onCommit={v => onPatchDay({ start_time: v })}
                        disabled={saving.start_time}
                      />
                    ) : (
                      <span className="px-2 text-slate-500 tabular-nums">{startMin != null ? minToTime(startMin) : '—'}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <RefPicker value={e.activity_code_id} items={activityCodes} labelOf={a => a.name || '(sans nom)'} placeholder="Code…" onChange={v => onPatchEntry(e.id, { activity_code_id: v })} disabled={saving[`entry-${e.id}-activity_code_id`]} autoFocus={focusEntryId === e.id} />
                  </td>
                  <td className="px-2 py-1.5">
                    <EndTimeInput
                      value={endMin != null ? minToTime(endMin) : ''}
                      startMin={startMin}
                      onCommitDuration={mins => onPatchEntry(e.id, { duration_minutes: mins })}
                      disabled={saving[`entry-${e.id}-duration_minutes`]}
                    />
                  </td>
                  <td className="px-2 py-1.5"><TextCell value={e.description} onCommit={v => onPatchEntry(e.id, { description: v })} disabled={saving[`entry-${e.id}-description`]} placeholder="Tâche / activité" /></td>
                  <td className="px-2 py-1.5 text-right text-slate-500 tabular-nums">{formatMinutes(e.duration_minutes || 0)}</td>
                  <td className="px-2 py-1.5 text-center"><input type="checkbox" checked={!!e.rsde} onChange={ev => onPatchEntry(e.id, { rsde: ev.target.checked ? 1 : 0 })} className="rounded" /></td>
                  <td className="px-1"><button onClick={() => onDeleteEntry(e.id)} className="p-1 text-slate-300 hover:text-red-500" title="Supprimer"><Trash2 size={14} /></button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3">
        <button onClick={onAddEntry} className="text-sm text-brand-600 hover:underline flex items-center gap-1">
          <Plus size={14} /> Ajouter une activité
        </button>
      </div>
    </div>
  )
}

function MonthlyCumul({ history, activityCodes }) {
  const STORAGE_KEY = 'fdt:cumul-codes'
  const [selectedIds, setSelectedIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
  })
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedIds))
  }, [selectedIds])

  // 12 mois glissants (mois courant inclus)
  const months = useMemo(() => {
    const list = []
    const t = new Date()
    for (let i = 11; i >= 0; i--) {
      const d = new Date(t.getFullYear(), t.getMonth() - i, 1)
      list.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: d.toLocaleDateString('fr-CA', { month: 'short', year: '2-digit' }).replace('.', ''),
      })
    }
    return list
  }, [])

  // Map<month, Map<codeId, totalMin>>
  const byMonth = useMemo(() => {
    const m = new Map()
    for (const day of history || []) {
      const month = (day.date || '').slice(0, 7)
      if (!month) continue
      for (const e of day.entries || []) {
        if (!e.activity_code_id) continue
        if (!m.has(month)) m.set(month, new Map())
        const codes = m.get(month)
        codes.set(e.activity_code_id, (codes.get(e.activity_code_id) || 0) + (Number(e.duration_minutes) || 0))
      }
    }
    return m
  }, [history])

  const selectedCodes = activityCodes.filter(c => selectedIds.includes(c.id))
  const availableCodes = activityCodes.filter(c => !selectedIds.includes(c.id))

  const addCode = (id) => { if (id && !selectedIds.includes(id)) setSelectedIds([...selectedIds, id]) }
  const removeCode = (id) => setSelectedIds(selectedIds.filter(x => x !== id))

  return (
    <div className="card p-4 mt-4" data-testid="monthly-cumul">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Cumul mensuel par code</h2>
        <div className="flex items-center gap-2 flex-wrap">
          {selectedCodes.map(c => (
            <span key={c.id} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-xs bg-slate-100 text-slate-700 rounded-md">
              {c.name}
              <button
                type="button"
                onClick={() => removeCode(c.id)}
                className="p-0.5 rounded text-slate-400 hover:text-red-500 hover:bg-slate-300/60"
                aria-label={`Retirer ${c.name}`}
                data-testid={`cumul-remove-${c.id}`}
              ><X size={12} /></button>
            </span>
          ))}
          <div className="w-48">
            <RefPicker
              value=""
              items={availableCodes}
              labelOf={a => a.name || '(sans nom)'}
              placeholder="+ Ajouter un code"
              onChange={addCode}
            />
          </div>
        </div>
      </div>

      {selectedCodes.length === 0 ? (
        <p className="text-xs text-slate-400 italic">Sélectionne un ou plusieurs codes pour voir le cumul mensuel.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                <th className="px-2 py-2 text-left sticky left-0 bg-white">Code</th>
                {months.map(m => (
                  <th key={m.key} className="px-2 py-2 text-right tabular-nums capitalize">{m.label}</th>
                ))}
                <th className="px-2 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {selectedCodes.map(c => {
                const totals = months.map(m => byMonth.get(m.key)?.get(c.id) || 0)
                const grand = totals.reduce((s, v) => s + v, 0)
                return (
                  <tr key={c.id} className="border-t border-slate-100" data-testid={`cumul-row-${c.id}`}>
                    <td className="px-2 py-1.5 font-medium text-slate-700 sticky left-0 bg-white">{c.name}</td>
                    {totals.map((v, i) => (
                      <td key={i} className="px-2 py-1.5 text-right tabular-nums text-slate-700">
                        {v > 0 ? formatMinutes(v) : <span className="text-slate-300">—</span>}
                      </td>
                    ))}
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-slate-900">{formatMinutes(grand)}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              {(() => {
                const monthTotals = months.map(m =>
                  selectedCodes.reduce((s, c) => s + (byMonth.get(m.key)?.get(c.id) || 0), 0)
                )
                const grandTotal = monthTotals.reduce((s, v) => s + v, 0)
                return (
                  <tr className="border-t-2 border-slate-200 bg-slate-50" data-testid="cumul-total-row">
                    <td className="px-2 py-1.5 font-semibold text-slate-700 sticky left-0 bg-slate-50">Total</td>
                    {monthTotals.map((v, i) => (
                      <td key={i} className="px-2 py-1.5 text-right tabular-nums font-semibold text-slate-900">
                        {v > 0 ? formatMinutes(v) : <span className="text-slate-300 font-normal">—</span>}
                      </td>
                    ))}
                    <td className="px-2 py-1.5 text-right tabular-nums font-bold text-slate-900">{formatMinutes(grandTotal)}</td>
                  </tr>
                )
              })()}
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

function HistoryTable({ history, currentDate, onJump }) {
  const grouped = useMemo(() => {
    const byWeek = new Map()
    for (const d of history) {
      const k = weekKey(d.date)
      if (!byWeek.has(k)) byWeek.set(k, [])
      byWeek.get(k).push(d)
    }
    return Array.from(byWeek.entries()).sort((a, b) => a[0] < b[0] ? 1 : -1)
  }, [history])

  if (history.length === 0) return null

  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">Historique</h2>
      <div className="space-y-4">
        {grouped.map(([week, days]) => {
          const weekTotal = days.reduce((s, d) => s + dayTotal(d), 0)
          return (
            <div key={week} className="card overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 bg-slate-50 border-b border-slate-100">
                <div className="text-xs font-semibold text-slate-600">Semaine {week}</div>
                <div className="text-xs text-slate-500 tabular-nums font-semibold text-slate-900">{formatMinutes(weekTotal)}</div>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {days.map(d => (
                    <DayRow key={d.id} day={d} isActive={d.date === currentDate} onJump={onJump} />
                  ))}
                </tbody>
              </table>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function dayTotal(d) {
  if (d.mode === 'detailed') {
    return (d.entries || [])
      .filter(e => e.activity_code_payable == null || e.activity_code_payable === 1)
      .reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0)
  }
  if (d.start_time && d.end_time) {
    const toMin = (t) => { const [h, m] = t.split(':').map(n => parseInt(n, 10) || 0); return h * 60 + m }
    return Math.max(0, toMin(d.end_time) - toMin(d.start_time) - (Number(d.break_minutes) || 0))
  }
  return 0
}

function DayRow({ day, isActive, onJump }) {
  const total = dayTotal(day)
  const date = day.date
  const modeBadge = day.mode === 'detailed' ? 'D' : 'S'
  const baseRow = isActive
    ? 'bg-brand-50 border-l-2 border-brand-500'
    : 'border-l-2 border-transparent hover:bg-slate-50'
  return (
    <tr
      className={`border-t border-slate-100 cursor-pointer ${baseRow}`}
      onClick={() => onJump(date)}
      data-testid={`history-day-row-${date}`}
      data-active={isActive ? 'true' : 'false'}
    >
      <td className={`pl-2.5 pr-2 py-1.5 tabular-nums ${isActive ? 'text-brand-700 font-semibold' : 'text-brand-600 font-medium'}`}>
        {date}
        <span className="ml-1.5 text-[10px] text-slate-400 font-normal">{modeBadge}</span>
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{formatMinutes(total)}</td>
    </tr>
  )
}
