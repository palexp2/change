// Envoi de SMS — Telnyx Messaging API v2.
//
// Seul point de sortie SMS de l'ERP. Trois garde-fous délibérés :
//
//  1. AUCUN APPEL RÉSEAU EN TEST. NODE_ENV === 'test' (ou clé absente) renvoie
//     un envoi simulé. Un test ne doit jamais faire sonner le téléphone d'un
//     vrai client — la DB de test EST la DB de prod sur ce serveur.
//  2. E.164 STRICT. Telnyx refuse tout ce qui n'est pas +1XXXXXXXXXX ; on
//     normalise ici plutôt que d'attendre un 422 opaque.
//  3. JAMAIS DE THROW SUR ÉCHEC MÉTIER. Retourne { ok, error } pour que
//     l'appelant journalise et affiche, plutôt que de faire tomber la route.
//
// L'accusé de livraison ne vient PAS de cette réponse : Telnyx accuse d'abord
// réception (« accepted »), puis pousse le vrai statut sur le webhook
// (routes/telnyx.js). Un `ok: true` ici signifie « accepté par Telnyx », pas
// « reçu par le client ».

const TELNYX_URL = 'https://api.telnyx.com/v2/messages'

/**
 * Normalise un numéro nord-américain en E.164 (+1XXXXXXXXXX).
 * Retourne null si le numéro ne peut pas être un NANP valide.
 */
export function toE164(input) {
  if (!input) return null
  const raw = String(input).trim()
  const digits = raw.replace(/\D/g, '')
  // Indicatif hors Amérique du Nord explicitement composé : on respecte tel quel.
  if (raw.startsWith('+') && !raw.startsWith('+1')) {
    return digits.length >= 8 ? `+${digits}` : null
  }
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (local.length !== 10) return null
  // NANP : indicatif régional et central office commencent par 2-9.
  if (local[0] < '2' || local[3] < '2') return null
  return `+1${local}`
}

/** true si l'envoi réel est possible (clé configurée et hors mode test). */
export function smsEnabled() {
  return process.env.NODE_ENV !== 'test' && !!process.env.TELNYX_API_KEY
}

/**
 * Envoie un SMS. Retourne { ok, messageId, simulated, error }.
 * Ne throw jamais : un échec réseau devient { ok: false, error }.
 */
export async function sendSms({ to, text }) {
  const dest = toE164(to)
  if (!dest) return { ok: false, error: `Numéro invalide : ${to || '(vide)'}` }
  if (!text || !String(text).trim()) return { ok: false, error: 'Message vide' }

  const from = process.env.TELNYX_FROM_NUMBER
  const profileId = process.env.TELNYX_MESSAGING_PROFILE_ID

  if (!smsEnabled()) {
    return { ok: true, simulated: true, messageId: null, to: dest }
  }
  if (!from) return { ok: false, error: 'TELNYX_FROM_NUMBER non configuré dans server/.env' }

  try {
    const resp = await fetch(TELNYX_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        ...(profileId ? { messaging_profile_id: profileId } : {}),
        to: dest,
        text: String(text),
        type: 'SMS',
        use_profile_webhooks: true,
      }),
    })
    const json = await resp.json().catch(() => null)
    if (!resp.ok) {
      const detail = json?.errors?.map(e => e.detail || e.title).filter(Boolean).join(' — ')
      return { ok: false, error: detail || `Telnyx HTTP ${resp.status}` }
    }
    return { ok: true, simulated: false, messageId: json?.data?.id || null, to: dest }
  } catch (err) {
    return { ok: false, error: err.message || 'Échec réseau vers Telnyx' }
  }
}
