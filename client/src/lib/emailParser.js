// Strip the quoted reply chain and the sender's signature from an email so
// only the latest message body shows. The full content is kept intact
// upstream — the caller decides whether to render the stripped or full
// version based on the `hasHidden` flag.
//
// Heuristics cover the common cases only. Unknown clients fall through to the
// original content (no stripping).

const ATTRIBUTION_BLOCK_RE = /^(on\b.*\bwrote\s*:?|le\b.*\ba\s+écrit\s*:?)$/i
const ATTRIBUTION_CUTOFF_RE = /^(on\b.*\bwrote\s*:?|le\b.*\ba\s+écrit\s*:?|-----\s*original message\s*-----|________________________________)$/i
// RFC 3676 §4.3 — signature delimiter is "-- " (dash, dash, space) on its own line.
// Many clients omit the trailing space; tolerate both.
const SIG_DELIMITER_RE = /^--\s*$/
const MOBILE_SIG_RE = /^(sent|envoyé|enviado)\s+(from|depuis|desde)\b/i

export function stripEmailHtml(html) {
  if (!html) return { html: '', hasQuoted: false, hasSignature: false, hasHidden: false }
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    // Strip <img src="cid:..."> — RFC 2392 Content-ID refs that only resolve
    // inside an email client. Le navigateur émet une erreur ERR_UNKNOWN_URL_SCHEME
    // par image, ce qui pollue la console sans rien apporter.
    removeCidImages(doc)
    const hasQuoted = removeQuotedHtml(doc)
    const hasSignature = removeSignatureHtml(doc)
    trimTrailingBlanks(doc.body)
    const stripped = (doc.body ? doc.body.innerHTML : doc.documentElement.innerHTML).trim()
    return { html: stripped, hasQuoted, hasSignature, hasHidden: hasQuoted || hasSignature }
  } catch {
    return { html, hasQuoted: false, hasSignature: false, hasHidden: false }
  }
}

function removeCidImages(doc) {
  const imgs = doc.querySelectorAll('img[src^="cid:" i]')
  for (const img of imgs) img.remove()
}

// Les clients de messagerie referment un message sur des blocs vides
// (`<div><br></div>`, `<p>&nbsp;</p>`, et ce que laisse le retrait de la
// signature). Invisibles dans un client mail, ils comptent dans la hauteur
// d'une iframe dimensionnée sur son contenu : l'aperçu se terminait sur
// plusieurs dizaines de pixels de blanc.
const VOID_KEEP = new Set(['IMG', 'VIDEO', 'IFRAME', 'HR', 'TABLE', 'OBJECT', 'EMBED', 'SVG'])

function trimTrailingBlanks(el) {
  if (!el) return
  let last = el.lastChild
  while (last) {
    const blank = last.nodeType === Node.TEXT_NODE
      ? !last.textContent.replace(/\u00a0/g, ' ').trim()
      : last.nodeType === Node.ELEMENT_NODE
        && !VOID_KEEP.has(last.tagName)
        && !last.textContent.replace(/\u00a0/g, ' ').trim()
        && !last.querySelector('img, video, iframe, hr, table, object, embed, svg')
    if (!blank) break
    const prev = last.previousSibling
    last.remove()
    last = prev
  }
}

export function stripEmailText(text) {
  if (!text) return { text: '', hasQuoted: false, hasSignature: false, hasHidden: false }
  const { text: afterQuote, hasQuoted } = cutoffTextBefore(text, ATTRIBUTION_CUTOFF_RE, true)
  const { text: afterSig, hasSignature } = removeSignatureText(afterQuote)
  return { text: afterSig, hasQuoted, hasSignature, hasHidden: hasQuoted || hasSignature }
}

// ─── HTML helpers ────────────────────────────────────────────────────────────

