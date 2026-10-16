import { useEffect, useState } from 'react'
import { api } from './api.js'

// Images du catalogue de soumission par SKU, chargées une fois.
let catalogImages = null
export function useCatalogImages() {
  const [images, setImages] = useState({})
  useEffect(() => {
    catalogImages ||= api.catalog.list()
      .then(l => Object.fromEntries((l || []).filter(p => p.sku && p.image_url).map(p => [p.sku, p.image_url])))
      .catch(() => { catalogImages = null; return {} })
    let live = true
    catalogImages.then(m => { if (live) setImages(m) })
    return () => { live = false }
  }, [])
  return images
}
