import { emailDoc, measureEmailHeight } from '../lib/emailDoc.js'

// Corps de courriel en HTML : iframe sandboxée (le CSS du courriel ne fuit pas
// dans l'app, ses scripts ne tournent pas) dimensionnée sur son contenu.
export default function EmailBodyFrame({ html, compact = false, palette, className = '', style, onMeasure }) {
  return (
    <iframe
      title="Contenu du courriel"
      srcDoc={emailDoc(html, { compact, palette })}
      sandbox="allow-same-origin"
      scrolling="no"
      className={`w-full border-0 ${className}`}
      style={{ minHeight: '40px', ...style }}
      onLoad={e => {
        try {
          const h = measureEmailHeight(e.target)
          if (h == null) return
          e.target.style.height = `${h}px`
          onMeasure?.(h)
        } catch { /* cross-origin : on garde la hauteur minimale */ }
      }}
    />
  )
}
