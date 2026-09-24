export function normalizeErpUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
    return url.origin
  } catch {
    throw new Error('Adresse ERP invalide — utilisez https://customer.orisha.io')
  }
}

export const erpOriginPermission = erpUrl => `${normalizeErpUrl(erpUrl)}/*`