function removeQuotedHtml(doc) {
  const gmailQuote = doc.querySelector('.gmail_quote, .gmail_quote_container')
  const outlookQuote = doc.querySelector('#divRplyFwdMsg')
  const genericBlockquote = doc.body?.querySelector(':scope > blockquote, :scope > div > blockquote')
  const cutoff = gmailQuote || outlookQuote || genericBlockquote
  if (!cutoff) return false

  let node = cutoff
  while (node) {
    const next = node.nextSibling
    const prev = node.previousSibling
    if (prev && prev.nodeType === 1 && ATTRIBUTION_BLOCK_RE.test((prev.textContent || '').trim())) {
      prev.remove()
    }
    node.parentNode.removeChild(node)
    node = next
  }

  // Clean up nested wrappers that only contained quoted content
  let parent = cutoff.parentElement
  while (parent && parent !== doc.body) {
    let sibling = parent.nextSibling
    while (sibling) {
      const toRemove = sibling
      sibling = sibling.nextSibling
      if (toRemove.nodeType === 1 && /^(blockquote|div)$/i.test(toRemove.tagName) &&
          toRemove.querySelector?.('.gmail_quote, blockquote')) {
        toRemove.remove()
      }
    }
    parent = parent.parentElement
  }
  return true
}

function removeSignatureHtml(doc) {
  let removed = false

  // Gmail signatures live in <div class="gmail_signature"> (can be multiple
  // nested if the composer was forwarded/replied to many times after stripping
  // quotes — take them all).
  const sigs = doc.querySelectorAll('.gmail_signature, .gmail_signature_container')
  for (const s of sigs) { s.remove(); removed = true }

  // Apple Mail marks inline signatures with id="AppleMailSignature"
  const apple = doc.querySelectorAll('#AppleMailSignature, [id^="AppleMailSignature"]')
  for (const s of apple) { s.remove(); removed = true }

  // Some clients emit an explicit "-- " paragraph as the signature delimiter
  if (doc.body) {
    const children = [...doc.body.children]
    for (let i = 0; i < children.length; i++) {
      const el = children[i]
      const txt = (el.textContent || '').trim()
      if (SIG_DELIMITER_RE.test(txt)) {
        for (let j = children.length - 1; j >= i; j--) children[j].remove()
        removed = true
        break
      }
      if (MOBILE_SIG_RE.test(txt) && i >= children.length - 2) {
        for (let j = children.length - 1; j >= i; j--) children[j].remove()
        removed = true
        break
      }
    }
  }
  return removed
}

// ─── Text helpers ────────────────────────────────────────────────────────────

function cutoffTextBefore(text, re, stopOnQuotedBlock = false) {
  const lines = text.split(/\r?\n/)
  let cutoff = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (re.test(line)) { cutoff = i; break }
    if (stopOnQuotedBlock && /^>/.test(line) && i > 0) { cutoff = i; break }
  }
  if (cutoff === -1) return { text, hasQuoted: false }
  let end = cutoff
  while (end > 0 && lines[end - 1].trim() === '') end--
  return { text: lines.slice(0, end).join('\n'), hasQuoted: true }
}

function removeSignatureText(text) {
  const lines = text.split(/\r?\n/)
  let cutoff = -1

  // RFC signature delimiter
  for (let i = 0; i < lines.length; i++) {
    if (SIG_DELIMITER_RE.test(lines[i])) { cutoff = i; break }
  }

  // Mobile auto-signature ("Sent from my iPhone") when it's the last
  // non-blank line — we consider a signature if it's in the tail 3 lines.
  if (cutoff === -1) {
    for (let i = Math.max(0, lines.length - 3); i < lines.length; i++) {
      if (MOBILE_SIG_RE.test(lines[i].trim())) { cutoff = i; break }
    }
  }

  if (cutoff === -1) return { text, hasSignature: false }
  let end = cutoff
  while (end > 0 && lines[end - 1].trim() === '') end--
  return { text: lines.slice(0, end).join('\n'), hasSignature: true }
}
