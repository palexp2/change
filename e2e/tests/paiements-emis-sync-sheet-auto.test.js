// /paiements-emis — la feuille Pmt_Suivi se relit TOUTE SEULE aux 30 minutes.
//
// Demande de Charles : « je veux que cette fonction se fasse automatiquement à
// chaque 30 min » (bouton « Synchroniser la feuille »). L'import existait, mais
// seulement à la main.
//
// Le test vérifie :
//   1. l'automation système sys_pmt_suivi_sheet existe, est active, et son
//      déclencheur annonce bien la cadence de 30 minutes ;
//   2. l'état de la sync est exposé à la page (/treasury/payments/sheet-status) ;
//   3. la page affiche depuis quand elle est à jour, et le bouton se lit comme
//      « forcer maintenant » (son infobulle mentionne la sync automatique) ;
//   4. un échec de la sync automatique se VOIT (texte rouge), il ne reste pas
//      dans un journal que personne ne lit.
//
// Aucun record n'est créé ni modifié : on lit l'automation en GET et l'état de
// la page est servi par une interception (page.route) — le vrai import irait
// lire Google Drive.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Paiements émis — sync automatique de la feuille (30 min)', () => {
  let browser, ctx, page
  // État renvoyé à la place du vrai statut, réglé par chaque test.
  let fakeStatus = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } })
    page = await ctx.newPage()

    await page.route(/\/erp\/api\/treasury\/payments\/sheet-status$/, async route => {
      if (!fakeStatus) return route.continue()
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeStatus) })
    })
    // Filet de sécurité : jamais d'import réel depuis ce test.
    await page.route(/\/erp\/api\/treasury\/payments\/import-sheet$/, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ created: 0, updated: 0 }) }))

    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    // Rien à nettoyer : aucune écriture, l'automation n'a été lue qu'en GET.
    await browser?.close()
  })

  test('l\'automation système existe, est active et annonce les 30 minutes', async () => {
    const auto = await page.evaluate(async () => {
      const r = await fetch('/erp/api/automations/sys_pmt_suivi_sheet', {
        headers: { Authorization: `Bearer ${localStorage.getItem('erp_token')}` },
      })
      return r.ok ? r.json() : { error: r.status }
    })
    assert.ok(!auto.error, `automation introuvable (${auto.error})`)
    assert.equal(auto.active, 1, 'la sync automatique doit être active')
    const trigger = typeof auto.trigger_config === 'string' ? JSON.parse(auto.trigger_config) : auto.trigger_config
    assert.match(`${trigger.source} ${trigger.summary}`, /30\s*min/i,
      `le déclencheur doit annoncer la cadence de 30 min, vu : ${JSON.stringify(trigger)}`)
  })

  test('l\'état de la sync est exposé à la page', async () => {
    const st = await page.evaluate(async () => {
      const r = await fetch('/erp/api/treasury/payments/sheet-status', {
        headers: { Authorization: `Bearer ${localStorage.getItem('erp_token')}` },
      })
      return r.ok ? r.json() : { error: r.status }
    })
    assert.ok(!st.error, `sheet-status indisponible (${st.error})`)
    assert.equal(st.active, true)
    assert.equal(st.interval_minutes, 30)
  })

  test('la page dit depuis quand elle est à jour, sans absorber le bouton', async () => {
    fakeStatus = {
      active: true,
      interval_minutes: 30,
      last_run: {
        status: 'success',
        executed_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
        summary: '0 ajouté(s) · 3 mis à jour · 41 ligne(s) lue(s)',
      },
    }
    await page.goto(`${URL}/paiements-emis?onglet=pending`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="payments-sync-sheet"]', { timeout: 20000 })

    const status = page.locator('[data-testid="payments-sheet-sync-status"]')
    await status.waitFor({ state: 'visible', timeout: 10000 })
    assert.match(await status.innerText(), /relue automatiquement toutes les 30 min/i)
    assert.match(await status.innerText(), /à jour il y a 12\s*min/i)

    // L'état est une PHRASE sous le titre, pas un voisin du bouton : c'est ce
    // voisinage qui faisait lire le bouton comme du texte (retour de Charles).
    const btn = page.locator('[data-testid="payments-sync-sheet"]')
    const sameRow = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="payments-sync-sheet"]')
      const s = document.querySelector('[data-testid="payments-sheet-sync-status"]')
      return !!(b && s && b.parentElement === s.parentElement)
    })
    assert.equal(sameRow, false, 'l\'état ne doit pas être dans la barre d\'actions du bouton')

    const btnTitle = await btn.getAttribute('title')
    assert.match(btnTitle, /toutes les 30 minutes/i,
      `l'infobulle du bouton doit rappeler la relecture automatique, vue : ${btnTitle}`)
  })

  test('le bouton de synchronisation manuelle reste bien là, y compris dans la cédule', async () => {
    fakeStatus = {
      active: true,
      interval_minutes: 30,
      last_run: { status: 'success', executed_at: new Date().toISOString(), summary: 'rien de nouveau' },
    }
    // L'onglet où Charles a signalé le problème.
    await page.goto(`${URL}/paiements-emis?onglet=cedule`, { waitUntil: 'domcontentloaded' })
    const btn = page.locator('[data-testid="payments-sync-sheet"]')
    await btn.waitFor({ state: 'visible', timeout: 20000 })

    // Un vrai bouton : libellé toujours écrit (pas seulement une icône),
    // cliquable, et il déclenche la relecture (POST intercepté).
    assert.match(await btn.innerText(), /Synchroniser la feuille/i)
    assert.equal(await btn.isEnabled(), true)
    const cls = await btn.getAttribute('class')
    assert.match(cls, /border-slate-300/, 'le bouton doit garder une bordure franche')

    const posted = page.waitForRequest(r => /\/erp\/api\/treasury\/payments\/import-sheet$/.test(r.url()), { timeout: 20000 })
    await btn.click()
    await posted
    await page.waitForFunction(() => document.body.innerText.includes('Feuille synchronisée'), null, { timeout: 20000 })
  })

  test('la fiche automation permet de régler le fichier et le plancher d\'import', async () => {
    await page.goto(`${URL}/automations/sys_pmt_suivi_sheet`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="generic-config"]', { timeout: 20000 })
    for (const key of ['file_id', 'sheet_name', 'google_account_email', 'since_date']) {
      assert.equal(await page.locator(`[data-testid="generic-config-${key}"]`).count(), 1,
        `le champ ${key} doit être éditable dans la fiche`)
    }
    // Lecture seule : aucune valeur n'est modifiée (l'autosave écrirait la config).
  })

  test('un échec de la sync automatique se voit sur la page', async () => {
    fakeStatus = {
      active: true,
      interval_minutes: 30,
      last_run: {
        status: 'error',
        executed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        error: 'Aucun compte Google connecté (page Connecteurs)',
      },
    }
    await page.goto(`${URL}/paiements-emis?onglet=pending`, { waitUntil: 'domcontentloaded' })
    const status = page.locator('[data-testid="payments-sheet-sync-status"]')
    await status.waitFor({ state: 'visible', timeout: 20000 })
    assert.match(await status.innerText(), /échec/i)
    assert.match(await status.innerText(), /Aucun compte Google connecté/)
    assert.match(await status.getAttribute('class'), /rose/, 'l\'échec doit être en rouge')
    // Et le bouton manuel reste utilisable pour retenter tout de suite.
    assert.equal(await page.locator('[data-testid="payments-sync-sheet"]').isEnabled(), true)
  })
})
