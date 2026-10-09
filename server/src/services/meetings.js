// Prise de rendez-vous (Marketing → Rendez-vous) — à la manière de HubSpot
// Meetings : une « page » (meeting_types) publie un lien /erp/rdv/<slug> où un
// visiteur choisit une durée, un jour et une heure libres, puis réserve.
//
// Créneaux libres = plages horaires de la page (par jour de semaine, dans son
// fuseau) − préavis minimal − horizon max − occupations du propriétaire,
// élargies des tampons avant/après. Occupations = réservations ERP confirmées
// du propriétaire (toutes pages confondues) ∪ « busy » de son Google Agenda
// (freebusy) quand il l'a branché (Paramètres → Gmail → Google Agenda).
//
// Une réservation : événement dans l'agenda du propriétaire (invitation Google
// au visiteur, lien Meet si la page est en visioconférence), contact retrouvé
// ou créé par courriel, interaction « meeting » au fil du contact, courriel de
// confirmation (lien de gestion : déplacer / annuler) puis rappels avant le
// rendez-vous. Confirmation et rappels sont des automations système
// (sys_meeting_booking, sys_meeting_reminders) : journal + interrupteur dans
// /automations.

import { randomBytes } from 'node:crypto'
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { APP_URL } from '../config/appUrl.js'
import { getCalendarClient, scopesGrantCalendar } from '../connectors/google.js'
import { sendEmail } from './gmail.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

export const BOOKING_AUTOMATION_ID = 'sys_meeting_booking'
export const REMINDER_AUTOMATION_ID = 'sys_meeting_reminders'

export const DEFAULT_AVAILABILITY = {
  1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']],
  4: [['09:00', '17:00']], 5: [['09:00', '17:00']],
}
export const LOCATION_TYPES = ['meet', 'phone', 'place']

// ── Fuseaux horaires (sans dépendance : Intl) ──────────────────────────────

const fmtCache = new Map()
function partsIn(ms, tz) {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    fmtCache.set(tz, f)
  }
  const p = {}
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value
  return p
}

function offsetMs(ms, tz) {
  const p = partsIn(ms, tz)
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** 'YYYY-MM-DD' + 'HH:MM' lus dans `tz` → epoch ms (UTC). Gère l'heure d'été. */
export function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm] = timeStr.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  const first = guess - offsetMs(guess, tz)
  return guess - offsetMs(first, tz)
}

