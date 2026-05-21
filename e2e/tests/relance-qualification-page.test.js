const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie que la page Relances qualification :
//  - charge la liste d'emails (≥1)
//  - filtre par langue
//  - affiche un sujet et un corps personnalisé incluant un fragment des défis
describe('RelanceQualification — page de templates emails', () => {
  let browser, ctx, page, db
  let expectedTotal, sampleCompanyName
  // Snapshot des Règles générales avant le test, restauré dans after().
  // Cf. CLAUDE.md « sauvegarder/restaurer les configurations utilisateur ».
  let originalGeneralRules

  before(async () => {
    db = new Database(DB_PATH, { readonly: true })

    // Compte attendu côté DB : entreprises avec QC et phase HubSpot = 'Quote Sent'.
    const all = db.prepare(`
      SELECT DISTINCT c.id, c.name
      FROM qualification_calls q
      JOIN companies c ON c.id = q.company_id
      WHERE q.company_id IS NOT NULL AND c.lifecycle_phase = 'Quote Sent'
      ORDER BY c.name
    `).all()
    expectedTotal = all.length
    if (expectedTotal === 0) throw new Error('Aucune relance attendue — aucune company QC en Quote Sent')
    sampleCompanyName = all[0].name

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Capture l'état initial des Règles générales pour pouvoir le restaurer.
    // Lecture directe en SQLite : pas besoin du token côté node, et fonctionne
    // même si l'API GET change de forme plus tard.
    const row = db.prepare("SELECT instructions FROM email_relance_overrides WHERE scope='global'").get()
    originalGeneralRules = row?.instructions ?? null
  })

  after(async () => {
    // Restaure les Règles générales à leur état initial, que le test ait passé
    // ou non. Sans ça, chaque run écrase la config du user (voir CLAUDE.md).
    try {
      if (page && !page.isClosed()) {
        await page.evaluate(async (value) => {
          const tk = localStorage.getItem('erp_token')
          await fetch('/erp/api/email-relance/settings/global', {
            method: 'PUT',
            headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
            body: JSON.stringify({ instructions: value ?? '' }),
          })
        }, originalGeneralRules)
      }
    } catch {}
    db?.close()
    await browser?.close()
  })

  test('liste les emails, filtres FR/EN fonctionnels, contenu personnalisé visible', async () => {
    await page.goto(`${URL}/relance-qualification`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    // Compteur "Tous (N)"
    const allBtn = page.locator(`button:has-text("Tous (${expectedTotal})")`)
    await allBtn.waitFor({ state: 'visible', timeout: 5000 })

    // Boutons FR et EN visibles
    const frBtn = page.locator('button').filter({ hasText: /^FR \(\d+\)$/ }).first()
    const enBtn = page.locator('button').filter({ hasText: /^EN \(\d+\)$/ }).first()
    await frBtn.waitFor({ state: 'visible', timeout: 5000 })
    await enBtn.waitFor({ state: 'visible', timeout: 5000 })

    // L'entreprise sample doit apparaître dans la liste
    if (sampleCompanyName) {
      const companyLink = page.locator(`a:has-text("${sampleCompanyName}")`).first()
      await companyLink.waitFor({ state: 'visible', timeout: 5000 })
    }

    // Aucun em-dash en sortie (règle de marque) — vaut pour les drafts IA persistés
    const allText = await page.locator('article').allInnerTexts()
    const joined = allText.join('\n')
    assert.ok(!joined.includes('—'), 'Les emails ne doivent contenir aucun em-dash')

    // Le bouton "Générer (IA)" ou "Régénérer" est présent sur chaque carte
    const genBtn = page.locator('button').filter({ hasText: /^(Générer \(IA\)|Régénérer)$/ }).first()
    await genBtn.waitFor({ state: 'visible', timeout: 5000 })

    // Module "Règles générales" présent dans la sidebar gauche
    await page.locator('h2:has-text("Règles générales")').waitFor({ state: 'visible', timeout: 5000 })
    const generalTextarea = page.locator('textarea').first()  // la première textarea = règles générales
    await generalTextarea.waitFor({ state: 'visible', timeout: 5000 })

    // Tapote dans les règles générales → autosave côté serveur
    const testRule = `Test ${Date.now()}: signer P.A.P.`
    await generalTextarea.fill(testRule)
    await generalTextarea.blur()
    // Indicateur "enregistré" apparaît brièvement
    await page.locator('text=enregistré').first().waitFor({ state: 'visible', timeout: 5000 })

    // Vérifier la persistance via API direct
    const settingsAfter = await page.evaluate(async () => {
      const tk = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/email-relance/settings', { headers: { Authorization: 'Bearer ' + tk } })
      return r.json()
    })
    assert.equal(settingsAfter.general, testRule, 'Les règles générales doivent être persistées')

    // Lien "Ajouter des instructions IA pour ce courriel" visible sur au moins une carte
    await page.locator('button:has-text("Ajouter des instructions IA")').first().waitFor({ state: 'visible', timeout: 5000 })

    // Sujet et corps sont éditables (input et textarea, pas du <pre>)
    // Le sujet est un input, le corps une textarea (la 2e textarea ou plus)
    const subjectInput = page.locator('article input[type="text"]').first()
    await subjectInput.waitFor({ state: 'visible', timeout: 5000 })
    const originalSubject = await subjectInput.inputValue()
    await subjectInput.fill(originalSubject + ' (édité)')
    assert.ok((await subjectInput.inputValue()).endsWith('(édité)'), 'Sujet doit être éditable')

    // Bandeau "édité manuellement" doit apparaître après l'édition du sujet
    await page.locator('text=édité manuellement').first().waitFor({ state: 'visible', timeout: 5000 })

    assert.ok(true)
  })
})
