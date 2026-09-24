// Au-delà de la rétention des builds, récupérer un onglet ancien une seule
// fois par cinq minutes. Conserver l'URL et la session ; ne rien masquer si
// le réseau ou le stockage ne permettent pas de récupérer.
let recovering = false
window.addEventListener('vite:preloadError', async () => {
  if (recovering || !navigator.onLine) return
  const key = 'boreal.module-recovery'
  try {
    const last = Number(sessionStorage.getItem(key))
    if (last && Date.now() - last < 300000) return
    recovering = true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch('/erp/', { cache: 'no-store', signal: controller.signal })
      if (!response.ok) return
      const html = await response.text()
      if (!html.includes('id="root"') || !html.includes('type="module"')) return
      sessionStorage.setItem(key, String(Date.now()))
      window.location.reload()
    } finally {
      clearTimeout(timeout)
    }
  } catch { /* Le panneau d'erreur existant permet toujours de réessayer. */ }
  finally { recovering = false }
})
