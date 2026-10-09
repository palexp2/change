import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Clock, MapPin, Phone, Video, CheckCircle2 } from 'lucide-react'
import Spinner from '../components/Spinner.jsx'

// Page PUBLIQUE (aucune auth) de prise de rendez-vous — à la HubSpot Meetings.
//   /rdv/:slug          → choisir durée, jour, heure, puis ses coordonnées
//   /rdv/gestion/:token → lien du courriel de confirmation : déplacer / annuler
// Les heures s'affichent dans le fuseau du navigateur du visiteur.

const T = {
  fr: {
    locale: 'fr-CA', with: 'avec', pickDay: 'Choisissez un jour', noSlot: 'Aucune disponibilité',
    name: 'Nom', email: 'Courriel', phone: 'Téléphone', company: 'Entreprise', notes: 'Message',
    book: 'Confirmer', saving: 'Envoi…', back: 'Retour', done: 'C’est confirmé !', doneBody: 'Une confirmation vous a été envoyée par courriel.',
    notFound: 'Page introuvable', error: 'Une erreur s’est produite', retry: 'Réessayer',
    reschedule: 'Déplacer', cancel: 'Annuler le rendez-vous', cancelled: 'Rendez-vous annulé', rebook: 'Reprendre un rendez-vous',
    confirmCancel: 'Confirmer l’annulation', moved: 'Rendez-vous déplacé', meet: 'Google Meet', phoneCall: 'Appel téléphonique', min: 'min',
  },
  en: {
    locale: 'en-CA', with: 'with', pickDay: 'Pick a day', noSlot: 'No availability',
    name: 'Name', email: 'Email', phone: 'Phone', company: 'Company', notes: 'Message',
    book: 'Confirm', saving: 'Sending…', back: 'Back', done: 'You’re booked!', doneBody: 'A confirmation has been sent to your email.',
    notFound: 'Page not found', error: 'Something went wrong', retry: 'Try again',
    reschedule: 'Reschedule', cancel: 'Cancel meeting', cancelled: 'Meeting cancelled', rebook: 'Book again',
    confirmCancel: 'Confirm cancellation', moved: 'Meeting rescheduled', meet: 'Google Meet', phoneCall: 'Phone call', min: 'min',
  },
}

