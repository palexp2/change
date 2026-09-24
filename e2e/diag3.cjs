const { chromium } = require('playwright')
const URL = 'http://localhost:3004/erp'
const TOKEN = process.argv[2]
;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  await ctx.addInitScript(t => localStorage.setItem('erp_token', t), TOKEN)
  const page = await ctx.newPage()
  const reqs = []
  page.on('request', r => { if (r.url().includes('/api/connectors')) reqs.push(r.url().replace(/.*\/api/, '')) })
  await page.goto(URL + '/pipeline', { waitUntil: 'commit', timeout: 60000 })
  await page.waitForSelector('[data-panel-btn="field-config"]', { timeout: 40000 })
  await page.waitForTimeout(3000)
  // vider le cache persistant : on simule une toute première visite
  await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('erp.swr:')).forEach(k => localStorage.removeItem(k)))
  reqs.length = 0
  await page.hover('[data-panel-btn="field-config"]')
  await page.waitForTimeout(700)
  console.log('requêtes déclenchées au survol:', reqs)
  const r = await page.evaluate(async () => {
    const t0 = performance.now()
    document.querySelector('[data-panel-btn="field-config"]').click()
    let loaderSeen = false, mapped = null
    while (performance.now() - t0 < 20000) {
      if (document.body.innerText.includes('Chargement des champs Airtable')) loaderSeen = true
      const m = [...document.querySelectorAll('[data-testid="mapping-airtable-field"]')]
        .filter(e => e.innerText.trim() && !e.innerText.includes('Non mappé')).length
      if (m > 0) { mapped = Math.round(performance.now() - t0); break }
      await new Promise(res => requestAnimationFrame(res))
    }
    return { url: location.pathname, loaderSeen, mapped }
  })
  console.log('après survol + clic:', JSON.stringify(r))
  await browser.close()
})()
