const ALLOWED_TAGS = ['p','br','strong','em','a','ul','ol','li','blockquote','b','i']

export function sanitizeHtml(html) {
  if (!html) return ''
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/gi, (match, tag) => {
    if (!ALLOWED_TAGS.includes(tag.toLowerCase())) return ''
    if (tag.toLowerCase() === 'a') {
      const href = match.match(/href="([^"]*)"/)
      return match.startsWith('</') ? '</a>' : `<a href="${href ? href[1] : '#'}" target="_blank" rel="noopener noreferrer">`
    }
    return match.startsWith('</') ? `</${tag}>` : `<${tag}>`
  })
}

export function htmlToPlainText(html) {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
