const { chromium } = require('playwright')
const URL = 'http://localhost:3004/erp'
const TOKEN = process.argv[2]
;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  await ctx.addInitScript(t => localStorage.setItem('erp_token', t), TOKEN)
  const page = await ctx.newPage()
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0,150)) })
  for (const n of [1, 2]) {
    await page.goto(URL + '/dashboard', { waitUntil: 'commit', timeout: 60000 })
    await page.waitForTimeout(4000)
    const t0 = Date.now()
    await page.evaluate(() => { history.pushState({}, '', '/erp/champs/projects'); window.dispatchEvent(new PopStateEvent('popstate')) })
    await page.waitForSelector('[data-testid="fieldcfg-panel"]', { timeout: 40000 })
    for (let i = 0; i < 8; i++) {
      const s = await page.evaluate(() => {
        const t = document.body.innerText
        return {
          loader: t.includes('Chargement des champs Airtable'),
          cfg: t.includes('Chargement de la configuration'),
          cells: document.querySelectorAll('[data-testid^="fieldcfg-airtable-"]').length,
          rows: document.querySelectorAll('[data-testid^="fieldcfg-row-"]').length,
          count: (t.match(/\d+ champs?/) || [''])[0],
        }
      })
      console.log(`visite ${n} @${Date.now()-t0}ms`, JSON.stringify(s))
      if (!s.loader && s.cells > 0) break
      await page.waitForTimeout(300)
    }
  }
  await browser.close()
})()