const VISITOR_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const dayKey = iso => new Intl.DateTimeFormat('en-CA', { timeZone: VISITOR_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
const fmt = (iso, L, opts) => new Intl.DateTimeFormat(L.locale, { timeZone: VISITOR_TZ, ...opts }).format(new Date(iso))
// Jour de semaine + YYYY-MM-DD HH:MM (format ISO de l'app), dans le fuseau du visiteur.
const fmtFull = (iso, L) => `${fmt(iso, L, { weekday: 'long' })} ${dayKey(iso)} ${new Intl.DateTimeFormat('en-GB', { timeZone: VISITOR_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))}`

async function call(path, opts = {}) {
  const r = await fetch(`/erp/api/public/meetings${path}`, {
    ...opts, headers: { 'Content-Type': 'application/json' },
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e }
  return j
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4 flex flex-col items-center">
      <img src="/erp/orisha-logo.png" alt="Orisha" className="h-9 mb-6" />
      <div className="w-full max-w-3xl bg-white rounded-2xl shadow-sm border border-slate-200 p-6 sm:p-8">{children}</div>
    </div>
  )
}

function LocationLine({ type, L }) {
  if (!type) return null
  if (type.location_type === 'meet') return <span className="flex items-center gap-1.5"><Video size={14} /> {L.meet}</span>
  if (type.location_type === 'phone') return <span className="flex items-center gap-1.5"><Phone size={14} /> {L.phoneCall}</span>
  return type.location ? <span className="flex items-center gap-1.5"><MapPin size={14} /> {type.location}</span> : null
}

// Mois en grille + heures du jour choisi.
function SlotPicker({ slots, L, onPick }) {
  const byDay = useMemo(() => {
    const m = new Map()
    for (const s of slots) { const k = dayKey(s); if (!m.has(k)) m.set(k, []); m.get(k).push(s) }
    return m
  }, [slots])
  const firstDay = slots[0] ? dayKey(slots[0]) : dayKey(new Date().toISOString())
  const [month, setMonth] = useState(firstDay.slice(0, 7))
  const [day, setDay] = useState(slots[0] ? firstDay : null)
  useEffect(() => { setMonth(firstDay.slice(0, 7)); setDay(slots[0] ? firstDay : null) }, [firstDay, slots])

  const [y, mo] = month.split('-').map(Number)
  const lead = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7
  const nDays = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  const cells = [...Array(lead).fill(null), ...Array.from({ length: nDays }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)]
  const shift = n => { const d = new Date(Date.UTC(y, mo - 1 + n, 1)); setMonth(d.toISOString().slice(0, 7)) }
  const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(L.locale, { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + i))))

  if (!slots.length) return <div className="py-10 text-center text-sm text-slate-500">{L.noSlot}</div>

  return (
    <div className="grid sm:grid-cols-[1fr_180px] gap-6">
      <div>
        <div className="flex items-center justify-between mb-2">
          <button type="button" onClick={() => shift(-1)} className="p-1.5 rounded hover:bg-slate-100"><ChevronLeft size={16} /></button>
          <span className="text-sm font-medium text-slate-800 capitalize">
            {new Intl.DateTimeFormat(L.locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, mo - 1, 1)))}
          </span>
          <button type="button" onClick={() => shift(1)} className="p-1.5 rounded hover:bg-slate-100"><ChevronRight size={16} /></button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {weekdays.map((w, i) => <div key={i} className="text-xs text-slate-400 py-1 uppercase">{w}</div>)}
          {cells.map((d, i) => {
            if (!d) return <div key={i} />
            const open = byDay.has(d)
            return (
              <button key={d} type="button" disabled={!open} onClick={() => setDay(d)} data-testid={open ? 'rdv-day' : undefined}
                className={`h-10 rounded-full text-sm ${d === day ? 'bg-brand-600 text-white font-semibold'
                  : open ? 'text-brand-700 font-semibold bg-brand-50 hover:bg-brand-100' : 'text-slate-300'}`}>
                {Number(d.slice(8))}
              </button>
            )
          })}
        </div>
        <div className="text-xs text-slate-400 mt-3">{VISITOR_TZ.replace('_', ' ')}</div>
      </div>
      <div className="space-y-1.5 max-h-80 overflow-y-auto">
        {!day && <div className="text-sm text-slate-500">{L.pickDay}</div>}
        {(byDay.get(day) || []).map(s => (
          <button key={s} type="button" onClick={() => onPick(s)} data-testid="rdv-slot"
            className="w-full py-2 rounded-lg border border-brand-300 text-brand-700 text-sm font-medium hover:bg-brand-50">
            {fmt(s, L, { hour: '2-digit', minute: '2-digit' })}
          </button>
        ))}
      </div>
    </div>
  )
}

function Header({ type, duration, L }) {
  return (
    <div className="mb-6">
      {type.owner_name && <div className="text-sm text-slate-500">{type.owner_name}</div>}
      <h1 className="text-xl font-semibold text-slate-900">{type.name}</h1>
      <div className="flex flex-wrap items-center gap-4 mt-2 text-sm text-slate-600">
        {duration && <span className="flex items-center gap-1.5"><Clock size={14} /> {duration} {L.min}</span>}
        <LocationLine type={type} L={L} />
      </div>
      {type.description && <p className="text-sm text-slate-600 mt-3 whitespace-pre-line">{type.description}</p>}
    </div>
  )
}

function Message({ title, body, children }) {
  return (
    <div className="text-center py-6">
      <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
      {body && <p className="text-sm text-slate-600 mt-2">{body}</p>}
      {children}
    </div>
  )
}

