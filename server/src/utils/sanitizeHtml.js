// Signature de courriel saisie par l'utilisateur : on garde la mise en forme
// (div, span, styles, images, liens — un copier-coller de signature Gmail doit
// survivre) et on retire seulement ce qui exécute du code.
export function sanitizeSignatureHtml(html) {
  if (!html) return ''
  return String(html)
    .replace(/<(script|style|iframe|object|embed|form|textarea|select|button|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|style|iframe|object|embed|form|input|textarea|select|button|meta|link|base|noscript|template|frame|frameset)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'\s>]*\2/gi, '$1="#"')
    .trim()
}

// Échappement pour interpoler du texte non fiable dans du HTML généré
// (emails, guides d'appel…). Échappe & < > " ' — couvre aussi bien le contenu
// texte que les valeurs d'attribut. null/undefined → chaîne vide.
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

// Alias sémantique pour les valeurs d'attribut (même échappement).
export const escapeAttr = escapeHtml

