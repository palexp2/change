// Vignette d'image d'une cellule de DataTable.
//
// La hauteur de ligne d'un DataTable est de 32px (cf. `estimateSize` dans
// DataTable.jsx) : la vignette fait 28px pour rester *légèrement* plus petite
// que la ligne et laisser respirer le contenu. Source de vérité unique pour
// toutes les images de tous les tableaux — ne pas redéfinir de tailles ad hoc
// dans les pages.
export const TABLE_THUMB_CLASS = 'h-7 w-7'

export default function TableThumb({ src, alt = '', className = '', ...rest }) {
  if (!src) return null
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      data-testid="table-thumb"
      className={`${TABLE_THUMB_CLASS} object-cover rounded ${className}`}
      {...rest}
    />
  )
}