function BookPage({ slug }) {
  const [type, setType] = useState(null)
  const [status, setStatus] = useState('loading')
  const [duration, setDuration] = useState(null)
  const [slots, setSlots] = useState(null)
  const [picked, setPicked] = useState(null)
  const [form, setForm] = useState({ name: '', email: '', phone: '', company: '', notes: '', website: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  useEffect(() => {
    call(`/${encodeURIComponent(slug)}`)
      .then(t => { setType(t); setDuration(t.durations[0]); setStatus('ok'); document.title = `${t.name} — Orisha` })
      .catch(e => setStatus(e.status === 404 ? 'notfound' : 'error'))
  }, [slug])

  const loadSlots = useCallback(() => {
    if (!duration) return
    setSlots(null)
    call(`/${encodeURIComponent(slug)}/slots?duration=${duration}`).then(r => setSlots(r.slots)).catch(() => setSlots([]))
  }, [slug, duration])
  useEffect(() => { loadSlots() }, [loadSlots])

  const L = T[type?.language === 'en' ? 'en' : 'fr']
  if (status === 'loading') return <Shell><div className="py-10 flex justify-center"><Spinner /></div></Shell>
  if (status !== 'ok') return <Shell><Message title={status === 'notfound' ? L.notFound : L.error} /></Shell>

  if (done) {
    return (
      <Shell>
        <Message title={L.done} body={L.doneBody}>
          <CheckCircle2 size={40} className="text-green-500 mx-auto mt-4" />
          <div className="mt-4 text-sm text-slate-700 font-medium first-letter:uppercase">{fmtFull(done.start_at, L)}</div>
          {done.meet_url && <a href={done.meet_url} className="text-sm text-brand-600 hover:underline">{done.meet_url}</a>}
        </Message>
      </Shell>
    )
  }

  async function submit(e) {
    e.preventDefault()
    setSubmitting(true); setError(null)
    try {
      const r = await call(`/${encodeURIComponent(slug)}/book`, { method: 'POST', body: JSON.stringify({ ...form, duration, start: picked }) })
      setDone(r.booking)
    } catch (err) {
      setError(err.message)
      if (err.status === 409) { setPicked(null); loadSlots() }
    } finally { setSubmitting(false) }
  }

  const field = (k, props = {}) => (
    <div>
      <label className="label" htmlFor={`rdv-${k}`}>{L[k]}{props.required && ' *'}</label>
      <input id={`rdv-${k}`} className="input" value={form[k]} onChange={e => setForm({ ...form, [k]: e.target.value })} {...props} />
    </div>
  )

  return (
    <Shell>
      <Header type={type} duration={duration} L={L} />
      {!picked && type.durations.length > 1 && (
        <div className="flex gap-1.5 mb-5" data-testid="rdv-durations">
          {type.durations.map(d => (
            <button key={d} type="button" onClick={() => setDuration(d)}
              className={`px-3 py-1.5 rounded-full text-sm border ${d === duration ? 'bg-brand-600 border-brand-600 text-white' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}>
              {d} {L.min}
            </button>
          ))}
        </div>
      )}
      {error && <div className="mb-4 text-sm text-red-600">{error}</div>}
      {!picked ? (
        slots ? <SlotPicker slots={slots} L={L} onPick={setPicked} /> : <div className="py-10 flex justify-center"><Spinner /></div>
      ) : (
        <form onSubmit={submit} className="space-y-3 max-w-md" data-testid="rdv-form">
          <div className="text-sm font-medium text-slate-800 first-letter:uppercase">{fmtFull(picked, L)}</div>
          {field('name', { required: true, autoComplete: 'name' })}
          {field('email', { required: true, type: 'email', autoComplete: 'email' })}
          {field('phone', { required: type.location_type === 'phone', type: 'tel', autoComplete: 'tel' })}
          {field('company', { autoComplete: 'organization' })}
          <div>
            <label className="label" htmlFor="rdv-notes">{L.notes}</label>
            <textarea id="rdv-notes" className="input" rows={3} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
          </div>
          {/* Pot de miel anti-robot : invisible pour un humain. */}
          <input type="text" tabIndex={-1} autoComplete="off" className="hidden" value={form.website} onChange={e => setForm({ ...form, website: e.target.value })} aria-hidden="true" />
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={() => setPicked(null)} className="btn-secondary">{L.back}</button>
            <button type="submit" disabled={submitting} className="btn-primary" data-testid="rdv-submit">{submitting ? L.saving : L.book}</button>
          </div>
        </form>
      )}
    </Shell>
  )
}

function ManagePage({ token }) {
  const [data, setData] = useState(null)
  const [status, setStatus] = useState('loading')
  const [mode, setMode] = useState(null)
  const [slots, setSlots] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [moved, setMoved] = useState(false)
  const base = `/booking/${encodeURIComponent(token)}`

  useEffect(() => {
    call(base).then(d => { setData(d); setStatus('ok') }).catch(e => setStatus(e.status === 404 ? 'notfound' : 'error'))
  }, [base])

  const L = T[data?.type?.language === 'en' ? 'en' : 'fr']
  if (status === 'loading') return <Shell><div className="py-10 flex justify-center"><Spinner /></div></Shell>
  if (status !== 'ok') return <Shell><Message title={status === 'notfound' ? L.notFound : L.error} /></Shell>

  const { booking, type } = data
  const startReschedule = () => {
    setMode('reschedule'); setSlots(null)
    call(`${base}/slots`).then(r => setSlots(r.slots)).catch(() => setSlots([]))
  }
  const act = async (path, body) => {
    setBusy(true); setError(null)
    try { const r = await call(`${base}/${path}`, { method: 'POST', body: JSON.stringify(body || {}) }); setData({ ...data, booking: r.booking }); setMode(null); return true }
    catch (e) { setError(e.message); return false }
    finally { setBusy(false) }
  }

  if (booking.status === 'cancelled') {
    return (
      <Shell>
        <Message title={L.cancelled}>
          {type && <Link to={`/rdv/${type.slug}`} className="btn-primary inline-flex mt-5">{L.rebook}</Link>}
        </Message>
      </Shell>
    )
  }

  return (
    <Shell>
      {type && <Header type={type} duration={booking.duration_minutes} L={L} />}
      {moved && <div className="mb-3 text-sm text-green-700">{L.moved}</div>}
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}
      <div className="text-base font-medium text-slate-800 first-letter:uppercase">{fmtFull(booking.start_at, L)}</div>
      {booking.meet_url && <a href={booking.meet_url} className="text-sm text-brand-600 hover:underline">{booking.meet_url}</a>}
      {mode === 'reschedule' ? (
        <div className="mt-6">
          {slots ? <SlotPicker slots={slots} L={L} onPick={async s => { if (await act('reschedule', { start: s })) setMoved(true) }} /> : <Spinner />}
          <button type="button" onClick={() => setMode(null)} className="btn-secondary mt-4">{L.back}</button>
        </div>
      ) : mode === 'cancel' ? (
        <div className="flex gap-2 mt-6">
          <button type="button" onClick={() => setMode(null)} className="btn-secondary">{L.back}</button>
          <button type="button" disabled={busy} onClick={() => act('cancel')} className="btn-primary bg-red-600 hover:bg-red-700" data-testid="rdv-confirm-cancel">{L.confirmCancel}</button>
        </div>
      ) : (
        <div className="flex gap-2 mt-6">
          <button type="button" onClick={startReschedule} className="btn-secondary" data-testid="rdv-reschedule">{L.reschedule}</button>
          <button type="button" onClick={() => setMode('cancel')} className="btn-secondary text-red-600" data-testid="rdv-cancel">{L.cancel}</button>
        </div>
      )}
    </Shell>
  )
}

export default function MeetingBooking() {
  const { slug, token } = useParams()
  return token ? <ManagePage token={token} /> : <BookPage slug={slug} />
}
