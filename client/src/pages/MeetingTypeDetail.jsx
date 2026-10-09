import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ExternalLink, Plus, Trash2, X } from 'lucide-react'
import api from '../lib/api.js'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { useAutosave } from '../lib/useAutosave.js'
import { CopyLink, bookingColumns, useCancelBooking } from './Meetings.jsx'

// Fiche d'une page de rendez-vous : lien public, durées, plages horaires,
// tampons, lieu, rappels. Tout s'enregistre au fil de la saisie.

const DAYS = [[1, 'Lun'], [2, 'Mar'], [3, 'Mer'], [4, 'Jeu'], [5, 'Ven'], [6, 'Sam'], [0, 'Dim']]
const DURATION_CHOICES = [15, 20, 30, 45, 60, 90, 120]
const REMINDER_CHOICES = [[10080, '1 sem.'], [1440, '24 h'], [120, '2 h'], [60, '1 h'], [15, '15 min']]
const TIMEZONES = ['America/Toronto', 'America/Halifax', 'America/Winnipeg', 'America/Edmonton', 'America/Vancouver', 'America/New_York', 'Europe/Paris']
const LOCATIONS = [['meet', 'Google Meet'], ['phone', 'Téléphone'], ['place', 'Sur place']]

function Chips({ options, value, onChange, testId }) {
  const toggle = v => onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v].sort((a, b) => a - b))
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={testId}>
      {options.map(([v, label]) => (
        <button key={v} type="button" onClick={() => toggle(v)}
          className={`px-2.5 py-1 rounded-full text-xs border ${value.includes(v)
            ? 'bg-brand-50 border-brand-300 text-brand-700'
            : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'}`}>
          {label}
        </button>
      ))}
    </div>
  )
}

