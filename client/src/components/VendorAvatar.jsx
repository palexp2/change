// Pastille de couleur au nom du fournisseur : repère visuel stable d'une ligne
// à l'autre (même fournisseur = même couleur), pour balayer la liste d'un œil.
const AVATAR_COLORS = ['#d1362a', '#1e6fd9', '#10a37f', '#c27a00', '#7c3aed', '#0e7490', '#be185d', '#4a5058']

export function VendorAvatar({ name, className = 'h-6 w-6 text-[11px]' }) {
  const n = (name || '?').trim()
  let h = 0
  for (const c of n.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return (
    <span className={`rounded-md shrink-0 inline-grid place-items-center font-semibold text-white ${className}`}
      style={{ background: AVATAR_COLORS[h % AVATAR_COLORS.length] }}>
      {(n.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase()}
    </span>
  )
}

export default VendorAvatar
