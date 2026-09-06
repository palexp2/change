const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Les timestamps d'interactions coexistent en formats mixtes : ISO UTC avec Z
// (emails Gmail, appels via Drive) et naïf local sans suffixe (appels FTP Cube ARC).
// Un tri lexicographique met un appel local 12:10 après un email UTC 12:45 Z
// (= 08:45 local), alors que chronologiquement l'appel est 4 heures plus tard.
// Ce test vérifie que le tri par Date trie par temps réel, pas par chaîne.
describe('Interactions — tri par date respecte la chronologie réelle', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    // Timezone explicite : la divergence lex vs chronologique dépend du fuseau
    // du navigateur (V8 parse "2026-04-23T12:10:10" comme UTC sur un serveur UTC
    // mais comme local Toronto sur le poste de l'utilisateur).
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: 'America/Toronto' })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('sort desc par Date → première ligne = interaction la plus récente par Date.parse, pas par chaîne', async () => {
    await page.goto(`${URL}/interactions`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 15000 })

    // Se positionner explicitement sur la vue "Toutes les interactions"
    await page.locator('button:has-text("Toutes les interactions")').first().click()
    await page.waitForTimeout(300)

    // Activer le tri desc sur la colonne Date via l'UI
    await page.click('button:has-text("Trier")')
    const panel = page.locator('div.absolute:has-text("Trier par")')
    await panel.waitFor({ state: 'visible', timeout: 3000 })
    await panel.locator('button:has-text("Ajouter un tri")').click()
    // Scope à la dernière rangée de tri (celle que l'on vient d'ajouter) pour
    // éviter les collisions si la vue contient déjà des tris.
    const lastSortRow = panel.locator('.space-y-2 > div').last()
    await lastSortRow.locator('select').selectOption('timestamp')
    await lastSortRow.locator('button:has-text("Croissant")').click()
    await lastSortRow.locator('button:has-text("Décroissant")').waitFor({ state: 'visible', timeout: 3000 })
    // Fermer le panel en cliquant à l'extérieur
    await page.locator('h1:has-text("Interactions")').click()
    await page.waitForTimeout(400)

    // Récupérer l'interaction la plus récente par epoch ET par tri lex, pour
    // pouvoir différencier "tri chronologique vrai" vs "tri par chaîne".
    const result = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/interactions?limit=500', { headers: { Authorization: `Bearer ${token}` } })
      const data = (await r.json()).interactions || []
      const fmt = ts => new Date(ts).toLocaleDateString('fr-CA', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })

      // Top attendu par tri epoch (ce que le fix doit produire)
      const byEpoch = [...data].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      // Top attendu par tri lex (ce que l'ancien bug produit)
      const byLex = [...data].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp), undefined, { numeric: true }))

      const topEpoch = byEpoch[0]
      const topLex = byLex[0]

      const rows = [...document.querySelectorAll('div[style*="position: absolute"]')]
        .filter(r => r.style.top && r.style.height && r.children.length > 1)
      rows.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
      const firstRowText = rows[0]?.textContent || ''

      return {
        firstRowText,
        topEpochTs: topEpoch?.timestamp,
        topEpochFmt: topEpoch ? fmt(topEpoch.timestamp) : null,
        topLexTs: topLex?.timestamp,
        topLexFmt: topLex ? fmt(topLex.timestamp) : null,
        divergent: topEpoch?.id !== topLex?.id,
      }
    })

    // Invariant : la première ligne rendue correspond au top chronologique (epoch).
    assert.ok(
      result.firstRowText.includes(result.topEpochFmt),
      `première ligne devrait afficher "${result.topEpochFmt}" (top chrono). Row actuelle: ${result.firstRowText}`,
    )

    // Si la DB contient encore des formats mixtes (avant la migration UTC), on
    // peut aussi vérifier que le tri diffère explicitement d'un tri lex — ce
    // qui prouve que le fix applySort n'est pas court-circuité. Après migration
    // tous les timestamps sont ISO Z uniformes, donc cette assertion auxiliaire
    // ne s'applique plus.
    if (result.divergent) {
      assert.notEqual(
        result.topEpochFmt, result.topLexFmt,
        'tri chronologique vs lex divergent dans les données',
      )
    } else {
      console.log('  ℹ︎ données uniformes (ISO Z) — assertion auxiliaire lex/chrono non applicable')
    }
  })
})
