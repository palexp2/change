import api from './api.js'

// Signatures de courriel de l'utilisateur courant (Paramètres › Ma boîte Gmail) :
// française (par défaut) et anglaise (contacts anglophones). Lues une fois puis
// gardées en mémoire ; l'éditeur les remplace à l'enregistrement.
let cached = null

const KEY = { fr: 'email_signature', en: 'email_signature_en' }

function loadSignatures() {
  if (!cached) {
    cached = api.auth.getPreferences()
      .then(p => ({ fr: p?.email_signature || '', en: p?.email_signature_en || '' }))
      .catch(() => { cached = null; return { fr: '', en: '' } })
  }
  return cached
}

// Anglaise vide → la française sert aussi aux anglophones.
const pick = (sigs, lang) => (lang === 'en' && sigs.en) || sigs.fr || ''

export function getEmailSignature(lang = 'fr') {
  return loadSignatures().then(s => (lang === 'en' ? s.en : s.fr))
}

// Signature de la boîte Gmail choisie comme expéditeur (celle de l'utilisateur
// ERP qui la possède), dans la langue du destinataire. Sa propre boîte → ses
// signatures à jour (cache ci-dessus).
let accountsCached = null // vidé quand un admin change la signature d'un autre
export function getSignatureFor(accountEmail, lang = 'fr') {
  if (!accountEmail) return loadSignatures().then(s => pick(s, lang))
  if (!accountsCached) {
    accountsCached = api.connectors.gmailAccounts().catch(() => { accountsCached = null; return [] })
  }
  return accountsCached.then(list => {
    const acc = (list || []).find(a => a.account_email?.toLowerCase() === String(accountEmail).toLowerCase())
    if (!acc || acc.is_current_user) return loadSignatures().then(s => pick(s, lang))
    return pick({ fr: acc.signature || '', en: acc.signature_en || '' }, lang)
  })
}

// `userId` : signature d'un autre utilisateur, posée par un admin.
export async function saveEmailSignature(html, lang = 'fr', userId = null) {
  if (userId) {
    const p = await api.admin.updateUserSignatures(userId, { [KEY[lang]]: html })
    accountsCached = null
    return (lang === 'en' ? p?.email_signature_en : p?.email_signature) || ''
  }
  const p = await api.auth.updatePreferences({ [KEY[lang]]: html })
  const sigs = { fr: p?.email_signature || '', en: p?.email_signature_en || '' }
  cached = Promise.resolve(sigs)
  return sigs[lang]
}

export function getUserEmailSignature(userId, lang = 'fr') {
  return api.admin.userSignatures(userId)
    .then(p => (lang === 'en' ? p?.email_signature_en : p?.email_signature) || '')
}

// Langue d'un destinataire ('en' | 'fr' | null), d'après sa fiche contact.
const langCache = new Map()
export function getRecipientLanguage(email) {
  const key = String(email || '').trim().toLowerCase()
  if (!/.+@.+\..+/.test(key)) return Promise.resolve(null)
  if (!langCache.has(key)) {
    langCache.set(key, api.contacts.language(key)
      .then(r => r?.language || null)
      .catch(() => { langCache.delete(key); return null }))
  }
  return langCache.get(key)
}

// 'English' / 'en' / 'EN' → 'en' ; tout le reste → 'fr' ou null.
export function normalizeLang(v) {
  const l = String(v || '').toLowerCase()
  return l.startsWith('en') ? 'en' : l.startsWith('fr') ? 'fr' : null
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

// Remplace la signature déjà posée (changement d'expéditeur ou de langue) ;
// l'ajoute s'il n'y en a pas encore. Signature vide → le bloc est retiré.
export function replaceSignature(el, html) {
  if (!el) return false
  const cur = el.querySelector(`[${SIGNATURE_ATTR}]`)
  if (!cur) return appendSignature(el, html)
  if (!html) {
    const prev = cur.previousSibling
    cur.remove()
    if (prev?.nodeName === 'BR') prev.remove()
    return true
  }
  cur.innerHTML = html
  return true
}
