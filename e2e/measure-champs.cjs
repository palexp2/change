const { chromium } = require('playwright')
const URL = 'http://localhost:3004/erp'
const TOKEN = process.argv[2]
;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  await ctx.addInitScript(t => localStorage.setItem('erp_token', t), TOKEN)
  const page = await ctx.newPage()
  const reqs = []
  let t0 = Date.now()
  page.on('request', r => { if (r.url().includes('/api/')) reqs.push({ u: r.url().replace(/.*\/api/, ''), start: Date.now() - t0, req: r }) })
  page.on('requestfinished', r => { const e = reqs.find(x => x.req === r); if (e) e.end = Date.now() - t0 })

  async function visit(label, { hover } = {}) {
    await page.goto(URL + '/dashboard', { waitUntil: 'commit', timeout: 60000 })
    await page.waitForTimeout(4000)
    reqs.length = 0
    t0 = Date.now()
    await page.evaluate(() => { history.pushState({}, '', '/erp/champs/projects'); window.dispatchEvent(new PopStateEvent('popstate')) })
    await page.waitForSelector('[data-testid="fieldcfg-panel"]', { timeout: 40000 })
    const painted = Date.now() - t0
    const loaderSeen = await page.waitForFunction(() => document.body.innerText.includes('Chargement des champs Airtable'), { timeout: 1500 }).then(() => true).catch(() => false)
    await page.waitForFunction(() => !document.body.innerText.includes('Chargement des champs Airtable') && document.querySelectorAll('[data-testid^="fieldcfg-airtable-"]').length > 0, { timeout: 40000 })
    const ready = Date.now() - t0
    const mapped = await page.locator('[data-testid="mapping-airtable-field"]').count()
    console.log(`[${label}] panneau ${painted}ms | champs Airtable ${ready}ms | message de chargement vu: ${loaderSeen} | lignes ${await page.locator('[data-testid^="fieldcfg-row-"]').count()} | pickers ${mapped}`)
    for (const q of reqs) console.log(`   ${String(q.start).padStart(5)} → ${String(q.end ?? -1).padStart(5)} ${q.u}`)
  }

  await visit('1re visite (cache vide)')
  await visit('2e visite (cache chaud)')
  // 3e : survol du bouton avant le clic, cache local vidé
  await page.evaluate(() => { Object.keys(localStorage).filter(k => k.startsWith('erp.swr:')).forEach(k => localStorage.removeItem(k)) })
  await page.goto(URL + '/projets', { waitUntil: 'commit', timeout: 60000 })
  await page.waitForSelector('[data-panel-btn="field-config"]', { timeout: 40000 })
  await page.waitForTimeout(3000)
  reqs.length = 0
  t0 = Date.now()
  await page.hover('[data-panel-btn="field-config"]')
  await page.waitForTimeout(400)
  await page.click('[data-panel-btn="field-config"]')
  await page.waitForSelector('[data-testid="fieldcfg-panel"]', { timeout: 40000 })
  console.log('[survol puis clic] url', page.url(), 'panneau', Date.now() - t0, 'ms')
  const seen = await page.waitForFunction(() => document.body.innerText.includes('Chargement des champs Airtable'), { timeout: 1200 }).then(() => true).catch(() => false)
  await page.waitForFunction(() => !document.body.innerText.includes('Chargement des champs Airtable') && document.querySelectorAll('[data-testid^="fieldcfg-airtable-"]').length > 0, { timeout: 40000 })
  console.log('[survol puis clic] champs Airtable', Date.now() - t0, 'ms | message vu:', seen)
  for (const q of reqs) console.log(`   ${String(q.start).padStart(5)} → ${String(q.end ?? -1).padStart(5)} ${q.u}`)
  await browser.close()
})()
