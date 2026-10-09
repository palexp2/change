import { hasRole } from '../../../shared/roles.mjs'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useAuth } from '../lib/auth.jsx'
import { parseDurationToMinutes, formatMinutes } from '../lib/duration.js'
import { localISODate } from '../lib/formatDate.js'
import { DataTable } from '../components/DataTable.jsx'
import { formatPercent } from '../lib/percent.js'

const inp = 'w-full border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-900 focus:outline-none focus:border-brand-400 bg-white'

function todayStr() { return localISODate() }
function weekdayShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('fr-CA', { weekday: 'short' })
}
// Périodes de paie : 14 jours du dimanche au samedi, ancrées au 30 août 2026
// (même ancre que /api/timesheets/period-totals).
const PAY_PERIOD_ANCHOR = '2026-08-30'
function addDaysISO(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function payPeriodStartOf(dateStr) {
  const days = Math.round((Date.parse(dateStr + 'T00:00:00Z') - Date.parse(PAY_PERIOD_ANCHOR + 'T00:00:00Z')) / 86400000)
  return addDaysISO(PAY_PERIOD_ANCHOR, Math.floor(days / 14) * 14)
}
function periodLabel(start) {
  return `${start} – ${addDaysISO(start, 13)}`
}
function timeToMin(t) {
  if (!t || typeof t !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(t)
  if (!m) return null
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}

// ---- Reusable searchable picker for FK (company / activity code) ----
// Rendered via portal so the popup isn't clipped by its scrolling ancestor (table wrapper).
// `onCreate(name)` (optionnel) : appelé quand l'utilisateur veut créer un item à la
// volée depuis le menu. Doit retourner (Promise) l'id du nouvel item, qui est alors
// sélectionné automatiquement. `createLabel` personnalise le libellé du bouton.
function RefPicker({ value, items, labelOf, onChange, disabled, autoFocus, onCreate, createLabel }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const [creating, setCreating] = useState(false)
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
  // Proposer la création seulement si un nom est saisi et qu'aucun item ne correspond exactement.
  const canCreate = !!onCreate && q.length > 0 && !items.some(it => labelOf(it).trim().toLowerCase() === q)

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
  const doCreate = async () => {
    const name = query.trim()
    if (!name || !onCreate || creating) return
    setCreating(true)
    try {
      const newId = await onCreate(name)
      if (newId) {
        onChange(newId)
        closeAndFocusBtn()
      }
    } finally {
      setCreating(false)
    }
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
        <span className={selected ? 'text-slate-900 truncate' : 'text-slate-400 truncate'}>{selected ? labelOf(selected) : '—'}</span>
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
                  if (filtered.length === 0 && canCreate) doCreate()
                  else selectAt(highlightIdx)
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
            {filtered.length === 0 && !canCreate
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
            {canCreate && (
              <button
                type="button"
                onClick={doCreate}
                disabled={creating}
                className="w-full text-left px-3 py-1.5 text-sm text-brand-600 hover:bg-brand-50 border-t border-slate-100 flex items-center gap-1.5 disabled:opacity-50"
                data-testid="refpicker-create"
              >
                <Plus size={13} className="flex-shrink-0" />
                <span className="truncate">{creating ? 'Création…' : `${createLabel || 'Créer'} « ${query.trim()} »`}</span>
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

// Heure « HH:MM » ↔ secondes depuis minuit (champs Durée Début / Fin).
function clockToSec(t) {
  const m = timeToMin(t)
  return m == null ? null : m * 60
}
function secToClock(sec) {
  const m = Math.round(sec / 60)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export default function FeuilleDeTemps() {
  const { user } = useAuth()
  const isAdmin = hasRole(user, 'rh')
  const [period, setPeriod] = useState(() => payPeriodStartOf(todayStr()))
  const [history, setHistory] = useState([])
  const [selectedUserId, setSelectedUserId] = useState(user?.id)
  const currentUserId = useRef(selectedUserId)
  currentUserId.current = selectedUserId
  const [users, setUsers] = useState([])
  const pickUser = (id) => setSelectedUserId(id || user.id)
  const isViewingSelf = selectedUserId === user?.id
  const { addToast } = useToast()

  // Liste des users — uniquement pour les admins (qui peuvent consulter la feuille d'un autre employé).
  useEffect(() => {
    if (!isAdmin) return
    api.timesheets.users().then(setUsers).catch(() => setUsers([]))
  }, [isAdmin])

  const selectedUserName = useMemo(() => {
    if (isViewingSelf) return user?.name
    return users.find(u => u.id === selectedUserId)?.name || '…'
  }, [isViewingSelf, selectedUserId, users, user])

  // Charge 12 mois de feuilles : alimente le tableau « Heures par jour ».
  const loadHistory = useCallback(async () => {
    if (!selectedUserId) return
    const t = new Date()
    const from = new Date(t.getFullYear(), t.getMonth() - 11, 1).toISOString().slice(0, 10)
    const r = await api.timesheets.list({ from, user_id: selectedUserId })
    setHistory(r.data || [])
  }, [selectedUserId])
  useEffect(() => { loadHistory() }, [loadHistory])

  // Payé à la semaine (« Heures par semaine » de la fiche employé) : pas de
  // Début / Fin / Pause / Total.
  const [paidWeekly, setPaidWeekly] = useState(false)
  useEffect(() => {
    if (!selectedUserId) return
    let alive = true
    setPaidWeekly(false)
    api.timesheets.getPreferences({ user_id: selectedUserId })
      .then(p => { if (alive) setPaidWeekly(!!p?.paid_weekly) })
      .catch(() => {})
    return () => { alive = false }
  }, [selectedUserId])

  // Tableau « Heures par jour » : la journée d'une ligne est créée à sa
  // première saisie, puis remplacée en place dans l'historique.
  async function saveRow(rowDate, fn) {
    const userId = selectedUserId
    try {
      const d = history.find(x => x.date === rowDate)
        || await api.timesheets.createDay({ date: rowDate, user_id: userId })
      const updated = await fn(d.id)
      if (currentUserId.current !== userId || !updated) return
      setHistory(h => [updated, ...h.filter(x => x.id !== updated.id)].sort((x, y) => y.date.localeCompare(x.date)))
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
      loadHistory()
    }
  }
  const patchRowDay = (rowDate, patch) => saveRow(rowDate, id => api.timesheets.updateDay(id, patch))
  const saveRowRd = (rowDate, body) => saveRow(rowDate, id => api.timesheets.setDayRd(id, body))

  // Raccourci « t » (Layout) : ma feuille du jour.
  const location = useLocation()
  useEffect(() => {
    if (location.state?.timesheet !== 'today-detailed') return
    setSelectedUserId(user?.id)
    setPeriod(payPeriodStartOf(todayStr()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key])

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center gap-3 mb-6 flex-wrap">
          <PageTitle>Feuille de temps</PageTitle>
          {isAdmin && users.length > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-400">—</span>
              <div className="w-56" data-testid="user-picker">
                <RefPicker
                  value={selectedUserId}
                  items={users}
                  labelOf={u => u.name}
                  onChange={pickUser}
                />
              </div>
            </div>
          ) : (
            <span className="text-sm text-slate-400">— {user?.name}</span>
          )}
        </div>

        {!isViewingSelf && (
          <div
            className="rounded-lg border border-amber-200 bg-amber-50 p-3 mb-4 text-sm text-amber-900 flex items-center justify-between gap-3"
            data-testid="viewing-other-banner"
          >
            <span>Tu consultes la feuille de temps de <strong>{selectedUserName}</strong>. Toute modification sera enregistrée sur son compte.</span>
            <button
              onClick={() => setSelectedUserId(user.id)}
              className="text-xs px-2 py-1 border border-amber-300 rounded text-amber-900 hover:bg-amber-100 whitespace-nowrap"
            >Revenir à ma feuille</button>
          </div>
        )}

        <div className="flex flex-col lg:flex-row gap-6">
          <main className="flex-1 min-w-0">
            <HoursTable
              period={period}
              onPeriod={setPeriod}
              history={history}
              onPatchDay={patchRowDay}
              onSaveRd={saveRowRd}
              paidWeekly={paidWeekly}
            />
          </main>
        </div>
      </div>
    </Layout>
  )
}

// Heures par jour : toute la saisie se fait ici, une ligne par jour de la
// période de paie, dans un DataTable en mode tableur. Une journée n'est créée
// qu'à la première saisie.
const CLOCK_COLUMNS = new Set(['start_time', 'end_time', 'break_str', 'total_str', 'rsde_pct'])

function HoursTable({ period, onPeriod, history, onPatchDay, onSaveRd, paidWeekly }) {
  const { addToast } = useToast()
  // Description saisie sur une ligne encore sans temps RSDE : gardée ici
  // jusqu'à la saisie des heures, qui l'enregistre.
  const [pendingDesc, setPendingDesc] = useState({})
  const label = useMemo(() => periodLabel(period), [period])
  const shiftPeriod = (delta) => onPeriod(addDaysISO(period, 14 * delta))

  // Projet proposé : celui de la dernière journée R&D avant la ligne.
  const projectBefore = useCallback((date) => {
    for (const d of history || []) {
      if (d.date >= date) continue
      const p = (d.entries || []).find(e => e.rsde && e.activity_code_project)?.activity_code_project
      if (p) return p
    }
    return ''
  }, [history])

  const rows = useMemo(() => {
    const dayByDate = new Map((history || []).map(d => [d.date, d]))
    const out = []
    for (let i = 0; i < 14; i++) {
      const date = addDaysISO(period, i)
      const day = dayByDate.get(date) || null
      const rdEntries = (day?.entries || []).filter(e => e.rsde)
      const rdMinutes = rdEntries.reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0)
      const total = day ? dayTotal(day) : 0
      const row = { id: date, date, day, rdMinutes, total }
      const savedDesc = rdEntries.find(e => e.description)?.description || ''
      Object.assign(row, {
        rd: rdMinutes,
        // Début / Fin / Pause / Total : champs Durée (secondes).
        start_s: clockToSec(day?.start_time),
        end_s: clockToSec(day?.end_time),
        break_s: day?.break_minutes ? day.break_minutes * 60 : null,
        total_s: total ? total * 60 : null,
        rsde_str: rdMinutes ? formatMinutes(rdMinutes) : '',
        // % de la journée = RSDE ÷ Total ; le saisir remplit RSDE.
        rsde_pct: rdMinutes && total ? formatPercent(Math.round(rdMinutes / total * 100)) : '',
        // Projet affiché seulement quand la ligne a du temps RSDE.
        project: rdMinutes > 0
          ? rdEntries.find(e => e.activity_code_project)?.activity_code_project || ''
          : '',
        description: rdMinutes > 0 ? savedDesc : (pendingDesc[date] ?? savedDesc),
      })
      out.push(row)
    }
    return out
  }, [history, period, pendingDesc])

  const totalPayable = rows.reduce((s, r) => s + r.total, 0)
  const totalRd = rows.reduce((s, r) => s + r.rd, 0)

  async function editCell(row, col, value) {
    const v = value == null ? '' : String(value)
    const refuse = (message) => addToast({ message, type: 'error' })
    const parseDur = (raw) => (!raw.trim() ? 0 : parseDurationToMinutes(raw))
    switch (col.id) {
      case 'start_time':
      case 'end_time': {
        // Durée depuis minuit. Un nombre seul est lu en minutes par le champ
        // Durée : « 8 » (≤ 23 min) vaut ici 8 h, comme avant.
        let sec = value == null ? null : Math.round(Number(value) / 60) * 60
        if (sec != null && sec > 0 && sec < 24 * 60 && sec % 60 === 0) sec *= 60
        if (sec != null && sec >= 24 * 3600) return refuse('Heure invalide (ex. : 8:30).')
        const parsed = sec == null ? '' : secToClock(sec)
        if (parsed !== (row.day?.[col.id] || '')) return onPatchDay(row.date, { [col.id]: parsed })
        return
      }
      case 'break_str': {
        // Pause : un nombre seul de 1 à 4 = heures (« 1 » = 1 h), au-delà = minutes (« 30 »).
        let min = value == null ? 0 : Math.round(Number(value) / 60)
        if (min >= 1 && min <= 4) min *= 60
        if (min !== (row.day?.break_minutes || 0)) return onPatchDay(row.date, { break_minutes: min })
        return
      }
      case 'rsde_str': {
        const parsed = parseDur(v)
        if (parsed == null) return refuse('Durée invalide (ex. : 1:30).')
        // Première saisie RSDE : le projet proposé est celui de la dernière journée R&D.
        const project = row.rdMinutes > 0 ? row.project : projectBefore(row.date)
        if (parsed !== row.rdMinutes) return onSaveRd(row.date, { minutes: parsed, project, description: row.description })
        return
      }
      case 'rsde_pct': {
        const pct = v.trim() ? Number(v.replace(/[%\s\u00a0]/g, '').replace(',', '.')) : 0
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) return refuse('Pourcentage invalide (ex. : 50).')
        if (pct > 0 && !row.total) return refuse('Saisis d’abord Début et Fin.')
        const minutes = Math.round(row.total * pct / 100)
        const project = row.rdMinutes > 0 ? row.project : projectBefore(row.date)
        if (minutes !== row.rdMinutes) return onSaveRd(row.date, { minutes, project, description: row.description })
        return
      }
      case 'project':
        if (row.rdMinutes > 0 && v !== row.project) return onSaveRd(row.date, { minutes: row.rdMinutes, project: v, description: row.description })
        return
      case 'description':
        setPendingDesc(p => ({ ...p, [row.date]: v }))
        if (row.rdMinutes > 0 && v !== row.description) return onSaveRd(row.date, { minutes: row.rdMinutes, project: row.project, description: v })
        return
      default:
    }
  }

  const columns = useMemo(() => [
    { id: 'date', label: 'Date', field: 'date', width: 150, type: 'date', render: r => <DateLabel date={r.date} /> },
    { id: 'start_time', label: 'Début', field: 'start_s', type: 'duration', width: 90, editable: true },
    { id: 'end_time', label: 'Fin', field: 'end_s', type: 'duration', width: 90, editable: true },
    { id: 'break_str', label: 'Pause', field: 'break_s', type: 'duration', width: 90, editable: true },
    { id: 'total_str', label: 'Total', field: 'total_s', type: 'duration', fieldType: 'formula', description: TOTAL_FORMULA, width: 90, footer: <span data-testid="hours-total">{formatMinutes(totalPayable)}</span> },
    { id: 'rsde_pct', label: '% RSDE', field: 'rsde_pct', width: 80, editable: true },
    { id: 'rsde_str', label: 'RSDE', field: 'rsde_str', width: 90, editable: true, footer: <span data-testid="hours-total-rsde">{formatMinutes(totalRd)}</span> },
    { id: 'project', label: 'Projet', field: 'project', width: 200, editable: r => r.rdMinutes > 0, type: 'single_select', options: RD_PROJECTS },
    { id: 'description', label: 'Description', field: 'description', editable: true },
  ].filter(c => !paidWeekly || !CLOCK_COLUMNS.has(c.id)), [totalPayable, totalRd, paidWeekly])

  return (
    <div data-testid="rsde-report">
      <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="font-semibold text-slate-900">Heures par jour</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <button onClick={() => shiftPeriod(-1)} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" aria-label="Période précédente">
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-medium text-slate-700 tabular-nums min-w-[11rem] text-center" data-testid="pay-period-label">{label}</span>
            <button onClick={() => shiftPeriod(1)} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg" aria-label="Période suivante">
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>

      <div data-testid="rsde-table">
        <DataTable
          table="timesheet_hours"
          columns={columns}
          data={rows}
          onCellEdit={editCell}
          height="auto"
          selectedSelectChevron
          selectedSelectClickOpens
          fullHeightCells
          seamlessCellInput
          dragSelectCells
        />
      </div>
    </div>
  )
}

function DateLabel({ date }) {
  return <><span className="capitalize text-slate-400 mr-1.5">{weekdayShort(date)}</span>{date}</>
}

const PROJECT_DOT = { 'Fiabilité': 'bg-sky-500', 'Intelligence de contrôle': 'bg-violet-500' }
const RD_PROJECTS = Object.keys(PROJECT_DOT)

// Colonne Total = formule. Même règle que le total payé côté serveur
// (timesheetHours.js) : Fin − Début − Pause si Début et Fin sont remplis,
// sinon la somme des lignes payables.
const TOTAL_FORMULA = 'Fin − Début − Pause'
function dayTotal(d) {
  if (d.start_time && d.end_time) {
    return Math.max(0, timeToMin(d.end_time) - timeToMin(d.start_time) - (Number(d.break_minutes) || 0))
  }
  return (d.entries || [])
    .filter(e => e.activity_code_payable == null || e.activity_code_payable === 1)
    .reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0)
}
