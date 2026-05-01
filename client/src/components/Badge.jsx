export function Badge({ children, color = 'gray', size = 'sm' }) {
  const colors = {
    gray: 'bg-slate-100 text-slate-700',
    slate: 'bg-slate-200 text-slate-800',
    blue: 'bg-blue-100 text-blue-800',
    indigo: 'bg-brand-100 text-brand-800',
    green: 'bg-green-100 text-green-800',
    yellow: 'bg-yellow-100 text-yellow-800',
    orange: 'bg-orange-100 text-orange-800',
    red: 'bg-red-100 text-red-800',
    purple: 'bg-purple-100 text-purple-800',
    pink: 'bg-pink-100 text-pink-800',
    teal: 'bg-teal-100 text-teal-800',
  }
  const sizes = {
    xs: 'text-xs px-1.5 py-0.5',
    sm: 'text-xs px-2.5 py-0.5',
    md: 'text-sm px-3 py-1',
  }
  return (
    <span className={`inline-flex items-center rounded-full font-medium ${colors[color] || colors.gray} ${sizes[size] || sizes.sm}`}>
      {children}
    </span>
  )
}

export function phaseBadgeColor(phase) {
  const map = {
    'Contact': 'gray',
    'Qualified': 'slate',
    'Problem aware': 'yellow',
    'Solution aware': 'orange',
    'Lead': 'blue',
    'Quote Sent': 'purple',
    'Customer': 'green',
    'Not a Client Anymore': 'red',
  }
  return map[phase] || 'gray'
}

export function orderStatusColor(status) {
  const map = {
    'Commande vide': 'gray',
    "Gel d'envois": 'orange',
    'En attente': 'blue',
    'Items à fabriquer ou à acheter': 'yellow',
    'Tous les items sont disponibles': 'indigo',
    'Tout est dans la boite': 'purple',
    'Partiellement envoyé': 'orange',
    'JWT-config': 'blue',
    "Envoyé aujourd'hui": 'green',
    'Envoyé': 'green',
    'Drop ship seulement': 'teal',
    'ERREUR SYSTÈME': 'red',
  }
  return map[status] || 'gray'
}

export function ticketStatusColor(status) {
  const map = {
    'Waiting on us': 'orange',
    'Waiting on them': 'yellow',
    'Closed': 'green',
  }
  return map[status] || 'gray'
}

export function projectStatusColor(status) {
  const map = {
    'Ouvert': 'blue',
    'Gagné': 'green',
    'Perdu': 'red',
  }
  return map[status] || 'gray'
}

export function stockStatusColor(product) {
  if (!product.min_stock || product.min_stock === 0) return 'gray'
  if (product.stock_qty <= 0) return 'red'
  if (product.stock_qty <= product.min_stock) return 'red'
  if (product.stock_qty <= product.min_stock * 2) return 'yellow'
  return 'green'
}

export function stockStatusLabel(product) {
  if (!product.min_stock || product.min_stock === 0) return 'N/A'
  if (product.stock_qty <= 0) return 'Rupture'
  if (product.stock_qty <= product.min_stock) return 'Critique'
  if (product.stock_qty <= product.min_stock * 2) return 'Faible'
  return 'OK'
}
