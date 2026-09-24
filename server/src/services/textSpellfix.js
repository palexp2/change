// Autocorrecteur du texte saisi dans la fenêtre « Modifier le système » : fautes
// de frappe, d'orthographe, d'accord et de ponctuation seulement. Le sens, le
// vocabulaire, la langue et la mise en forme restent ceux de l'auteur.
const GEMINI_MODEL = 'gemini-3.5-flash-lite'
const OPENAI_MODEL = 'gpt-4o-mini'
export const MAX_SPELLFIX_LENGTH = 4000

const SYSTEM_PROMPT = [
  'Tu es un correcteur orthographique.',
  'Corrige uniquement les fautes de frappe, d\'orthographe, de grammaire, d\'accord, d\'accents et de ponctuation.',
  'Ne reformule pas, ne change aucun mot correct, ne traduis pas, ne résume pas, n\'ajoute rien.',
  'Garde tels quels les noms propres, termes techniques, codes, chemins, URL, nombres et sauts de ligne.',
  'Réponds avec le texte corrigé seulement, sans guillemets ni commentaire.',
].join(' ')

/**
 * Garde-fou : une « correction » qui change beaucoup la longueur est une
 * reformulation (ou une réponse du modèle à la demande) — on garde l'original.
 */
export function acceptCorrection(original, corrected) {
  if (typeof corrected !== 'string') return original
  const out = corrected.replace(/^\s*["«]\s*|\s*["»]\s*$/g, '')
  if (!out.trim()) return original
  const a = original.trim().length
  const b = out.trim().length
  if (Math.abs(a - b) > Math.max(8, a * 0.2)) return original
  // Les blancs de début/fin appartiennent à la saisie en cours (curseur).
  const lead = original.match(/^\s*/)[0]
  const trail = original.match(/\s*$/)[0]
  return lead + out.trim() + trail
}

// Gemini d'abord (rapide, peu coûteux) ; OpenAI en secours si Gemini manque ou échoue.
export async function spellfix(text, { fetchImpl = fetch } = {}) {
  if (!text || !text.trim()) return text
  let corrected
  try {
    corrected = await viaGemini(text, fetchImpl)
  } catch (e) {
    if (!process.env.OPENAI_API_KEY) throw e
    corrected = await viaOpenAI(text, fetchImpl)
  }
  return acceptCorrection(text, corrected)
}

async function viaGemini(text, fetchImpl) {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY non configuré')
  const resp = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!resp.ok) throw new Error(`Gemini ${resp.status}`)
  const data = await resp.json()
  return (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')
}

async function viaOpenAI(text, fetchImpl) {
  const resp = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}`)
  const data = await resp.json()
  return data?.choices?.[0]?.message?.content
}
