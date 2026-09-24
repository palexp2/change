const normalize = value => String(value ?? '').trim().toLowerCase()

// Recherche dans tout le catalogue, indépendamment des filtres de la vue.
// Une correspondance est exacte : « AB12 » ne doit pas ramener « AB123 ».
export async function findScannedProducts(code, products, api) {
  const needle = normalize(code)
  if (!needle) return []
  const matches = products.filter(product => !product.deleted_at && normalize(product.sku) === needle)
  if (matches.length) return matches

  // Les séries sont paginées côté serveur : demander tous les candidats puis
  // vérifier la série exacte (l'API cherche aussi dans le nom du produit).
  const { data } = await api.serials.list({ search: code.trim(), limit: 'all' })
  const ids = [...new Set(data.filter(row => normalize(row.serial) === needle).map(row => row.product_id).filter(Boolean))]
  const rows = await Promise.all(ids.map(id => products.find(product => product.id === id) || api.products.get(id)))
  return rows.filter(product => !product.deleted_at)
}
