import { readFileSync, unlinkSync, existsSync } from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { v4 as uuid } from 'uuid'
import FormData from 'form-data'
import nodeFetch from 'node-fetch'
import db from '../db/database.js'

function convertToMp3IfNeeded(filePath) {
  if (!/\.(amr|mp4)$/i.test(filePath)) return { path: filePath, temp: false }
  const tmpPath = filePath.replace(/\.(amr|mp4)$/i, `_tmp_${Date.now()}.mp3`)
  // 16kbps is sufficient for narrowband phone audio (8kHz AMR source); keeps files well under Whisper's 25MB limit
  execSync(`ffmpeg -y -i "${filePath}" -vn -ar 8000 -ab 16k "${tmpPath}"`, { stdio: 'ignore' })
  return { path: tmpPath, temp: true }
}

const queue = new Map() // callId -> promise

export async function enqueueTranscription(callId, filePath) {
  if (queue.has(callId)) return queue.get(callId)
  const p = runTranscription(callId, filePath).catch(console.error)
  queue.set(callId, p)
  p.finally(() => queue.delete(callId))
  return p
}

// Generate { summary, next_steps } from a formatted transcript using GPT-4o-mini.
// Returns null on any failure (caller decides what to do).
export async function generateCallSummary({ transcript, agent, client, apiKey = process.env.OPENAI_API_KEY }) {
  if (!apiKey || !transcript) return null
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `Tu analyses la transcription d'un appel téléphonique entre "${agent}" (employé) et "${client}" (interlocuteur externe). Réponds en JSON strict avec deux clés : "summary" (string, 2-4 phrases en français résumant l'objet de l'appel et les points abordés) et "next_steps" (tableau de strings, chaque entrée étant une action concrète à faire après l'appel — qui fait quoi ; vide si rien à faire). Ne pas inventer d'information non présente dans la transcription.` },
          { role: 'user', content: transcript },
        ],
        max_tokens: 600,
      }),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    const raw = data.choices?.[0]?.message?.content
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : null
    const stepsArr = Array.isArray(parsed.next_steps)
      ? parsed.next_steps.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim())
      : []
    const next_steps = stepsArr.length ? stepsArr.map(s => `- ${s}`).join('\n') : null
    return { summary, next_steps }
  } catch (e) {
    console.error('generateCallSummary error:', e.message)
    return null
  }
}

export function resolveSpeakerNames(callId) {
  const row = db.prepare(`
    SELECT u.name AS agent_name,
           ct.first_name AS contact_first, ct.last_name AS contact_last,
           co.name AS company_name
    FROM calls ca
    JOIN interactions i ON i.id = ca.interaction_id
    LEFT JOIN users u ON u.id = i.user_id
    LEFT JOIN contacts ct ON ct.id = i.contact_id
    LEFT JOIN companies co ON co.id = i.company_id
    WHERE ca.id = ?
  `).get(callId)
  const agent = row?.agent_name || 'Agent'
  const contactName = [row?.contact_first, row?.contact_last].filter(Boolean).join(' ').trim()
  const client = contactName || row?.company_name || 'Client'
  return { agent, client }
}

async function runTranscription(callId, filePath) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) { console.log('⚠️  OPENAI_API_KEY not set, skipping transcription'); return }

  const jobId = uuid()
  db.prepare(`INSERT INTO transcription_jobs (id, call_id, status) VALUES (?,?,'processing')`).run(jobId, callId)
  db.prepare(`UPDATE calls SET transcription_status='processing' WHERE id=?`).run(callId)

  let converted = null
  try {
    // Convert AMR to MP3 if needed (browsers and Whisper don't support AMR)
    converted = convertToMp3IfNeeded(filePath)
    const sendPath = converted.path

    // Whisper transcription — use form-data package with buffer for reliable multipart encoding
    const ext = path.extname(sendPath).slice(1) || 'mp3'
    const fileBuffer = readFileSync(sendPath)
    const form = new FormData()
    form.append('file', fileBuffer, { filename: path.basename(sendPath), contentType: `audio/${ext}` })
    form.append('model', 'whisper-1')

    const resp = await nodeFetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() },
      body: form,
    })
    if (!resp.ok) throw new Error(`Whisper error: ${await resp.text()}`)
    const { text } = await resp.json()

    // Format with GPT-4o-mini
    const { agent, client } = resolveSpeakerNames(callId)
    let formatted = text
    try {
      const fmt = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: `Tu es un assistant qui formate des transcriptions d'appels téléphoniques. Formate le texte brut comme un dialogue entre "${agent}" (l'employé) et "${client}" (le client/interlocuteur externe), avec des sauts de ligne entre les répliques. Préfixe chaque réplique avec le nom suivi de deux-points (ex. "${agent} :"). Garde seulement le contenu, pas d'intro ni de conclusion.` },
            { role: 'user', content: text },
          ],
          max_tokens: 2000,
        }),
      })
      if (fmt.ok) {
        const fmtData = await fmt.json()
        formatted = fmtData.choices?.[0]?.message?.content || text
      }
    } catch {}

    const sum = await generateCallSummary({ transcript: formatted, agent, client, apiKey })
    db.prepare(`
      UPDATE calls SET transcript=?, transcript_formatted=?, summary=?, next_steps=?, transcription_status='done' WHERE id=?
    `).run(text, formatted, sum?.summary || null, sum?.next_steps || null, callId)
    db.prepare(`
      UPDATE transcription_jobs SET status='done', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?
    `).run(jobId)
    console.log(`✅ Transcription done: ${callId}${sum ? ' (summary OK)' : ''}`)
  } catch (e) {
    console.error(`❌ Transcription ${callId}:`, e.message)
    db.prepare(`UPDATE calls SET transcription_status='error' WHERE id=?`).run(callId)
    db.prepare(`UPDATE transcription_jobs SET status='error', error_message=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
      .run(e.message, jobId)
  } finally {
    if (converted?.temp && existsSync(converted.path)) unlinkSync(converted.path)
  }
}
