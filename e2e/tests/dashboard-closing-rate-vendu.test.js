const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const API = URL.replace(/\/erp\/?$/, '') + '/api'
// Les lignes du DataTable sont virtualisées : divs en grid positionnés en absolu.
const ROW_SEL = 'div[style*="display: grid"][style*="position: absolute"]'

// Lecture seule : ce test ne crée ni ne modifie aucun record.
describe('Dashboard — Taux de closing basé sur le champ « Vendu »', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('Les compteurs gagnés/perdus proviennent du champ « Vendu », pas de status', async () => {
    const token = await page.evaluate(() => localStorage.getItem('erp_token'))
    assert.ok(token, 'token absent du localStorage')

    const fetchJson = async path => page.evaluate(async ([u, t]) => {
      const r = await fetch(u, { headers: { Authorization: 'Bearer ' + t } })
      return { ok: r.ok, status: r.status, body: await r.json() }
    }, [path, token])

    const dash = await fetchJson(API + '/dashboard')
    assert.equal(dash.ok, true, `GET /api/dashboard a échoué (${dash.status})`)
    const rows = dash.body.closingByMonth
    assert.ok(Array.isArray(rows) && rows.length > 0, 'closingByMonth est vide')

    const projRes = await fetchJson(API + '/projects?limit=all')
    assert.equal(projRes.ok, true, `GET /api/projects a échoué (${projRes.status})`)
    const projects = projRes.body.data

    // Le champ « Vendu » doit être le seul discriminant : si aucun projet n'a le
    // status 'Gagné'/'Perdu', l'ancienne implémentation aurait renvoyé 0 partout.
    const withLegacyStatus = projects.filter(p => p.status === 'Gagné' || p.status === 'Perdu').length
    const totalCounted = rows.reduce((s, r) => s + r.won + r.lost, 0)
    assert.ok(totalCounted > 0, 'Aucun projet compté dans le taux de closing')
    if (withLegacyStatus === 0) {
      assert.ok(totalCounted > 0, 'Le graphique doit compter des projets via « Vendu » même sans status Gagné/Perdu')
    }

    // Recalcul indépendant depuis les projets : Vendu=Oui → gagné, Vendu=Non → perdu,
    // bucketé sur close_date sinon creation, sur les 12 derniers mois.
    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - 12)
    const cutoffStr = cutoff.toISOString().slice(0, 10)

    const expected = new Map()
    for (const p of projects) {
      const vendu = p.cf_vendu
      if (vendu !== 'Oui' && vendu !== 'Non') continue
      const d = (p.close_date || p.creation || '')
      if (!d || d.slice(0, 10) < cutoffStr) continue
      const key = `${d.slice(0, 7)}|${p.type || ''}`
      const cur = expected.get(key) || { won: 0, lost: 0 }
      if (vendu === 'Oui') cur.won++; else cur.lost++
      expected.set(key, cur)
    }

    for (const r of rows) {
      const key = `${r.month}|${r.type}`
      const exp = expected.get(key)
      assert.ok(exp, `Ligne inattendue dans closingByMonth: ${key}`)
      assert.equal(r.won, exp.won, `gagnés (Vendu=Oui) pour ${key}`)
      assert.equal(r.lost, exp.lost, `perdus (Vendu=Non) pour ${key}`)
    }
    assert.equal(rows.length, expected.size, 'Nombre de buckets mois×type différent du recalcul')
  })

})
