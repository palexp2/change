const { chromium } = require('playwright')
const URL = 'http://localhost:3004/erp'
const TOKEN = process.argv[2]
;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  await ctx.addInitScript(t => localStorage.setItem('erp_token', t), TOKEN)
  const page = await ctx.newPage()
  for (const n of [1, 2, 3]) {
    await page.goto(URL + '/dashboard', { waitUntil: 'commit', timeout: 60000 })
    await page.waitForTimeout(4000)
    const r = await page.evaluate(async () => {
      const t0 = performance.now()
      history.pushState({}, '', '/erp/champs/projects')
      window.dispatchEvent(new PopStateEvent('popstate'))
      let loaderSeen = false, cells = null, mapped = null
      while (performance.now() - t0 < 20000) {
        const txt = document.body.innerText
        if (txt.includes('Chargement des champs Airtable')) loaderSeen = true
        const c = document.querySelectorAll('[data-testid^="fieldcfg-airtable-"]').length
        const m = [...document.querySelectorAll('[data-testid="mapping-airtable-field"]')]
          .filter(e => e.innerText.trim() && !e.innerText.includes('Non mappé')).length
        if (c > 0 && cells === null) cells = Math.round(performance.now() - t0)
        if (m > 0 && mapped === null) { mapped = Math.round(performance.now() - t0); break }
        await new Promise(res => requestAnimationFrame(res))
      }
      return { loaderSeen, cells, mapped }
    })
    console.log(`visite ${n}:`, JSON.stringify(r))
  }
  await browser.close()
})()
