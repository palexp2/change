import { chromium } from 'playwright-core'
import jwt from 'jsonwebtoken'
import Database from 'better-sqlite3'
import 'dotenv/config'
const db = new Database('/home/ec2-user/erp/server/data/erp.db', { readonly: true })
const user = db.prepare("SELECT id,email FROM users WHERE role='admin' LIMIT 1").get()
const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '10m' })
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await ctx.addInitScript(t => { localStorage.setItem('erp_token', t) }, token)
const page = await ctx.newPage()
const errs = []
page.on('pageerror', e => errs.push(String(e)))
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
await page.goto('http://localhost:3004/erp' + process.argv[2], { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(7000)
const sel = process.argv[4]
if (sel) {
  const el = page.locator(sel).first()
  await el.scrollIntoViewIfNeeded().catch(() => {})
  await page.waitForTimeout(1500)
  await el.screenshot({ path: process.argv[3] }).catch(async () => { await page.screenshot({ path: process.argv[3] }) })
} else {
  await page.screenshot({ path: process.argv[3], fullPage: false })
}
console.log('ERREURS:', errs.slice(0, 8))
await browser.close()
