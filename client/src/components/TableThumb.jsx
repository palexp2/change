import { useState } from 'react'

// Vignette d'image d'une cellule de DataTable.
//
// La hauteur de ligne d'un DataTable est de 32px (cf. `estimateSize` dans
// DataTable.jsx) : la vignette fait 28px pour rester *légèrement* plus petite
// que la ligne et laisser respirer le contenu. Source de vérité unique pour
// toutes les images de tous les tableaux — ne pas redéfinir de tailles ad hoc
// dans les pages.
export const TABLE_THUMB_CLASS = 'h-7 w-7'

// Une source qui ne charge pas (fichier disparu, pièce jointe Airtable périmée)
// affichait l'icône « image cassée » du navigateur, indiscernable d'un bug.
// On retombe sur le même carré pointillé que l'absence d'image.
export default function TableThumb({ src, alt = '', className = '', ...rest }) {
  // Mémorise la source EN ÉCHEC, pas un booléen : le placeholder se réinitialise
  // seul quand la ligne change de valeur (mêmes lignes recyclées par la
  // virtualisation du tableau).
  const [failedSrc, setFailedSrc] = useState(null)
  if (!src) return null
  if (failedSrc === src) {
    return (
      <div
        data-testid="table-thumb-missing"
        title="Image indisponible"
        className={`${TABLE_THUMB_CLASS} rounded border border-dashed border-slate-200 ${className}`}
      />
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      data-testid="table-thumb"
      onError={() => setFailedSrc(src)}
      className={`${TABLE_THUMB_CLASS} object-cover rounded ${className}`}
      {...rest}
    />
  )
}
