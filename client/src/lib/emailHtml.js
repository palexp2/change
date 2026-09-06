// Helpers de composition du corps HTML d'un courriel (voir
// components/EmailComposerModal.jsx).
//
// Les gabarits serveur renvoient souvent un document complet
// (`<!DOCTYPE html><html><head>…</head><body style="…">contenu</body></html>`).
// L'édition se fait sur le contenu du <body> uniquement : on garde l'enveloppe
// de côté et on la recolle à l'envoi, sinon les styles du <head> et du <body>
// seraient perdus et le courriel partirait déshabillé.

export function splitEmailHtml(html) {
  const s = String(html || '')
  const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(s)
  if (!m) return { prefix: '', inner: s, suffix: '' }
  const innerStart = m.index + m[0].indexOf('>') + 1
  const innerEnd = innerStart + m[1].length
  return { prefix: s.slice(0, innerStart), inner: m[1], suffix: s.slice(innerEnd) }
}

export function joinEmailHtml(parts, inner) {
  return `${parts?.prefix || ''}${inner}${parts?.suffix || ''}`
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Gabarit en texte brut → HTML (un paragraphe par ligne non vide).
export function textToHtml(text) {
  return String(text || '')
    .split('\n')
    .map(l => `<p>${escapeHtml(l) || '&nbsp;'}</p>`)
    .join('')
}

// Valide une liste d'adresses séparées par des virgules (champ Cc).
export function isValidEmailList(value) {
  const list = String(value || '').split(',').map(s => s.trim()).filter(Boolean)
  return list.every(a => /.+@.+\..+/.test(a))
}
