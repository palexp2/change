// Import de l'historique HubSpot (depuis l'ouverture du compte en 2018) dans le
// fil d'interactions de Boréal. Rejouable : chaque engagement porte son
// hubspot_id, une 2e passe met à jour au lieu de dupliquer. Le curseur de
// pagination est gardé dans connector_config — un redémarrage reprend où
// l'import s'était arrêté.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { hsFetch, getAccessToken } from '../connectors/hubspot.js'
import { htmlToText } from '../utils/emailBodyPdf.js'
import { ensureUploadsDir } from '../config/uploads.js'
import { broadcastAll } from './realtime.js'

export const HISTORY_SYNC_KEY = 'hubspot_history'
const filesDir = ensureUploadsDir('hubspot-attachments')
const callsDir = ensureUploadsDir('calls')

const TYPES = {
  notes: {
    interactionType: 'note',
    properties: ['hs_note_body', 'hs_timestamp', 'hubspot_owner_id', 'hs_attachment_ids'],
    detail(p) {
      return { title: 'Note', notes: htmlToText(p.hs_note_body) || null, url: null, duration_minutes: null }
    },
  },
  meetings: {
    interactionType: 'meeting',
    properties: ['hs_meeting_title', 'hs_meeting_body', 'hs_internal_meeting_notes', 'hs_meeting_start_time',
      'hs_meeting_end_time', 'hs_meeting_external_url', 'hs_meeting_location', 'hs_meeting_outcome',
      'hs_timestamp', 'hubspot_owner_id', 'hs_attachment_ids'],
    detail(p) {
      const parts = [htmlToText(p.hs_meeting_body), htmlToText(p.hs_internal_meeting_notes)]
      if (p.hs_meeting_location) parts.push(`Lieu : ${p.hs_meeting_location}`)
      if (p.hs_meeting_outcome) parts.push(`Résultat : ${p.hs_meeting_outcome}`)
      const start = Date.parse(p.hs_meeting_start_time), end = Date.parse(p.hs_meeting_end_time)
      return {
        title: p.hs_meeting_title || 'Réunion',
        notes: parts.filter(Boolean).join('\n\n') || null,
        url: p.hs_meeting_external_url || null,
        duration_minutes: end > start ? Math.round((end - start) / 60000) : null,
      }
    },
  },
  calls: {
    interactionType: 'call',
    properties: ['hs_call_title', 'hs_call_body', 'hs_call_direction', 'hs_call_duration', 'hs_call_from_number',
      'hs_call_to_number', 'hs_call_recording_url', 'hs_call_disposition', 'hs_timestamp', 'hubspot_owner_id',
      'hs_attachment_ids'],
    direction: (p) => ({ INBOUND: 'in', OUTBOUND: 'out' }[p.hs_call_direction] || null),
    // Comme un appel saisi à la main : le texte va dans meetings, l'audio dans calls.
    detail(p) {
      const outcome = CALL_OUTCOMES[p.hs_call_disposition]
      const notes = [outcome && `Résultat : ${outcome}`, htmlToText(p.hs_call_body)].filter(Boolean).join('\n\n')
      return { title: p.hs_call_title || 'Appel', notes: notes || null, url: null, duration_minutes: null }
    },
    call(p) {
      const ms = Number(p.hs_call_duration)
      return {
        duration_seconds: ms > 0 ? Math.round(ms / 1000) : null,
        caller_number: p.hs_call_from_number || null,
        callee_number: p.hs_call_to_number || null,
        recording_url: p.hs_call_recording_url || null,
      }
    },
  },
  emails: {
    interactionType: 'email',
    properties: ['hs_email_subject', 'hs_email_html', 'hs_email_text', 'hs_email_direction', 'hs_email_from_email',
      'hs_email_to_email', 'hs_email_cc_email', 'hs_email_bcc_email', 'hs_timestamp', 'hubspot_owner_id', 'hs_attachment_ids'],
    direction: (p) => (p.hs_email_direction === 'INCOMING_EMAIL' ? 'in' : 'out'),
    email(p) {
      const list = (v) => (v ? String(v).split(';').map(x => x.trim()).filter(Boolean).join(', ') : null)
      return {
        subject: p.hs_email_subject || null,
        body_html: p.hs_email_html || null,
        body_text: p.hs_email_text || htmlToText(p.hs_email_html) || null,
        from_address: p.hs_email_from_email || null,
        to_address: list(p.hs_email_to_email),
        cc: list(p.hs_email_cc_email),
        bcc: list(p.hs_email_bcc_email),
      }
    },
  },
}

