const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
const TOKEN = process.env.ERP_TOKEN // alternative au login par mot de passe (JWT injecté)
if (!PASS && !TOKEN) throw new Error('ERP_PASS ou ERP_TOKEN env var requis')

// Régression (signalé par Pierre-Alexandre depuis /factures) : masquer un champ
// dans la config de vue ne persistait pas au rechargement. Cause : l'effet
// « auto-affichage des nouveaux champs custom » de DataTable prenait la Map vide
// TRANSITOIRE de customFieldsByColumn (le fetch des champs custom n'ayant pas
// encore résolu) comme baseline ; à l'arrivée des champs, toutes les clés
// paraissaient « nouvelles » et étaient ré-ajoutées à la vue — ré-affichant
// silencieusement les colonnes custom que l'utilisateur venait de masquer, puis
// l'autosave persistait cette ré-addition. Le fix attend le flag `loaded` du hook
// useCustomFields avant d'établir la baseline.
//
// Ce test masque (a) une colonne standard et (b) une colonne de champ custom, via
// l'API de la vue active, recharge la page, laisse l'effet auto-affichage tourner,
// puis vérifie que LES DEUX restent masquées côté serveur. Il snapshot + restaure
// les colonnes visibles de la vue (config globale) — voir CLAUDE.md.
describe('Factures — la visibilité des colonnes persiste au rechargement', () => {
  let browser, ctx, page
  let snapshot = null // { pillId, visible_columns }
  let targets = null // { standardCol, customCol }

  async function authenticate() {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    if (TOKEN) {
      await ctx.addInitScript(t => { try { localStorage.setItem('erp_token', t) } catch {} }, TOKEN)
      page = await ctx.newPage()
      await page.goto(URL, { waitUntil: 'domcontentloaded' })
    } else {
      page = await ctx.newPage()
      await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
      await page.fill('input[type="email"]', EMAIL)
      await page.fill('input[type="password"]', PASS)
      await page.click('button:has-text("Se connecter")')
      await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    }
  }

  // Renvoie les colonnes visibles de la vue active (celle affichée par défaut).
  async function readActivePill() {
    return page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/factures', { headers: { Authorization: `Bearer ${tok}` } })
      const d = await r.json()
      const lastId = localStorage.getItem('erp_lastView_factures')
      const pill = (d.pills || []).find(p => String(p.id) === String(lastId)) || (d.pills || [])[0]
      return pill ? { pillId: pill.id, visible_columns: pill.visible_columns || [] } : null
    })
  }

  async function writeVisibleColumns(pillId, cols) {
    await page.evaluate(async ({ pillId, cols }) => {
      const tok = localStorage.getItem('erp_token')
      await fetch(`/erp/api/views/factures/pills/${pillId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ visible_columns: cols }),
      })
    }, { pillId, cols })
  }

  before(async () => {
    await authenticate()
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)

    snapshot = await readActivePill()
    assert.ok(snapshot, 'une vue active sur factures est requise')

    const visible = snapshot.visible_columns
    // Colonne custom (cf_*) actuellement visible + colonne standard visible.
    const customCol = visible.find(c => c.startsWith('cf_'))
    const standardCol = visible.find(c => !c.startsWith('cf_'))
    assert.ok(customCol, 'la vue active doit contenir une colonne custom visible pour le test')
    assert.ok(standardCol, 'la vue active doit contenir une colonne standard visible pour le test')
    targets = { standardCol, customCol }
  })

  after(async () => {
    // Restaure la liste de colonnes visibles d'origine (config globale de la vue).
    if (snapshot && page) {
      try { await writeVisibleColumns(snapshot.pillId, snapshot.visible_columns) } catch {}
    }
    await browser?.close()
  })

  test('masquer une colonne standard + une colonne custom reste masqué après rechargement', async () => {
    // Masque les deux colonnes via l'API de la vue active.
    const hidden = snapshot.visible_columns.filter(
      c => c !== targets.standardCol && c !== targets.customCol
    )
    await writeVisibleColumns(snapshot.pillId, hidden)

    // Confirme le masquage côté serveur avant rechargement.
    const afterHide = await readActivePill()
    assert.ok(!afterHide.visible_columns.includes(targets.standardCol),
      `colonne standard ${targets.standardCol} doit être masquée après écriture`)
    assert.ok(!afterHide.visible_columns.includes(targets.customCol),
      `colonne custom ${targets.customCol} doit être masquée après écriture`)

    // Recharge la page et laisse l'effet auto-affichage des champs custom tourner
    // (le fetch async des champs custom résout ~qq centaines de ms après le mount).
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForTimeout(3000)

    const afterReload = await readActivePill()
    assert.ok(!afterReload.visible_columns.includes(targets.standardCol),
      `colonne standard ${targets.standardCol} ré-apparue après rechargement (régression)`)
    assert.ok(!afterReload.visible_columns.includes(targets.customCol),
      `colonne custom ${targets.customCol} ré-apparue après rechargement (bug auto-affichage)`)
  })
})