/** Date locale 'YYYY-MM-DD' d'un instant dans `tz`. */
export function localDate(ms, tz) {
  const p = partsIn(ms, tz)
  return `${p.year}-${p.month}-${p.day}`
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

export function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

// ── Lecture des pages ───────────────────────────────────────────────────────

function parseJson(v, fallback) {
  try { const x = JSON.parse(v); return x ?? fallback } catch { return fallback }
}

/** Ligne meeting_types → objet avec les JSON décodés. */
export function hydrateType(row) {
  if (!row) return null
  return {
    ...row,
    durations: parseJson(row.durations, [30]).map(Number).filter(n => n > 0),
    availability: parseJson(row.availability, DEFAULT_AVAILABILITY),
    reminders: parseJson(row.reminders, []).map(Number).filter(n => n > 0),
    active: row.active ? 1 : 0,
  }
}

export function getTypeBySlug(slug) {
  return hydrateType(db.prepare('SELECT * FROM meeting_types WHERE slug=?').get(String(slug || '').toLowerCase()))
}

export function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

// ── Créneaux ────────────────────────────────────────────────────────────────

/**
 * Créneaux libres (pur, testable). Renvoie des epoch ms de début.
 * @param {object} type  page hydratée
 * @param {number} duration minutes
 * @param {number} now epoch ms
 * @param {Array<{start:number,end:number}>} busy occupations
 */
export function computeSlots(type, duration, now, busy = []) {
  const tz = type.timezone
  const step = Math.max(5, Number(type.slot_interval) || duration)
  const earliest = now + (Number(type.min_notice_hours) || 0) * 3600_000
  const before = (Number(type.buffer_before) || 0) * 60_000
  const after = (Number(type.buffer_after) || 0) * 60_000
  const durMs = duration * 60_000
  const today = localDate(now, tz)
  const out = []
  for (let i = 0; i <= (Number(type.max_days_ahead) || 0); i++) {
    const day = addDays(today, i)
    for (const [from, to] of type.availability[weekday(day)] || []) {
      const winEnd = zonedToUtc(day, to, tz)
      for (let start = zonedToUtc(day, from, tz); start + durMs <= winEnd; start += step * 60_000) {
        if (start < earliest) continue
        const end = start + durMs
        if (busy.some(b => start - before < b.end && end + after > b.start)) continue
        out.push(start)
      }
    }
  }
  return out
}

function ownerAccount(ownerUserId) {
  if (!ownerUserId) return null
  return db.prepare(`
    SELECT co.id, co.account_email, co.granted_scopes, u.name AS owner_name, u.email AS owner_email
    FROM users u
    LEFT JOIN connector_oauth co ON co.connector='google' AND lower(co.account_email)=lower(u.email) AND co.refresh_token IS NOT NULL
    WHERE u.id=?
  `).get(ownerUserId) || null
}

/** État des branchements Google du propriétaire d'une page. */
export function ownerStatus(ownerUserId) {
  const a = ownerAccount(ownerUserId)
  return {
    owner_name: a?.owner_name || null,
    gmail: !!a?.id,
    calendar: !!a?.id && scopesGrantCalendar(a.granted_scopes),
  }
}

async function calendarBusy(ownerUserId, timeMin, timeMax) {
  const a = ownerAccount(ownerUserId)
  if (!a?.id || !scopesGrantCalendar(a.granted_scopes)) return []
  const cal = await getCalendarClient(a.id)
  const r = await cal.freebusy.query({
    requestBody: { timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(), items: [{ id: 'primary' }] },
  })
  return (r.data.calendars?.primary?.busy || []).map(b => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
}

function bookingBusy(ownerUserId, timeMin, timeMax, exceptId = null) {
  return db.prepare(`
    SELECT start_at, end_at FROM meeting_bookings
    WHERE owner_user_id=? AND status='confirmed' AND end_at > ? AND start_at < ? AND id IS NOT ?
  `).all(ownerUserId, new Date(timeMin).toISOString(), new Date(timeMax).toISOString(), exceptId)
    .map(b => ({ start: Date.parse(b.start_at), end: Date.parse(b.end_at) }))
}

/**
 * Créneaux libres d'une page pour une durée, occupations Google comprises.
 * Un agenda injoignable ne bloque pas la page : on retombe sur les seules
 * réservations ERP et l'erreur est remontée (affichée côté ERP, pas au public).
 */
export async function availableSlots(type, duration, { now = Date.now(), exceptBookingId = null } = {}) {
  const timeMax = now + ((Number(type.max_days_ahead) || 0) + 2) * 86400_000
  let busy = bookingBusy(type.owner_user_id, now, timeMax, exceptBookingId)
  let calendarError = null
  try { busy = busy.concat(await calendarBusy(type.owner_user_id, now, timeMax)) }
  catch (e) { calendarError = e.message }
  return { slots: computeSlots(type, duration, now, busy), calendarError }
}

// ── Courriels ───────────────────────────────────────────────────────────────

const T = {
  fr: {
    confirmSubject: (t, when) => `Confirmé : ${t} — ${when}`,
    rescheduleSubject: (t, when) => `Déplacé : ${t} — ${when}`,
    reminderSubject: (t, when) => `Rappel : ${t} — ${when}`,
    cancelSubject: (t, when) => `Annulé : ${t} — ${when}`,
    hello: n => `Bonjour ${n},`,
    confirmed: (t, o) => `Votre rendez-vous « ${t} »${o ? ` avec ${o}` : ''} est confirmé.`,
    rescheduled: (t, o) => `Votre rendez-vous « ${t} »${o ? ` avec ${o}` : ''} a été déplacé.`,
    reminder: (t, o) => `Petit rappel de votre rendez-vous « ${t} »${o ? ` avec ${o}` : ''}.`,
    cancelled: t => `Votre rendez-vous « ${t} » est annulé.`,
    when: 'Quand', duration: 'Durée', where: 'Où', manage: 'Déplacer ou annuler',
    meet: 'Google Meet', phone: n => `Appel au ${n}`, rebook: 'Reprendre un rendez-vous',
  },
  en: {
    confirmSubject: (t, when) => `Confirmed: ${t} — ${when}`,
    rescheduleSubject: (t, when) => `Rescheduled: ${t} — ${when}`,
    reminderSubject: (t, when) => `Reminder: ${t} — ${when}`,
    cancelSubject: (t, when) => `Cancelled: ${t} — ${when}`,
    hello: n => `Hello ${n},`,
    confirmed: (t, o) => `Your meeting “${t}”${o ? ` with ${o}` : ''} is confirmed.`,
    rescheduled: (t, o) => `Your meeting “${t}”${o ? ` with ${o}` : ''} has been rescheduled.`,
    reminder: (t, o) => `A quick reminder of your meeting “${t}”${o ? ` with ${o}` : ''}.`,
    cancelled: t => `Your meeting “${t}” has been cancelled.`,
    when: 'When', duration: 'Duration', where: 'Where', manage: 'Reschedule or cancel',
    meet: 'Google Meet', phone: n => `Call at ${n}`, rebook: 'Book again',
  },
}

function lang(type) { return type?.language === 'en' ? 'en' : 'fr' }

export function fmtWhen(iso, tz, language = 'fr') {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-CA' : 'fr-CA', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(iso))
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

export function manageUrl(booking) { return `${APP_URL}/erp/rdv/gestion/${booking.manage_token}` }

function whereText(type, booking, L) {
  if (type.location_type === 'meet') return booking.meet_url ? `<a href="${esc(booking.meet_url)}">${L.meet}</a>` : L.meet
  if (type.location_type === 'phone') return esc(L.phone(booking.invitee_phone || ''))
  return esc(type.location || '')
}

function emailHtml(kind, type, booking) {
  const L = T[lang(type)]
  const first = String(booking.invitee_name || '').split(' ')[0]
  const owner = booking.owner_name || type.owner_name || ''
  const intro = { confirm: L.confirmed, reschedule: L.rescheduled, reminder: L.reminder }[kind]
  const lines = kind === 'cancel'
    ? `<p>${esc(L.cancelled(type.name))}</p><p><a href="${APP_URL}/erp/rdv/${esc(type.slug)}">${L.rebook}</a></p>`
    : `<p>${esc(intro(type.name, owner))}</p>
       <table style="border-collapse:collapse;font-size:14px">
         <tr><td style="padding:2px 12px 2px 0;color:#64748b">${L.when}</td><td>${esc(fmtWhen(booking.start_at, type.timezone, lang(type)))}</td></tr>
         <tr><td style="padding:2px 12px 2px 0;color:#64748b">${L.duration}</td><td>${booking.duration_minutes} min</td></tr>
         ${whereText(type, booking, L) ? `<tr><td style="padding:2px 12px 2px 0;color:#64748b">${L.where}</td><td>${whereText(type, booking, L)}</td></tr>` : ''}
       </table>
       <p style="margin-top:16px"><a href="${esc(manageUrl(booking))}">${L.manage}</a></p>`
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a">
    <p>${esc(L.hello(first))}</p>${lines}</div>`
}

function emailSubject(kind, type, booking) {
  const L = T[lang(type)]
  const when = fmtWhen(booking.start_at, type.timezone, lang(type))
  return { confirm: L.confirmSubject, reschedule: L.rescheduleSubject, reminder: L.reminderSubject, cancel: L.cancelSubject }[kind](type.name, when)
}

async function sendBookingEmail(kind, type, booking, { automationId = BOOKING_AUTOMATION_ID, bccOwner = false, extra = {} } = {}) {
  const t0 = Date.now()
  const triggerData = { booking_id: booking.id, kind, to: booking.invitee_email, ...extra }
  try {
    const owner = ownerAccount(booking.owner_user_id)
    await sendEmail(booking.invitee_email, emailSubject(kind, type, booking), emailHtml(kind, type, booking), {
      userId: booking.owner_user_id,
      ...(bccOwner && owner?.owner_email ? { bcc: owner.owner_email } : {}),
    })
    logSystemRun(automationId, { status: 'success', result: `${kind} → ${booking.invitee_email}`, duration_ms: Date.now() - t0, triggerData })
    return true
  } catch (e) {
    logSystemRun(automationId, { status: 'error', error: e.message, duration_ms: Date.now() - t0, triggerData })
    return false
  }
}

// ── Google Agenda : événement ───────────────────────────────────────────────

function eventBody(type, booking) {
  const desc = [
    booking.invitee_company && `${booking.invitee_company}`,
    booking.invitee_phone && `☎ ${booking.invitee_phone}`,
    booking.notes,
    `\n${manageUrl(booking)}`,
  ].filter(Boolean).join('\n')
  return {
    summary: `${type.name} — ${booking.invitee_name}`,
    description: desc,
    start: { dateTime: booking.start_at, timeZone: type.timezone },
    end: { dateTime: booking.end_at, timeZone: type.timezone },
    attendees: [{ email: booking.invitee_email, displayName: booking.invitee_name }],
    ...(type.location_type === 'place' && type.location ? { location: type.location } : {}),
    ...(type.location_type === 'phone' && booking.invitee_phone ? { location: booking.invitee_phone } : {}),
    ...(type.location_type === 'meet' ? {
      conferenceData: { createRequest: { requestId: booking.id, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    } : {}),
  }
}

async function ownerCalendar(ownerUserId) {
  const a = ownerAccount(ownerUserId)
  if (!a?.id || !scopesGrantCalendar(a.granted_scopes)) return null
  return getCalendarClient(a.id)
}

async function createCalendarEvent(type, booking) {
  const cal = await ownerCalendar(booking.owner_user_id)
  if (!cal) return { error: 'Google Agenda non branché' }
  try {
    const r = await cal.events.insert({
      calendarId: 'primary', sendUpdates: 'all', conferenceDataVersion: 1, requestBody: eventBody(type, booking),
    })
    const meet = r.data.hangoutLink || r.data.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri || null
    return { eventId: r.data.id, meetUrl: meet }
  } catch (e) { return { error: e.message } }
}

// ── Réservations ────────────────────────────────────────────────────────────

function findOrCreateContact({ name, email, phone }) {
  const existing = db.prepare('SELECT id, company_id FROM contacts WHERE lower(email)=lower(?) LIMIT 1').get(email)
  if (existing) return existing
  const parts = String(name).trim().split(/\s+/)
  const id = newRecordId()
  db.prepare('INSERT INTO contacts (id, first_name, last_name, email, phone) VALUES (?,?,?,?,?)')
    .run(id, parts[0] || '', parts.slice(1).join(' ') || '', email, phone || null)
  return { id, company_id: null }
}

export function getBooking(id) {
  return db.prepare(`
    SELECT b.*, u.name AS owner_name FROM meeting_bookings b LEFT JOIN users u ON u.id=b.owner_user_id WHERE b.id=?
  `).get(id)
}

export function getBookingByToken(token) {
  const row = db.prepare('SELECT id FROM meeting_bookings WHERE manage_token=?').get(String(token || ''))
  return row ? getBooking(row.id) : null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Rappels dont l'heure est déjà passée au moment de (re)réserver : marqués
// d'office, sinon un rendez-vous pris pour dans 30 min recevrait le rappel « 24 h ».
function pastReminders(type, startMs, now) {
  return type.reminders.filter(m => startMs - m * 60_000 <= now)
}

/**
 * Réserve un créneau. `input` : { duration, start (ISO), name, email, phone, company, notes }.
 * @returns {{ ok: true, booking } | { ok: false, status, error }}
 */
export async function createBooking(type, input, { now = Date.now() } = {}) {
  if (!type?.active) return { ok: false, status: 404, error: 'Page introuvable' }
  const duration = Number(input.duration)
  if (!type.durations.includes(duration)) return { ok: false, status: 400, error: 'Durée invalide' }
  const name = String(input.name || '').trim().slice(0, 120)
  const email = String(input.email || '').trim().toLowerCase().slice(0, 200)
  const phone = String(input.phone || '').trim().slice(0, 40) || null
  if (!name) return { ok: false, status: 400, error: 'Nom requis' }
  if (!EMAIL_RE.test(email)) return { ok: false, status: 400, error: 'Courriel invalide' }
  if (type.location_type === 'phone' && !phone) return { ok: false, status: 400, error: 'Téléphone requis' }
  const startMs = Date.parse(input.start)
  if (!Number.isFinite(startMs)) return { ok: false, status: 400, error: 'Créneau invalide' }

  const { slots } = await availableSlots(type, duration, { now })
  if (!slots.includes(startMs)) return { ok: false, status: 409, error: 'Ce créneau vient d’être pris' }

  const start_at = new Date(startMs).toISOString()
  const end_at = new Date(startMs + duration * 60_000).toISOString()
  const id = newRecordId()
  const booking = {
    id, meeting_type_id: type.id, owner_user_id: type.owner_user_id, start_at, end_at, duration_minutes: duration,
    invitee_name: name, invitee_email: email, invitee_phone: phone,
    invitee_company: String(input.company || '').trim().slice(0, 160) || null,
    notes: String(input.notes || '').trim().slice(0, 2000) || null,
    manage_token: randomBytes(18).toString('base64url'),
    reminders_sent: JSON.stringify(pastReminders(type, startMs, now)),
  }

  // Synchrone (better-sqlite3) : revérifie le conflit ERP et insère d'un bloc.
  const insert = db.transaction(() => {
    if (bookingBusy(type.owner_user_id, startMs, startMs + duration * 60_000).length) return false
    const contact = findOrCreateContact({ name, email, phone })
    booking.contact_id = contact.id
    const interactionId = newRecordId()
    db.prepare(`INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp) VALUES (?,?,?,?,'meeting','in',?)`)
      .run(interactionId, contact.id, contact.company_id || null, type.owner_user_id || null, start_at)
    db.prepare('INSERT INTO meetings (id, interaction_id, title, duration_minutes, notes, attendees) VALUES (?,?,?,?,?,?)')
      .run(newRecordId(), interactionId, type.name, duration, booking.notes, `${name} <${email}>`)
    booking.interaction_id = interactionId
    db.prepare(`
      INSERT INTO meeting_bookings (id, meeting_type_id, owner_user_id, start_at, end_at, duration_minutes,
        invitee_name, invitee_email, invitee_phone, invitee_company, notes, contact_id, interaction_id, manage_token, reminders_sent)
      VALUES (@id, @meeting_type_id, @owner_user_id, @start_at, @end_at, @duration_minutes,
        @invitee_name, @invitee_email, @invitee_phone, @invitee_company, @notes, @contact_id, @interaction_id, @manage_token, @reminders_sent)
    `).run(booking)
    return true
  })
  if (!insert()) return { ok: false, status: 409, error: 'Ce créneau vient d’être pris' }

  const ev = await createCalendarEvent(type, booking)
  db.prepare('UPDATE meeting_bookings SET google_event_id=?, meet_url=?, calendar_error=? WHERE id=?')
    .run(ev.eventId || null, ev.meetUrl || null, ev.error || null, id)
  if (ev.meetUrl) db.prepare('UPDATE meetings SET url=? WHERE interaction_id=?').run(ev.meetUrl, booking.interaction_id)

  const saved = getBooking(id)
  if (isSystemAutomationActive(BOOKING_AUTOMATION_ID)) {
    // Sans événement Google, le propriétaire n'est prévenu par rien d'autre.
    await sendBookingEmail('confirm', type, saved, { bccOwner: !ev.eventId, extra: { calendar_error: ev.error || null } })
  }
  return { ok: true, booking: saved }
}

export async function rescheduleBooking(booking, startIso, { now = Date.now() } = {}) {
  const type = hydrateType(db.prepare('SELECT * FROM meeting_types WHERE id=?').get(booking.meeting_type_id))
  if (!type) return { ok: false, status: 404, error: 'Page introuvable' }
  if (booking.status !== 'confirmed') return { ok: false, status: 400, error: 'Rendez-vous annulé' }
  const startMs = Date.parse(startIso)
  const duration = booking.duration_minutes
  const { slots } = await availableSlots(type, duration, { now, exceptBookingId: booking.id })
  if (!slots.includes(startMs)) return { ok: false, status: 409, error: 'Ce créneau vient d’être pris' }
  const start_at = new Date(startMs).toISOString()
  const end_at = new Date(startMs + duration * 60_000).toISOString()
  db.prepare('UPDATE meeting_bookings SET start_at=?, end_at=?, reminders_sent=? WHERE id=?')
    .run(start_at, end_at, JSON.stringify(pastReminders(type, startMs, now)), booking.id)
  if (booking.interaction_id) db.prepare('UPDATE interactions SET timestamp=? WHERE id=?').run(start_at, booking.interaction_id)

  const saved = getBooking(booking.id)
  let calendarError = null
  if (booking.google_event_id) {
    try {
      const cal = await ownerCalendar(booking.owner_user_id)
      if (cal) {
        await cal.events.patch({
          calendarId: 'primary', eventId: booking.google_event_id, sendUpdates: 'all',
          requestBody: { start: { dateTime: start_at, timeZone: type.timezone }, end: { dateTime: end_at, timeZone: type.timezone } },
        })
      }
    } catch (e) { calendarError = e.message }
  }
  db.prepare('UPDATE meeting_bookings SET calendar_error=? WHERE id=?').run(calendarError, booking.id)
  if (isSystemAutomationActive(BOOKING_AUTOMATION_ID)) {
    await sendBookingEmail('reschedule', type, saved, { bccOwner: !booking.google_event_id })
  }
  return { ok: true, booking: getBooking(booking.id) }
}

export async function cancelBooking(booking, by = 'invitee') {
  if (booking.status === 'cancelled') return { ok: true, booking }
  db.prepare(`UPDATE meeting_bookings SET status='cancelled', cancelled_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), cancelled_by=? WHERE id=?`)
    .run(by, booking.id)
  const type = hydrateType(db.prepare('SELECT * FROM meeting_types WHERE id=?').get(booking.meeting_type_id))
  if (booking.google_event_id) {
    try {
      const cal = await ownerCalendar(booking.owner_user_id)
      if (cal) await cal.events.delete({ calendarId: 'primary', eventId: booking.google_event_id, sendUpdates: 'all' })
    } catch (e) {
      db.prepare('UPDATE meeting_bookings SET calendar_error=? WHERE id=?').run(e.message, booking.id)
    }
  }
  if (type && isSystemAutomationActive(BOOKING_AUTOMATION_ID)) {
    await sendBookingEmail('cancel', type, booking, { bccOwner: by === 'invitee' && !booking.google_event_id })
  }
  return { ok: true, booking: getBooking(booking.id) }
}

// ── Rappels ─────────────────────────────────────────────────────────────────

/** Rappels dus maintenant : un seul courriel par réservation (le plus proche). */
export function dueReminders(now = Date.now()) {
  const rows = db.prepare(`
    SELECT b.*, u.name AS owner_name, t.reminders AS type_reminders, t.name AS type_name, t.slug, t.timezone,
           t.language, t.location_type, t.location
    FROM meeting_bookings b
    JOIN meeting_types t ON t.id = b.meeting_type_id
    LEFT JOIN users u ON u.id = b.owner_user_id
    WHERE b.status='confirmed' AND b.start_at > ?
  `).all(new Date(now).toISOString())
  const due = []
  for (const b of rows) {
    const sent = parseJson(b.reminders_sent, [])
    const start = Date.parse(b.start_at)
    const pending = parseJson(b.type_reminders, []).map(Number).filter(m => m > 0 && !sent.includes(m) && start - m * 60_000 <= now)
    if (pending.length) due.push({ booking: b, minutes: pending, sent })
  }
  return due
}

export async function runMeetingReminders({ now = Date.now(), dryRun = false } = {}) {
  const due = dueReminders(now)
  if (dryRun) {
    return { result: `${due.length} rappel(s) à envoyer`, details: due.map(d => ({ booking: d.booking.id, to: d.booking.invitee_email, start_at: d.booking.start_at, minutes: d.minutes })) }
  }
  let sent = 0
  for (const { booking, minutes, sent: already } of due) {
    // Marqué avant l'envoi : un échec ne doit pas renvoyer en boucle chaque minute.
    db.prepare('UPDATE meeting_bookings SET reminders_sent=? WHERE id=?').run(JSON.stringify([...already, ...minutes]), booking.id)
    const type = {
      name: booking.type_name, slug: booking.slug, timezone: booking.timezone, language: booking.language,
      location_type: booking.location_type, location: booking.location,
    }
    if (await sendBookingEmail('reminder', type, booking, { automationId: REMINDER_AUTOMATION_ID, extra: { minutes_before: Math.min(...minutes) } })) sent++
  }
  return { result: `${sent}/${due.length} rappel(s) envoyé(s)` }
}

let timer = null
export function startMeetingReminders() {
  if (timer) return
  timer = setInterval(() => {
    if (!isSystemAutomationActive(REMINDER_AUTOMATION_ID)) return
    runMeetingReminders().catch(e => console.error('[meetings] rappels:', e.message))
  }, 60_000)
  timer.unref?.()
}
