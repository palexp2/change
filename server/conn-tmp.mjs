import { chromium } from 'playwright-core'
import jwt from 'jsonwebtoken'
import Database from 'better-sqlite3'
import 'dotenv/config'
const db = new Database('/home/ec2-user/erp/server/data/erp.db', { readonly: true })
const user = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()
const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '10m' })
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH })
const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 } })
await ctx.addInitScript(t => localStorage.setItem('erp_token', t), token)
const page = await ctx.newPage()
const errs = []; page.on('pageerror', e => errs.push(String(e)))
await page.goto('http://localhost:3004/erp/connectors', { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(3000)
const card = page.locator('div', { hasText: /^Plaid/ }).last(); await card.click().catch(()=>{})
await page.waitForTimeout(10000)
await page.screenshot({ path: '/tmp/claude-1000/-home-ec2-user-erp/bc81025c-963f-4c1d-b691-47f5b38a0b9b/scratchpad/conn.png' })
console.log('ERREURS:', errs.slice(0, 5))
await b.close()
