// Le chatbot de support Orisha (processus « chatbot », port 3005), nourri de la
// base de connaissance maison : culture de la tomate, irrigation, climat,
// contrôleur. On lui pose les questions techniques reçues sur Instagram pour
// que le message préparé s'appuie sur ce qu'Orisha sait vraiment, plutôt que
// sur ce qu'un modèle générique invente.

const BOT_URL = process.env.SUPPORT_BOT_URL || 'http://127.0.0.1:3005/api/chat-b'
const UNKNOWN = 'JE NE SAIS PAS'

/** Réponse du chatbot, ou null s'il ne sait pas / ne répond pas. */
export async function askSupportBot(question, { timeoutMs = 90_000 } = {}) {
  const q = String(question || '').trim().slice(0, 1200)
  if (!q) return null
  const message =
    `A grower asked us this on Instagram: "${q}". Answer briefly (3 sentences max), only with what your ` +
    `knowledge base says. If it does not cover the question, reply exactly: ${UNKNOWN}`
  const resp = await fetch(BOT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Identité à part : ces échanges ne se mêlent pas à ceux des clients.
    body: JSON.stringify({ message, lang: 'en', controllerId: 'instagram-drafts' }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) return null
  const body = await resp.text()
  // Flux SSE : la réponse finale, nettoyée, est dans l'événement « done ».
  const done = body.split('\n\n').reverse().find(b => b.startsWith('event: done'))
  const data = done?.split('\n').find(l => l.startsWith('data: '))
  let answer = ''
  try { answer = JSON.parse(data.slice(6)).answer || '' } catch { return null }
  answer = answer.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
  if (!answer || answer.toUpperCase().includes(UNKNOWN)) return null
  return answer.slice(0, 1200)
}
