import { normalizeToken } from './token.mjs'
import { normalizeErpUrl, erpOriginPermission } from './erp-url.mjs'

const ALL_SITES = 'https://*/*'

const f = {
  erpUrl: document.getElementById('erpUrl'),
  token: document.getElementById('token'),
  auto: document.getElementById('auto'),
  allSites: document.getElementById('allSites'),
}

chrome.permissions.contains({ origins: [ALL_SITES] })
  .then(granted => { f.allSites.checked = granted })
  .catch(() => {})

chrome.storage.local.get(['erpUrl', 'token', 'auto']).then(({ erpUrl = '', token = '', auto = true }) => {
  f.erpUrl.value = erpUrl
  f.token.value = token
  f.auto.checked = auto !== false
})

let savedTimer
document.getElementById('save').addEventListener('click', async () => {
  const s = document.getElementById('saved')
  clearTimeout(savedTimer)
  try {
    const token = normalizeToken(f.token.value)
    const erpUrl = normalizeErpUrl(f.erpUrl.value)
    // Demander dans le geste utilisateur, avant tout autre await.
    const granted = await chrome.permissions.request({ origins: [erpOriginPermission(erpUrl)] })
    if (!granted) throw new Error('Accès refusé — autorisez l’accès au site ERP pour envoyer les sessions.')
    // « Tous les sites » se demande — et se rend — dans le même geste.
    if (f.allSites.checked) {
      const all = await chrome.permissions.request({ origins: [ALL_SITES] })
      if (!all) f.allSites.checked = false
    } else {
      await chrome.permissions.remove({ origins: [ALL_SITES] }).catch(() => {})
    }
    await chrome.storage.local.set({
      erpUrl,
      token,
      auto: f.auto.checked,
    })
    f.erpUrl.value = erpUrl
    f.token.value = token
    s.style.color = ''
    s.textContent = 'Enregistré'
    savedTimer = setTimeout(() => { s.textContent = '' }, 2000)
  } catch (e) {
    s.style.color = '#dc2626'
    s.textContent = e.message
  }
})
