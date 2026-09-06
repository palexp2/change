import { chromium } from 'playwright-core'
const TOKEN = process.env.TOK
const URL = 'http://localhost:3004/erp/companies/3b49d28b-270c-4996-836a-ac042bd4796c'
const b = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1217/chrome-linux/chrome' })
const ctx = await b.newContext({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 2 })
await ctx.addInitScript(t => localStorage.setItem('erp_token', t), TOKEN)
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'networkidle' })
await p.waitForTimeout(4000)
const sec = p.locator('section[data-section="interactions"]')
await sec.scrollIntoViewIfNeeded()
await p.waitForTimeout(2500)
await p.screenshot({ path: '/tmp/inter_a.png' })
// défilement d'un écran pour voir plus d'entrées
await p.evaluate(() => {
  const el = document.querySelector('section[data-section="interactions"]')
  let par = el.parentElement
  while (par && !/(auto|scroll|overlay)/.test(getComputedStyle(par).overflowY)) par = par.parentElement
  ;(par || document.scrollingElement).scrollBy(0, 900)
})
await p.waitForTimeout(1200)
await p.screenshot({ path: '/tmp/inter_b.png' })
await b.close()
