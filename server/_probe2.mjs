import { chromium } from 'playwright-core'
const b = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1217/chrome-linux/chrome' })
const ctx = await b.newContext({ viewport: { width: 1500, height: 1100 } })
await ctx.addInitScript(t => { localStorage.setItem('erp_token', t); localStorage.setItem('erp.theme', 'dark') }, process.env.TOK)
const p = await ctx.newPage()
await p.goto('http://localhost:3004/erp/companies/3b49d28b-270c-4996-836a-ac042bd4796c', { waitUntil: 'networkidle' })
await p.waitForTimeout(5000)
console.log(JSON.stringify(await p.evaluate(() => {
  const f = document.querySelector('section[data-section="interactions"] iframe')
  if (!f) return { none: true }
  const d = f.contentDocument
  return {
    srcDocHead: (f.getAttribute('srcdoc') || '').slice(0, 420),
    bodyBg: d && getComputedStyle(d.body).backgroundColor,
    htmlBg: d && getComputedStyle(d.documentElement).backgroundColor,
    bodyColor: d && getComputedStyle(d.body).color,
    frameBg: getComputedStyle(f).backgroundColor,
  }
})))
await b.close()