// Courriels déjà présents par la synchro Gmail : même objet à 10 min près.
// HubSpot ne donne pas l'identifiant Gmail, on rapproche sur l'objet + l'heure.
const DUP_WINDOW_MS = 10 * 60 * 1000
const subjKey = (s) => String(s || '').trim().toLowerCase().replace(/^((re|tr|fw|fwd)\s*:\s*)+/i, '')
function buildGmailIndex() {
  const idx = new Map()
  for (const r of db.prepare(`SELECT e.subject, i.timestamp FROM emails e JOIN interactions i ON i.id=e.interaction_id
    WHERE e.gmail_message_id IS NOT NULL AND i.deleted_at IS NULL`).all()) {
    const k = subjKey(r.subject)
    if (!idx.has(k)) idx.set(k, [])
    idx.get(k).push(Date.parse(r.timestamp))
  }
  return idx
}

// Issues d'appel standard de HubSpot (identifiants fixes, libellés absents de l'API).
const CALL_OUTCOMES = {
  'f240bbac-87c9-4f6e-bf70-924b57d47db7': 'Joint',
  'b2cf5968-551e-4856-9783-52b3da59a7d0': 'Message vocal laissé',
  'a4c4c377-d246-4b32-a13b-75a56a4cd0ff': 'Message laissé à une personne',
  '73a0d17f-1163-4015-bdd5-ec830791da20': 'Pas de réponse',
  '9d9162e7-6cf3-4944-bf63-4dff82258764': 'Occupé',
  '17b47fee-58de-441e-a44c-c6300d46f273': 'Mauvais numéro',
}

export const HISTORY_TYPES = Object.keys(TYPES)

const normId = (v) => (v == null || v === '' ? null : String(v).replace(/\.0$/, ''))

function cfgGet(key) {
  return db.prepare("SELECT value FROM connector_config WHERE connector='hubspot' AND key=?").get(key)?.value ?? null
}
function cfgSet(key, value) {
  db.prepare(`INSERT INTO connector_config (connector, key, value) VALUES ('hubspot',?,?)
    ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value`).run(key, value == null ? null : String(value))
}

function buildIdMaps() {
  const contacts = new Map(), contactCompany = new Map(), companies = new Map(), owners = new Map()
  for (const r of db.prepare("SELECT id, company_id, hubspot_record_id h FROM contacts WHERE hubspot_record_id IS NOT NULL AND hubspot_record_id<>'' AND deleted_at IS NULL").all()) {
    contacts.set(normId(r.h), r.id); contactCompany.set(r.id, r.company_id)
  }
  for (const r of db.prepare("SELECT id, hubspot_record_id h FROM companies WHERE hubspot_record_id IS NOT NULL AND hubspot_record_id<>'' AND deleted_at IS NULL").all()) {
    companies.set(normId(r.h), r.id)
  }
  for (const r of db.prepare("SELECT id, hubspot_owner_id h FROM users WHERE hubspot_owner_id IS NOT NULL AND hubspot_owner_id<>''").all()) {
    owners.set(normId(r.h), r.id)
  }
  return { contacts, contactCompany, companies, owners }
}

function firstMatch(assoc, map) {
  for (const a of assoc?.results || []) {
    const id = map.get(normId(a.id))
    if (id) return id
  }
  return null
}

