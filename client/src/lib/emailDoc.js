// Rendu d'un corps de courriel dans une iframe : document d'accueil, palette et
// mesure de hauteur. Extrait de `components/InteractionTimeline.jsx` pour être
// partagé avec les fiches (voir `components/EmailBodyFrame.jsx`).

// Les gabarits de courriel supposent la typo par défaut du client mail (16 px
// Times dans une iframe nue) : sans réglage, l'aperçu sortait à une autre
// taille que le reste de l'app. On cale donc le document sur la typo de l'ERP.
export const EMAIL_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

// Un document iframe n'hérite ni de la classe `.dark` ni des variables CSS du
// thème : on lui passe les couleurs en dur, relues sur la racine de l'app pour
// que l'aperçu se fonde exactement dans sa carte.
export function emailPalette() {
  const read = (name, fallback) => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      return v ? `rgb(${v})` : fallback
    } catch { return fallback }
  }
  return {
    surface: read('--c-white', '#ffffff'),
    text: read('--c-slate-700', '#334155'),
    muted: read('--c-slate-400', '#94a3b8'),
    rule: read('--c-slate-200', '#e2e8f0'),
    link: read('--c-brand-600', '#21B14B'),
  }
}

export function emailDoc(html, { compact, palette } = {}) {
  const p = palette || { surface: '#ffffff', text: '#334155', muted: '#94a3b8', rule: '#e2e8f0', link: '#21B14B' }
  // Aperçu : on neutralise la mise en forme du courriel (les gabarits marketing
  // arrivent en 24 px sur fond coloré) et on repeint tout aux couleurs de la
  // carte — l'entrée reste lisible en jour comme en nuit. `body *` et non `*`,
  // sinon la règle écraserait le fond posé sur `html`/`body`.
  // Plein écran : mise en page d'origine préservée, donc fond blanc fixe.
  const surface = compact ? p.surface : '#ffffff'
  const text = compact ? p.text : '#334155'
  const link = compact ? p.link : '#21B14B'
  const neutralize = compact
    ? `body * { background: transparent !important; background-image: none !important; color: inherit !important;
         font-family: ${EMAIL_FONT} !important; font-size: 13px !important; line-height: 1.55 !important; }
       a, a * { color: ${link} !important; }
       p { margin: 0 0 0.5em }`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8">
<base target="_blank">
<style>
  html { color-scheme: ${compact ? 'normal' : 'light'} }
  html, body { margin: 0; padding: 0; background: ${surface}; }
  body { font: 400 ${compact ? '13px/1.55' : '14px/1.6'} ${EMAIL_FONT}; color: ${text}; overflow-wrap: anywhere; -webkit-font-smoothing: antialiased; }
  img, video { max-width: 100% !important; height: auto; }
  table { max-width: 100% !important; }
  a { color: ${link}; }
  blockquote { margin: 0.5em 0; padding-left: 0.75em; border-left: 2px solid ${compact ? p.rule : '#e2e8f0'}; color: ${compact ? p.muted : '#64748b'}; }
  ${neutralize}
</style></head><body>${html}</body></html>`
}

// Hauteur réelle du courriel. `body.scrollHeight` compte les blocs vides que
// tous les clients laissent en fin de message (Gmail en met trois) : la carte
// se terminait sur 80 px de blanc. Un Range ignore ces boîtes vides — mais
// aussi les images, qu'on remesure à part.
export function measureEmailHeight(frame) {
  const doc = frame.contentDocument
  if (!doc?.body) return null
  const scroll = doc.body.scrollHeight
  let tight = 0
  try {
    const range = doc.createRange()
    range.selectNodeContents(doc.body)
    tight = Math.ceil(range.getBoundingClientRect().bottom)
  } catch { /* Range indisponible : on retombe sur scrollHeight */ }
  for (const img of doc.images) {
    if (img.complete && img.naturalHeight > 0) tight = Math.max(tight, Math.ceil(img.getBoundingClientRect().bottom))
  }
  return tight > 0 ? Math.min(scroll, tight + 4) : scroll
}

// Certains courriels arrivent avec du HTML complet dans la colonne texte (part
// `text/plain` absente côté expéditeur, imports anciens…). On le détecte pour
// l'afficher comme un courriel au lieu d'un mur de balises.
export function looksLikeHtml(value) {
  if (!value) return false
  const s = String(value).trimStart().slice(0, 4000)
  if (/^<(!doctype|html|head|body|div|table|p|span|meta|style|center|font)\b/i.test(s)) return true
  return /<(html|body|table|div|p|br|a|img|span)\b[^>]*>/i.test(s) && /<\/(html|body|table|div|p|a|span)>/i.test(s)
}