function AvailabilityEditor({ value, onChange }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const commit = next => { setDraft(next); onChange(next) }
  const setWin = (day, i, k, v) => {
    const wins = (draft[day] || []).map((w, j) => (j === i ? (k === 0 ? [v, w[1]] : [w[0], v]) : w))
    setDraft({ ...draft, [day]: wins })
  }
  return (
    <div className="space-y-1.5" data-testid="meeting-availability">
      {DAYS.map(([day, label]) => {
        const wins = draft[day] || []
        return (
          <div key={day} className="flex items-start gap-3">
            <label className="flex items-center gap-2 w-16 pt-1.5 text-sm text-slate-700">
              <input type="checkbox" checked={wins.length > 0}
                onChange={e => {
                  const next = { ...draft }
                  if (e.target.checked) next[day] = [['09:00', '17:00']]
                  else delete next[day]
                  commit(next)
                }} />
              {label}
            </label>
            <div className="flex-1 space-y-1">
              {wins.map((w, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input type="time" className="input py-1 w-28" value={w[0]} onChange={e => setWin(day, i, 0, e.target.value)} onBlur={() => onChange(draft)} />
                  <span className="text-slate-400">–</span>
                  <input type="time" className="input py-1 w-28" value={w[1]} onChange={e => setWin(day, i, 1, e.target.value)} onBlur={() => onChange(draft)} />
                  {i === 0 ? (
                    <button type="button" className="text-slate-400 hover:text-slate-700 p-1" title="Ajouter une plage"
                      onClick={() => commit({ ...draft, [day]: [...wins, [wins[wins.length - 1][1], '18:00']] })}>
                      <Plus size={14} />
                    </button>
                  ) : (
                    <button type="button" className="text-slate-400 hover:text-red-600 p-1" title="Retirer"
                      onClick={() => commit({ ...draft, [day]: wins.filter((_, j) => j !== i) })}>
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function NumberField({ label, value, onSave, suffix, testId }) {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex items-center gap-1.5">
        <input type="number" min="0" className="input w-24" key={value} defaultValue={value} data-testid={testId}
          onBlur={e => e.target.value !== '' && Number(e.target.value) !== value && onSave(Number(e.target.value))}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
        {suffix && <span className="text-xs text-slate-500">{suffix}</span>}
      </div>
    </div>
  )
}

export default function MeetingTypeDetail({ recordId: id, onClose }) {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [users, setUsers] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => { api.auth.users().then(setUsers).catch(() => {}) }, [])

  const { record: t, setRecord: setT, loading, loadError, reload } = useDetailRecord(
    () => api.meetings.getType(id), [id], { clearOnError: true })

  const { save } = useAutosave(t, (p) => api.meetings.updateType(id, p), {
    emptyToNull: false,
    onSaved: updated => { setError(null); setT(cur => ({ ...cur, ...updated })) },
    onError: (key, prev, e) => { setError(e.message); setT(cur => ({ ...cur, [key]: prev })) },
  })
  const cancel = useCancelBooking(reload)

  const pending = detailPending({ loading, loadError, onRetry: reload, record: t, notFound: 'Page introuvable.' })
  if (pending) return pending

  async function handleDelete() {
    const ok = await confirm({ title: 'Supprimer la page', message: t.name, confirmLabel: 'Supprimer' })
    if (!ok) return
    await api.meetings.removeType(id)
    if (onClose) onClose()
    else navigate('/rendez-vous')
  }

  const text = (key, props = {}) => (
    <input className="input" key={t[key]} defaultValue={t[key] || ''} data-testid={`meeting-${key}`}
      onBlur={e => e.target.value !== (t[key] || '') && save(key, e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} {...props} />
  )

  return (
    <DetailShell
      header={{
        badge: (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={!!t.active} onChange={e => save('active', e.target.checked ? 1 : 0)} data-testid="meeting-active" />
            Active
          </label>
        ),
        status: t.calendar
          ? <Badge color="green">Google Agenda</Badge>
          : <Link to="/parametres/gmail" className="text-xs"><Badge color="yellow">Agenda non branché</Badge></Link>,
        actions: (<>
          <a href={t.public_url} target="_blank" rel="noreferrer" className="btn-secondary" data-testid="meeting-open-public">
            <ExternalLink size={14} />
          </a>
          <button onClick={handleDelete} className="btn-secondary text-red-600" title="Supprimer" data-testid="meeting-delete">
            <Trash2 size={14} />
          </button>
        </>),
      }}
    >
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

      <div className="card p-5 space-y-4">
        <div>
          <label className="label">Lien</label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400 whitespace-nowrap">{t.public_url.replace(/[^/]+$/, '')}</span>
            {text('slug')}
            <CopyLink url={t.public_url} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div><label className="label">Nom</label>{text('name')}</div>
          <div>
            <label className="label">Avec</label>
            <SearchableSelect
              value={t.owner_user_id || ''}
              options={users.map(u => ({ value: u.id, label: u.name || u.email }))}
              onChange={v => save('owner_user_id', v || null)}
              testId="meeting-owner"
            />
          </div>
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input" rows={2} key={t.description} defaultValue={t.description || ''}
            onBlur={e => e.target.value !== (t.description || '') && save('description', e.target.value)} />
        </div>
      </div>

      <div className="card p-5 mt-5 space-y-4">
        <div>
          <label className="label">Durées</label>
          <Chips options={DURATION_CHOICES.map(d => [d, `${d} min`])} value={t.durations}
            onChange={v => v.length && save('durations', v)} testId="meeting-durations" />
        </div>
        <div>
          <label className="label">Plages</label>
          <AvailabilityEditor value={t.availability} onChange={v => save('availability', v)} />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="label">Pas</label>
            <select className="input" value={t.slot_interval} onChange={e => save('slot_interval', Number(e.target.value))}>
              {[10, 15, 20, 30, 45, 60].map(n => <option key={n} value={n}>{n} min</option>)}
            </select>
          </div>
          <div>
            <label className="label">Fuseau</label>
            <select className="input" value={t.timezone} onChange={e => save('timezone', e.target.value)}>
              {[...new Set([t.timezone, ...TIMEZONES])].map(z => <option key={z} value={z}>{z.split('/').pop().replace('_', ' ')}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Langue</label>
            <select className="input" value={t.language} onChange={e => save('language', e.target.value)}>
              <option value="fr">Français</option>
              <option value="en">English</option>
            </select>
          </div>
          <NumberField label="Préavis" suffix="h" value={t.min_notice_hours} onSave={v => save('min_notice_hours', v)} testId="meeting-notice" />
          <NumberField label="Horizon" suffix="jours" value={t.max_days_ahead} onSave={v => save('max_days_ahead', v)} />
          <div />
          <NumberField label="Tampon avant" suffix="min" value={t.buffer_before} onSave={v => save('buffer_before', v)} />
          <NumberField label="Tampon après" suffix="min" value={t.buffer_after} onSave={v => save('buffer_after', v)} />
        </div>
      </div>

      <div className="card p-5 mt-5 space-y-4">
        <div>
          <label className="label">Lieu</label>
          <div className="flex items-center gap-2">
            <select className="input w-40" value={t.location_type} onChange={e => save('location_type', e.target.value)} data-testid="meeting-location-type">
              {LOCATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {t.location_type === 'place' && text('location')}
          </div>
        </div>
        <div>
          <label className="label">Rappels</label>
          <Chips options={REMINDER_CHOICES} value={t.reminders} onChange={v => save('reminders', v)} testId="meeting-reminders" />
        </div>
      </div>

      <div className="mt-5">
        <div className="text-sm font-semibold text-slate-900 mb-2">
          Réservations <span className="text-slate-400 font-normal">({t.bookings.length})</span>
        </div>
        <DataTable
          table="meeting_bookings"
          columns={bookingColumns(cancel)}
          data={t.bookings}
          searchFields={['invitee_name', 'invitee_email', 'invitee_company']}
        />
      </div>
    </DetailShell>
  )
}