// État par type : { done, imported, after } — affiché dans Connecteurs.
export function getHistoryStatus() {
  const out = {}
  for (const t of HISTORY_TYPES) {
    out[t] = {
      done: cfgGet(`history_done_${t}`) === '1',
      imported: db.prepare('SELECT COUNT(*) c FROM interactions WHERE hubspot_id LIKE ?').get(`${t}:%`).c,
    }
  }
  return out
}

async function downloadFile(interactionId, fileId) {
  const exists = db.prepare('SELECT id, file_path FROM interaction_files WHERE interaction_id=? AND hubspot_file_id=?').get(interactionId, fileId)
  if (exists?.file_path) return
  const id = exists?.id || newRecordId()
  if (!exists) db.prepare('INSERT INTO interaction_files (id, interaction_id, hubspot_file_id) VALUES (?,?,?)').run(id, interactionId, fileId)
  try {
    const meta = await hsFetch(`/files/v3/files/${fileId}/signed-url`)
    if (!meta?.url) throw new Error('Fichier introuvable dans HubSpot')
    const name = [meta.name, meta.extension].filter(Boolean).join('.') || `fichier-${fileId}`
    const resp = await fetch(meta.url, { signal: AbortSignal.timeout(120_000) })
    if (!resp.ok) throw new Error(`Téléchargement ${resp.status}`)
    const buf = Buffer.from(await resp.arrayBuffer())
    const safeName = `${id}_${name}`.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 200)
    writeFileSync(join(filesDir, safeName), buf)
    db.prepare('UPDATE interaction_files SET file_name=?, content_type=?, file_size=?, file_path=?, error=NULL WHERE id=?')
      .run(name, resp.headers.get('content-type') || null, buf.length, safeName, id)
  } catch (e) {
    db.prepare('UPDATE interaction_files SET error=? WHERE id=?').run(e.message.slice(0, 500), id)
  }
}

