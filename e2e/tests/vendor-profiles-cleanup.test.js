const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Ménage fournisseurs : détection de doublons par suffixe légal (« X » / « X Inc »),
// « Ignorer » persistant (vendor_duplicate_dismissals), et section « sans activité
// récente » avec archivage en lot. Records jetables uniquement, nettoyés en after().
const TS = Date.now()
const NAME_A = `E2E FournDoublon ${TS}`
const NAME_B = `E2E FournDoublon ${TS} Inc`

describe('Fournisseurs — doublons ignorés persistants + archivage des inactifs', () => {
  let browser, ctx, page, token
  let profileA, profileB

  async function api(method, path, body) {
    const res = await fetch(`${URL}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }

  before(async () => {
    const login = await fetch(`${URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    }).then(r => r.json())
    token = login.token
    assert.ok(token, 'login a échoué')

    profileA = (await api('POST', '/vendor-profiles', { name: NAME_A })).body
    profileB = (await api('POST', '/vendor-profiles', { name: NAME_B })).body
    assert.ok(profileA.id && profileB.id, 'création des profils jetables a échoué')

    browser = await chromium.launch()
    ctx = await browser.newContext()
    page = await ctx.newPage()
    await page.addInitScript(t => localStorage.setItem('erp_token', t), token)
  })

  after(async () => {
    // Nettoyage : retire le dismissal créé par le clic UI (POST dismiss est idempotent
    // et retourne l'id existant), puis archive les profils jetables.
    if (token && profileA?.id && profileB?.id) {
      const d = await api('POST', '/vendor-profiles/duplicates/dismiss', { ids: [profileA.id, profileB.id] })
      if (d.body?.id) await api('DELETE', `/vendor-profiles/duplicates/dismissals/${d.body.id}`)
    }
    if (token) for (const p of [profileA, profileB]) if (p?.id) await api('DELETE', `/vendor-profiles/${p.id}`)
    await browser?.close()
  })

  test('les deux profils jetables forment un groupe de doublons (suffixe légal)', async () => {
    const r = await api('GET', '/vendor-profiles/duplicates')
    assert.equal(r.status, 200)
    const group = r.body.data.find(g => g.some(p => p.id === profileA.id))
    assert.ok(group, 'groupe attendu introuvable')
    assert.ok(group.some(p => p.id === profileB.id), '« X Inc » devrait être groupé avec « X »')
  })

  test('« Ignorer » masque le groupe de façon persistante (survit au rechargement)', async () => {
    await page.goto(`${URL}/fournisseurs`, { waitUntil: 'networkidle' })
    const section = page.locator('[data-testid="vendor-duplicates"]')
    await section.waitFor({ timeout: 15000 })
    const row = section.locator('div.rounded-md').filter({ hasText: NAME_A })
    await row.waitFor({ timeout: 10000 })
    await row.getByRole('button', { name: /^Ignorer/ }).click()
    await row.waitFor({ state: 'detached', timeout: 10000 })

    // Persistance : l'API ne re-propose plus le groupe.
    let gone = false
    for (let i = 0; i < 20 && !gone; i++) {
      const r = await api('GET', '/vendor-profiles/duplicates')
      gone = !r.body.data.some(g => g.some(p => p.id === profileA.id))
      if (!gone) await new Promise(res => setTimeout(res, 500))
    }
    assert.ok(gone, 'le groupe ignoré ne devrait plus sortir de /duplicates')

    await page.reload({ waitUntil: 'networkidle' })
    assert.equal(await page.locator(`[data-testid="vendor-duplicates"] >> text=${NAME_A}`).count(), 0,
      'le groupe ignoré ne devrait pas réapparaître après rechargement')
  })

  test('section inactifs : archivage en lot d\'un profil sans activité', async () => {
    const inactive = page.locator('[data-testid="vendor-inactive"]')
    await inactive.waitFor({ timeout: 15000 })
    await inactive.locator('button').first().click() // déplie la section

    const row = page.locator(`[data-testid="vendor-inactive-row-${profileB.id}"]`)
    await row.waitFor({ timeout: 10000 })
    await row.locator('input[type="checkbox"]').click()

    page.once('dialog', d => d.accept())
    await page.locator('[data-testid="vendor-inactive-archive"]').click()

    // Validation par l'API (pas par l'état DOM immédiat) : le profil est soft-deleté.
    let archived = false
    for (let i = 0; i < 20 && !archived; i++) {
      const r = await api('GET', '/vendor-profiles')
      archived = !r.body.data.some(p => p.id === profileB.id)
      if (!archived) await new Promise(res => setTimeout(res, 500))
    }
    assert.ok(archived, 'le profil sélectionné devrait être archivé')
    await row.waitFor({ state: 'detached', timeout: 10000 })
  })
})
