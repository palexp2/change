import api from './api.js'

// Signature de courriel de l'utilisateur courant (Paramètres › Ma boîte Gmail).
// Lue une fois puis gardée en mémoire ; l'éditeur la remplace à l'enregistrement.
let cached = null

export function getEmailSignature() {
  if (!cached) {
    cached = api.auth.getPreferences()
      .then(p => p?.email_signature || '')
      .catch(() => { cached = null; return '' })
  }
  return cached
}

export async function saveEmailSignature(html) {
  const p = await api.auth.updatePreferences({ email_signature: html })
  const sig = p?.email_signature || ''
  cached = Promise.resolve(sig)
  return sig
}

export const SIGNATURE_ATTR = 'data-erp-signature'

// Ajoute la signature au bas du corps (élément contentEditable du composeur),
// une seule fois.
export function appendSignature(el, html) {
  if (!el || !html || el.querySelector(`[${SIGNATURE_ATTR}]`)) return false
  const wrap = document.createElement('div')
  wrap.setAttribute(SIGNATURE_ATTR, '')
  wrap.innerHTML = html
  if (el.innerHTML.trim()) el.appendChild(document.createElement('br'))
  else el.appendChild(document.createElement('div')).appendChild(document.createElement('br'))
  el.appendChild(wrap)
  return true
}
