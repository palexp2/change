const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const { writeFileSync, mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const ORIGIN = new global.URL(URL).origin

// Remplacement d'un fichier dans « Fichiers publics » : on uploade un fichier A,
// puis on le remplace par un fichier B via le bouton « Remplacer le fichier ».
// Le lien public (token) doit rester IDENTIQUE et servir désormais le contenu de B.
// Le fichier créé est supprimé dans after() (record E2E → cleanup obligatoire).
describe('Fichiers publics — remplacer un fichier garde le même lien', () => {
  let browser, ctx, page, jwt, tmp
  let createdId = null
  const NAME_A = `e2e-replace-A-${Date.now()}.txt`
  const NAME_B = `e2e-replace-B-${Date.now()}.txt`
  const CONTENT_A = 'AAAA-original'
  const CONTENT_B = 'BBBBBBBBBBBBBBBB-remplacement-plus-long-' + 'B'.repeat(2000)

  async function apiCall(method, path) {
    const res = await fetch(`${URL}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}` },
    })
    let json = null
    try { json = await res.json() } catch {}
    return { status: res.status, json }
  }

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'erp-e2e-'))
    writeFileSync(join(tmp, NAME_A), CONTENT_A)
    writeFileSync(join(tmp, NAME_B), CONTENT_B)

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: 'America/Montreal' })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    jwt = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => {
    // Supprime le fichier public créé par le test (même en cas d'échec).
    if (!createdId && jwt) {
      try {
        const { json } = await apiCall('GET', '/public-files')
        const row = (json?.data || []).find(f => f.original_name === NAME_A || f.original_name === NAME_B)
        if (row) createdId = row.id
      } catch {}
    }
    if (createdId) { try { await apiCall('DELETE', `/public-files/${createdId}`) } catch {} }
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }) } catch {} }
    await browser?.close()
  })

  test('upload A → remplace par B : token inchangé, contenu mis à jour', async () => {
    await page.goto(URL + '/public-files', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="public-files-input"]', { state: 'attached', timeout: 15000 })

    // 1) Upload du fichier A, puis attendre le toast de succès.
    await page.setInputFiles('[data-testid="public-files-input"]', join(tmp, NAME_A))
    await page.getByText(`${NAME_A} téléversé`).waitFor({ state: 'visible', timeout: 20000 })

    // Recharge la page : la liste est servie depuis un cache mémoire (TTL ~30s)
    // que l'upload n'invalide pas → un reload complet réinitialise ce cache et
    // fait apparaître le nouveau fichier.
    await page.goto(URL + '/public-files', { waitUntil: 'domcontentloaded' })

    // Filtre la table sur le nom (placeholder « Rechercher… » propre à la
    // DataTable ; la recherche globale CRM a un placeholder distinct). Garantit
    // que la ligne est rendue ET visible (sinon virtualisée hors écran).
    const search = page.getByPlaceholder('Rechercher...').first()
    await search.waitFor({ state: 'visible', timeout: 15000 })
    await search.fill(NAME_A)

    // La cellule « nom » de la DataTable est un <span class="font-medium">.
    const rowA = page.locator('span.font-medium', { hasText: NAME_A }).first()
    await rowA.waitFor({ state: 'visible', timeout: 15000 })

    // 2) Ouvre la modale de détail (clic sur la ligne).
    await rowA.click()
    const codeEl = page.locator('code:has-text("/erp/p/")')
    await codeEl.waitFor({ state: 'visible', timeout: 5000 })
    const urlBefore = (await codeEl.innerText()).trim()
    const token = urlBefore.split('/erp/p/')[1]
    assert.ok(token && token.length >= 16, `token extrait (${token})`)

    // Capture l'id pour le cleanup.
    const before = await apiCall('GET', '/public-files')
    createdId = (before.json?.data || []).find(f => f.original_name === NAME_A)?.id || null

    // Le lien public sert bien le contenu de A.
    const servedA = await fetch(`${ORIGIN}/erp/p/${token}?_=${token}A`).then(r => r.text())
    assert.equal(servedA, CONTENT_A, 'le lien sert le contenu A avant remplacement')

    // 3) Remplace par B → confirmation (Entrée).
    await page.setInputFiles('[data-testid="replace-file-input"]', join(tmp, NAME_B))
    await page.waitForSelector('text=Remplacer le fichier ?', { timeout: 5000 }) // titre du confirm
    await page.keyboard.press('Enter')

    // Le nom affiché passe à B (preuve que le remplacement a abouti).
    await page.waitForFunction(
      (n) => document.querySelector('[data-testid="edit-original-name"]')?.value === n,
      NAME_B,
      { timeout: 10000 },
    )

    // 4) Token / lien public INCHANGÉ.
    const urlAfter = (await page.locator('code:has-text("/erp/p/")').innerText()).trim()
    assert.equal(urlAfter, urlBefore, 'le lien public est identique après remplacement')

    // 5) Le lien sert désormais le contenu de B (cache-bust pour contourner max-age).
    const servedB = await fetch(`${ORIGIN}/erp/p/${token}?_=${token}B`).then(r => r.text())
    assert.equal(servedB, CONTENT_B, 'le lien sert le contenu B après remplacement')
  })
})
