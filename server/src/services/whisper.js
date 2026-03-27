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
    let formatted = text
    try {
      const fmt = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Tu es un assistant qui formate des transcriptions d\'appels téléphoniques. Formate le texte brut comme un dialogue entre "Agent" et "Client", avec des sauts de ligne entre les répliques. Garde seulement le contenu, pas d\'intro ni de conclusion.' },
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

    db.prepare(`
      UPDATE calls SET transcript=?, transcript_formatted=?, transcription_status='done' WHERE id=?
    `).run(text, formatted, callId)
    db.prepare(`
      UPDATE transcription_jobs SET status='done', completed_at=datetime('now') WHERE id=?
    `).run(jobId)
    console.log(`✅ Transcription done: ${callId}`)
  } catch (e) {
    console.error(`❌ Transcription ${callId}:`, e.message)
    db.prepare(`UPDATE calls SET transcription_status='error' WHERE id=?`).run(callId)
    db.prepare(`UPDATE transcription_jobs SET status='error', error_message=?, completed_at=datetime('now') WHERE id=?`)
      .run(e.message, jobId)
  } finally {
    if (converted?.temp && existsSync(converted.path)) unlinkSync(converted.path)
  }
}