// Enregistrement audio d'un appel HubSpot → uploads/calls, comme les appels
// enregistrés par Boréal (non transcrit).
async function downloadRecording(callId, url) {
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${getAccessToken()}` }, signal: AbortSignal.timeout(120_000) })
    if (!resp.ok) return
    const ext = /mpeg|mp3/.test(resp.headers.get('content-type') || '') ? 'mp3' : 'wav'
    const name = `hs-${callId}.${ext}`
    writeFileSync(join(callsDir, name), Buffer.from(await resp.arrayBuffer()))
    db.prepare(`UPDATE calls SET recording_path=? WHERE id=?`).run(name, callId)
  } catch (e) {
    console.error('HubSpot history recording:', e.message)
  }
}

// Téléchargements en parallèle (6 à la fois — sous la limite de débit HubSpot).
async function pool(jobs, size) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (i < jobs.length) await jobs[i++]()
  }))
}

async function importType(type, { restart = false } = {}) {
  const def = TYPES[type]
  if (restart) { cfgSet(`history_after_${type}`, null); cfgSet(`history_done_${type}`, null) }
  if (cfgGet(`history_done_${type}`) === '1') return { type, skipped: true }

  const maps = buildIdMaps()
  const findI = db.prepare('SELECT id FROM interactions WHERE hubspot_id=?')
  const insI = db.prepare('INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp, hubspot_id) VALUES (?,?,?,?,?,?,?,?)')
  const updI = db.prepare('UPDATE interactions SET contact_id=?, company_id=?, user_id=?, timestamp=? WHERE id=?')
  const findM = db.prepare('SELECT id FROM meetings WHERE interaction_id=?')
  const insM = db.prepare('INSERT INTO meetings (id, interaction_id, title, url, duration_minutes, notes) VALUES (?,?,?,?,?,?)')
  const updM = db.prepare('UPDATE meetings SET title=?, url=?, duration_minutes=?, notes=? WHERE id=?')
  const findC = db.prepare('SELECT id, recording_path FROM calls WHERE interaction_id=?')
  const insC = db.prepare(`INSERT INTO calls (id, interaction_id, duration_seconds, caller_number, callee_number, transcription_status) VALUES (?,?,?,?,?,'done')`)
  const updC = db.prepare('UPDATE calls SET duration_seconds=?, caller_number=?, callee_number=? WHERE id=?')
  const findE = db.prepare('SELECT id FROM emails WHERE interaction_id=?')
  const insE = db.prepare('INSERT INTO emails (id, interaction_id, subject, body_html, body_text, from_address, to_address, cc, bcc) VALUES (?,?,?,?,?,?,?,?,?)')
  const updE = db.prepare('UPDATE emails SET subject=?, body_html=?, body_text=?, from_address=?, to_address=?, cc=?, bcc=? WHERE id=?')
  const gmailIdx = def.email ? buildGmailIndex() : null
  let duplicates = 0

  let after = cfgGet(`history_after_${type}`)
  let count = 0
  const props = def.properties.join(',')
  for (;;) {
    const qs = `limit=100&archived=false&properties=${props}&associations=contacts,companies${after ? `&after=${after}` : ''}`
    const page = await hsFetch(`/crm/v3/objects/${type}?${qs}`)
    const files = [], recordings = []
    db.transaction(() => {
      for (const r of page?.results || []) {
        const p = r.properties || {}
        const contactId = firstMatch(r.associations?.contacts, maps.contacts)
        const companyId = firstMatch(r.associations?.companies, maps.companies) || (contactId && maps.contactCompany.get(contactId)) || null
        const userId = maps.owners.get(normId(p.hubspot_owner_id)) || null
        const ts = new Date(p.hs_timestamp || r.createdAt).toISOString()
        const hsId = `${type}:${r.id}`
        let iid = findI.get(hsId)?.id
        if (!iid && gmailIdx) {
          const t = Date.parse(ts)
          if ((gmailIdx.get(subjKey(p.hs_email_subject)) || []).some(x => Math.abs(x - t) <= DUP_WINDOW_MS)) { duplicates++; continue }
        }
        if (iid) updI.run(contactId, companyId, userId, ts, iid)
        else { iid = newRecordId(); insI.run(iid, contactId, companyId, userId, def.interactionType, def.direction?.(p) || null, ts, hsId) }
        if (def.detail) {
          const d = def.detail(p)
          const mid = findM.get(iid)?.id
          if (mid) updM.run(d.title, d.url, d.duration_minutes, d.notes, mid)
          else insM.run(newRecordId(), iid, d.title, d.url, d.duration_minutes, d.notes)
        }
        if (def.email) {
          const e = def.email(p)
          const vals = [e.subject, e.body_html, e.body_text, e.from_address, e.to_address, e.cc, e.bcc]
          const eid = findE.get(iid)?.id
          if (eid) updE.run(...vals, eid)
          else insE.run(newRecordId(), iid, ...vals)
        }
        if (def.call) {
          const c = def.call(p)
          let call = findC.get(iid)
          if (call) updC.run(c.duration_seconds, c.caller_number, c.callee_number, call.id)
          else { call = { id: newRecordId() }; insC.run(call.id, iid, c.duration_seconds, c.caller_number, c.callee_number) }
          if (c.recording_url && !call.recording_path) recordings.push([call.id, c.recording_url])
        }
        for (const f of String(p.hs_attachment_ids || '').split(';').map(s => s.trim()).filter(Boolean)) files.push([iid, f])
        count++
      }
    })()
    await pool([
      ...files.map(([iid, f]) => () => downloadFile(iid, f)),
      ...recordings.map(([cid, url]) => () => downloadRecording(cid, url)),
    ], 6)
    after = page?.paging?.next?.after || null
    cfgSet(`history_after_${type}`, after)
    broadcastAll({ type: 'sync:progress', syncKey: HISTORY_SYNC_KEY, loaded: count, done: false })
    if (!after) break
  }
  cfgSet(`history_done_${type}`, '1')
  return { type, count, duplicates }
}

// Courriel que HubSpot n'avait lié à personne : rattaché au contact Boréal dont
// l'adresse figure dans l'expéditeur ou les destinataires (hors @orisha.io).
export function linkOrphanEmailsByAddress() {
  const byEmail = new Map()
  for (const r of db.prepare(`SELECT id, company_id, lower(trim(email)) e FROM contacts
    WHERE email IS NOT NULL AND email<>'' AND deleted_at IS NULL ORDER BY created_at`).all()) {
    if (!byEmail.has(r.e)) byEmail.set(r.e, r)
  }
  const rows = db.prepare(`SELECT i.id, i.direction, e.from_address, e.to_address, e.cc FROM interactions i
    JOIN emails e ON e.interaction_id = i.id
    WHERE i.hubspot_id LIKE 'emails:%' AND i.contact_id IS NULL AND i.company_id IS NULL AND i.deleted_at IS NULL`).all()
  const upd = db.prepare('UPDATE interactions SET contact_id=?, company_id=? WHERE id=?')
  let linked = 0
  db.transaction(() => {
    for (const r of rows) {
      const split = (v) => String(v || '').split(/[,;]/).map(a => a.trim().toLowerCase()).filter(a => a && !a.endsWith('@orisha.io'))
      const addrs = r.direction === 'in'
        ? [...split(r.from_address), ...split(r.to_address), ...split(r.cc)]
        : [...split(r.to_address), ...split(r.cc), ...split(r.from_address)]
      const c = addrs.map(a => byEmail.get(a)).find(Boolean)
      if (c) { upd.run(c.id, c.company_id || null, r.id); linked++ }
    }
  })()
  return { linked, remaining: rows.length - linked }
}

export async function importHubSpotHistory({ types = HISTORY_TYPES, restart = false } = {}) {
  // Mémorisé : un redémarrage du serveur reprend l'import (resumeHubSpotHistory).
  for (const t of types) cfgSet(`history_requested_${t}`, '1')
  const results = []
  for (const t of types) {
    if (!TYPES[t]) throw new Error(`Type HubSpot inconnu : ${t}`)
    results.push(await importType(t, { restart }))
  }
  if (types.includes('emails')) results.push({ type: 'emails_by_address', ...linkOrphanEmailsByAddress() })
  broadcastAll({ type: 'sync:progress', syncKey: HISTORY_SYNC_KEY, done: true })
  return results
}

export function interactionFile(interactionId, fileId) {
  const row = db.prepare('SELECT * FROM interaction_files WHERE id=? AND interaction_id=? AND file_path IS NOT NULL').get(fileId, interactionId)
  if (!row) return null
  return { absPath: join(filesDir, row.file_path), fileName: row.file_name, contentType: row.content_type }
}

// Pièces jointes HubSpot de toutes les interactions d'un contact (carte de la fiche contact).
export function listContactHubSpotFiles(contactId) {
  return db.prepare(`
    SELECT f.id, f.file_name, f.content_type, f.file_size, f.created_at AS fetched_at,
           COALESCE(e.subject, m.title) AS email_subject, e.from_address, i.timestamp
    FROM interaction_files f
    JOIN interactions i ON i.id = f.interaction_id
    LEFT JOIN emails e ON e.interaction_id = i.id
    LEFT JOIN meetings m ON m.interaction_id = i.id
    WHERE i.contact_id = ? AND i.deleted_at IS NULL AND f.file_path IS NOT NULL
  `).all(contactId)
}

export function contactHubSpotFile(contactId, fileId) {
  const row = db.prepare(`SELECT f.* FROM interaction_files f JOIN interactions i ON i.id = f.interaction_id
    WHERE f.id = ? AND i.contact_id = ? AND f.file_path IS NOT NULL`).get(fileId, contactId)
  if (!row) return null
  return { absPath: join(filesDir, row.file_path), fileName: row.file_name, contentType: row.content_type }
}

// Au démarrage : reprend au curseur un import demandé mais pas terminé.
export function pendingHistoryTypes() {
  return HISTORY_TYPES.filter(t => cfgGet(`history_requested_${t}`) === '1' && cfgGet(`history_done_${t}`) !== '1')
}
