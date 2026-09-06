const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Inject a fake MediaStream so getUserMedia resolves in headless Chromium
// without needing real camera hardware or browser flags.
const fakeMediaInit = `
  (function () {
    function makeFakeStream() {
      const canvas = document.createElement('canvas')
      canvas.width = 640; canvas.height = 480
      const ctx = canvas.getContext('2d')
      // Animate a frame so capture produces a non-empty image
      let t = 0
      function draw() {
        ctx.fillStyle = '#0a84ff'; ctx.fillRect(0, 0, 640, 480)
        ctx.fillStyle = '#fff'; ctx.font = '32px sans-serif'
        ctx.fillText('FAKE CAM ' + (t++), 60, 240)
        requestAnimationFrame(draw)
      }
      draw()
      return canvas.captureStream(30)
    }
    if (!navigator.mediaDevices) navigator.mediaDevices = {}
    navigator.mediaDevices.getUserMedia = async () => makeFakeStream()
  })()
`

describe("Extraction de données : capture webcam", () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await ctx.addInitScript(fakeMediaInit)
    page = await ctx.newPage()

    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test("le bouton webcam ouvre la modale, affiche le flux, et permet de capturer", async () => {
    await page.goto(URL + '/sale-receipts', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Extraction de données")', { timeout: 10000 })

    // Bouton présent dans la sidebar
    const openBtn = page.getByTestId('open-webcam')
    await openBtn.waitFor({ state: 'visible', timeout: 5000 })
    assert.ok(await openBtn.isVisible(), 'le bouton "Capturer avec la caméra" doit être visible')

    // Ouverture de la modale
    await openBtn.click()
    await page.waitForSelector('h2:has-text("Capturer avec la caméra")', { timeout: 5000 })

    // Le flux vidéo monte (et le bouton Capturer devient actif une fois la caméra démarrée)
    const video = page.getByTestId('webcam-video')
    await video.waitFor({ state: 'attached', timeout: 5000 })

    const captureBtn = page.getByTestId('webcam-capture')
    await captureBtn.waitFor({ state: 'visible', timeout: 5000 })
    // Attendre que getUserMedia ait résolu et que starting passe à false
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="webcam-capture"]')
      return btn && !btn.disabled
    }, { timeout: 5000 })

    // Capture → preview visible, boutons Reprendre/Utiliser cette photo apparaissent
    await captureBtn.click()
    await page.getByTestId('webcam-preview').waitFor({ state: 'visible', timeout: 5000 })
    const confirmBtn = page.getByTestId('webcam-confirm')
    await confirmBtn.waitFor({ state: 'visible', timeout: 3000 })
    assert.ok(await page.locator('button:has-text("Reprendre")').isVisible(), 'le bouton Reprendre doit être visible après capture')

    // Reprendre revient au flux vidéo
    await page.locator('button:has-text("Reprendre")').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="webcam-preview"]'), { timeout: 3000 })
    await page.getByTestId('webcam-capture').waitFor({ state: 'visible', timeout: 3000 })

    // Fermeture propre via le bouton X de la modale (header)
    await page.locator('h2:has-text("Capturer avec la caméra")').locator('..').locator('button').click()
    await page.waitForFunction(() => !document.querySelector('h2')?.textContent?.includes('Capturer avec la caméra'), { timeout: 3000 })
  })
})
