const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Tasks — autosave en mode édition', () => {
  let browser, ctx, page, createdId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Crée une tâche jetable directement via l'API (pas via l'UI testée).
    createdId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/tasks', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `E2E autosave ${Date.now()}`, status: 'À faire', priority: 'Normal' }),
      }).then(r => r.json())
      return r.id
    })
  })

  after(async () => {
    if (createdId) {
      await page.evaluate(async (id) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/tasks/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }, createdId)
    }
    await browser?.close()
  })

  test('la modale d\'édition n\'affiche pas de bouton « Enregistrer » et autosave le titre', async () => {
    await page.goto(`${URL}/tasks`, { waitUntil: 'networkidle' })
    const initial = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      return fetch(`/erp/api/tasks/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
    }, createdId)

    // La vue par défaut « Mes tâches » filtre sur le responsable ; la tâche de
    // test n'a pas de responsable → on bascule sur « Toutes les tâches ».
    await page.click('text=Toutes les tâches')
    await page.waitForTimeout(300)
    // Recherche la tâche par son titre puis ouvre la ligne.
    await page.locator('input[placeholder="Rechercher..."]').first().fill(initial.title)
    await page.waitForTimeout(500)
    await page.click(`text=${initial.title}`)
    await page.waitForSelector('text=Modifier la tâche', { timeout: 5000 })

    // Mode édition : pas de bouton « Enregistrer », bouton « Fermer » présent.
    const enregistrerCount = await page.locator('button:has-text("Enregistrer")').count()
    assert.equal(enregistrerCount, 0, 'aucun bouton « Enregistrer » en mode édition')
    await page.waitForSelector('button:has-text("Fermer")', { timeout: 3000 })

    // Modifie le titre et blur → autosave attendu.
    const newTitle = `E2E autosave modif ${Date.now()}`
    const titleInput = page.locator('input[placeholder="Titre de la tâche"]')
    await titleInput.fill(newTitle)
    await titleInput.blur()

    // L'indicateur « Sauvegardé » apparaît (preuve que l'autosave a tourné).
    await page.waitForSelector('text=Sauvegardé', { timeout: 5000 })

    // Vérifie la persistance côté serveur.
    await page.waitForFunction(async (args) => {
      const token = localStorage.getItem('erp_token')
      const t = await fetch(`/erp/api/tasks/${args.id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return t.title === args.newTitle
    }, { id: createdId, newTitle }, { timeout: 5000 })

    // Modifie aussi le statut (select → autosave immédiat) et vérifie.
    await page.selectOption('label:has-text("Statut") + select', 'En cours')
    await page.waitForFunction(async (id) => {
      const token = localStorage.getItem('erp_token')
      const t = await fetch(`/erp/api/tasks/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return t.status === 'En cours'
    }, createdId, { timeout: 5000 })

    await page.click('button:has-text("Fermer")')
  })

  test('le formulaire « Nouvelle tâche » conserve son bouton « Enregistrer »', async () => {
    await page.goto(`${URL}/tasks`, { waitUntil: 'networkidle' })
    await page.click('button:has-text("Nouvelle tâche")')
    await page.waitForSelector('text=Nouvelle tâche', { timeout: 5000 })
    await page.waitForSelector('button:has-text("Enregistrer")', { timeout: 3000 })
    await page.keyboard.press('Escape')
  })
})
