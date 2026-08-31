// Fiche projet — l'entreprise s'affiche (et se lie) depuis le panneau Informations.
//
// Bug corrigé : sur /projects/:id l'entreprise n'apparaissait que comme
// sous-titre sous le nom du projet. Un projet sans entreprise n'affichait donc
// RIEN et il n'y avait aucun moyen d'en lier une depuis la fiche. Le panneau
// « Informations » expose maintenant un champ « Entreprise » (picker
// recherchable + lien cliquable vers la fiche entreprise, autosave).
//
// Ce test vérifie :
//   1. projet lié → le champ affiche le nom de l'entreprise en lien vers /companies/:id ;
//   2. projet non lié → le champ propose d'en ajouter une, la sélection est
//      autosauvegardée (persistée après rechargement) ;
//   3. délier remet le champ à l'état vide.
//
// Tous les records sont créés par le test et supprimés dans after() — aucun
// record réel n'est muté (règle CLAUDE.md).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const CO_A = `E2E Entreprise A ${STAMP}`
const CO_B = `E2E Entreprise B ${STAMP}`

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
}

function apiFetch(page, method, p, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const opts = { method, headers: { Authorization: `Bearer ${tok}` } }
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
    const r = await fetch('/erp/api' + path, opts)
    const txt = await r.text()
    try { return JSON.parse(txt) } catch { return { status: r.status, txt } }
  }, { method, path: p, body })
}

describe('Fiche projet — champ Entreprise', () => {
  let browser, ctx, page
  let coA = null, coB = null
  let projLinked = null, projOrphan = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    coA = (await apiFetch(page, 'POST', '/companies', { name: CO_A }))?.id
    coB = (await apiFetch(page, 'POST', '/companies', { name: CO_B }))?.id
    assert.ok(coA && coB, 'les deux entreprises de test doivent être créées')

    projLinked = (await apiFetch(page, 'POST', '/projects', {
      name: `E2E projet lié ${STAMP}`, company_id: coA, status: 'Ouvert',
    }))?.id
    projOrphan = (await apiFetch(page, 'POST', '/projects', {
      name: `E2E projet sans entreprise ${STAMP}`, status: 'Ouvert',
    }))?.id
    assert.ok(projLinked && projOrphan, 'les deux projets de test doivent être créés')
  })

  after(async () => {
    try { if (projLinked) await apiFetch(page, 'DELETE', `/projects/${projLinked}`) } catch {}
    try { if (projOrphan) await apiFetch(page, 'DELETE', `/projects/${projOrphan}`) } catch {}
    try { if (coA) await apiFetch(page, 'DELETE', `/companies/${coA}`) } catch {}
    try { if (coB) await apiFetch(page, 'DELETE', `/companies/${coB}`) } catch {}
    await browser?.close()
  })

  test('un projet lié affiche son entreprise en lien cliquable', async () => {
    await page.goto(`${URL}/projects/${projLinked}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="project-company-field"]', { timeout: 15000 })

    const field = page.locator('[data-testid="project-company-field"]')
    await field.locator('[data-testid="linked-record-link"]').waitFor({ timeout: 10000 })
    const link = field.locator('[data-testid="linked-record-link"]')
    assert.equal((await link.innerText()).trim(), CO_A, 'le champ doit afficher le nom de l\'entreprise liée')
    assert.match(await link.getAttribute('href'), new RegExp(`/companies/${coA}$`),
      'le nom doit pointer vers la fiche entreprise')
  })

  test('un projet sans entreprise permet d\'en lier une (autosave)', async () => {
    await page.goto(`${URL}/projects/${projOrphan}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="project-company-field"]', { timeout: 15000 })

    const field = page.locator('[data-testid="project-company-field"]')
    assert.equal(
      await field.locator('[data-testid="linked-record-field-project_company_id"]').getAttribute('data-state'),
      'empty', 'le champ doit être à l\'état vide avant liaison')

    await field.locator('[data-testid="linked-record-add"]').click()
    await page.waitForSelector('#linked-record-portal', { timeout: 5000 })
    await page.fill('#linked-record-portal input', CO_B)
    await page.click(`#linked-record-portal button:has-text("${CO_B}")`)

    // Autosave : pas de bouton Enregistrer — on attend le PUT puis on recharge.
    await field.locator('[data-testid="linked-record-link"]').waitFor({ timeout: 10000 })
    await page.waitForTimeout(1200)

    await page.goto(`${URL}/projects/${projOrphan}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="project-company-field"]', { timeout: 15000 })
    const after = page.locator('[data-testid="project-company-field"] [data-testid="linked-record-link"]')
    await after.waitFor({ timeout: 10000 })
    assert.equal((await after.innerText()).trim(), CO_B,
      'l\'entreprise choisie doit être persistée et réaffichée après rechargement')

    const fromApi = await apiFetch(page, 'GET', `/projects/${projOrphan}`)
    assert.equal(fromApi.company_id, coB, 'le lien doit être enregistré côté serveur')
  })

  test('délier l\'entreprise remet le champ à vide', async () => {
    await page.goto(`${URL}/projects/${projOrphan}`, { waitUntil: 'domcontentloaded' })
    const field = page.locator('[data-testid="project-company-field"]')
    await field.locator('[data-testid="linked-record-clear"]').waitFor({ timeout: 15000 })
    await field.locator('[data-testid="linked-record-clear"]').click()
    await field.locator('[data-testid="linked-record-add"]').waitFor({ timeout: 10000 })

    const fromApi = await apiFetch(page, 'GET', `/projects/${projOrphan}`)
    assert.equal(fromApi.company_id, null, 'le lien doit être retiré côté serveur')
  })
})
