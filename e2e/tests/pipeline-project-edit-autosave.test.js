// Vérifie que la modale « Modifier le projet » (Pipeline.jsx → ProjectForm en
// mode édition) :
//   1) n'a PAS de bouton « Enregistrer » (règle autosave : interdit sur
//      l'édition d'un record existant) ;
//   2) persiste les champs en autosave (debounce ~500ms) via PUT /projects/:id ;
//   3) affiche un statut « Enregistré » après sauvegarde.
//
// Le déclencheur de la modale est le bouton crayon (data-testid=edit-project-<id>)
// révélé au survol de la ligne dans la colonne Nom.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

async function login() {
  const r = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  if (!r.ok) throw new Error(`Login failed: ${r.status}`)
  const { token } = await r.json()
  return token
}

function authHeaders(token, json = false) {
  const h = { Authorization: `Bearer ${token}` }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

async function getProject(token, id) {
  const r = await fetch(`${URL}/api/projects/${id}`, { headers: authHeaders(token) })
  if (!r.ok) throw new Error(`GET project ${id}: ${r.status}`)
  return r.json()
}

// Poll jusqu'à ce que `predicate(project)` soit vrai, ou timeout. Les « fetch
// failed » transitoires (serveur mono-thread occupé par les syncs de fond) sont
// avalés et réessayés : on ne veut pas faire échouer le test sur un drop réseau
// ponctuel, seulement vérifier que l'autosave a fini par persister.
async function waitForProject(token, id, predicate, timeoutMs = 12000) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeoutMs) {
    try {
      last = await getProject(token, id)
      if (predicate(last)) return last
    } catch { /* drop réseau transitoire — réessaie */ }
    await new Promise(res => setTimeout(res, 250))
  }
  return last
}

describe('Pipeline — édition projet en autosave (pas de bouton Enregistrer)', () => {
  let browser, ctx, page, token, projectId
  const ts = Date.now()
  const name = `E2E autosave ${ts}`

  before(async () => {
    token = await login()
    // Record jetable créé via API — supprimé dans after().
    const r = await fetch(`${URL}/api/projects`, {
      method: 'POST',
      headers: authHeaders(token, true),
      body: JSON.stringify({ name, status: 'Ouvert', probability: 50, notes: 'orig' }),
    })
    assert.equal(r.status, 201, 'création du projet de test')
    projectId = (await r.json()).id

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    // Cleanup : toujours supprimer le record de test, même si le test a échoué.
    if (projectId && token) {
      await fetch(`${URL}/api/projects/${projectId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }).catch(() => {})
    }
    await browser?.close()
  })

  test('ouvre la modale d\'édition via le crayon de la ligne', async () => {
    await page.goto(URL + '/pipeline', { waitUntil: 'domcontentloaded' })
    await page.locator('h1:has-text("Projets")').waitFor({ state: 'visible', timeout: 15000 })

    // Filtre la table sur le nom unique pour garantir le rendu de la ligne
    // (la table est virtualisée).
    const searchInput = page.locator('input[placeholder="Rechercher..."]').first()
    await searchInput.fill(name)

    const editBtn = page.locator(`[data-testid="edit-project-${projectId}"]`)
    await editBtn.waitFor({ state: 'visible', timeout: 10000 })
    await editBtn.click()

    await page.locator('div[role="dialog"]:has(h2:has-text("Modifier le projet"))')
      .waitFor({ state: 'visible', timeout: 5000 })
  })

  test('aucun bouton « Enregistrer » dans la modale d\'édition', async () => {
    const dialog = page.locator('div[role="dialog"]:has(h2:has-text("Modifier le projet"))')
    assert.equal(
      await dialog.locator('button:has-text("Enregistrer")').count(),
      0,
      'le bouton « Enregistrer » doit être absent en mode édition (autosave)',
    )
    // Le footer d'édition expose plutôt « Fermer ».
    assert.ok(
      await dialog.locator('button:has-text("Fermer")').count() >= 1,
      'un bouton « Fermer » doit être présent',
    )
  })

  test('édition des Notes → autosave persisté + statut « Enregistré »', async () => {
    const dialog = page.locator('div[role="dialog"]:has(h2:has-text("Modifier le projet"))')
    const newNotes = `autosaved ${ts}`
    const textarea = dialog.locator('textarea')
    await textarea.fill(newNotes)

    // Assertion autoritaire : la valeur éditée dans le navigateur doit être
    // persistée côté serveur (l'autosave a bien déclenché un PUT).
    const proj = await waitForProject(token, projectId, p => p.notes === newNotes, 12000)
    assert.equal(proj.notes, newNotes, 'les Notes doivent être autosauvegardées')

    // Le statut d'autosave doit avoir basculé sur « Enregistré » (feedback UI).
    await dialog.getByText('Enregistré', { exact: true }).waitFor({ state: 'visible', timeout: 8000 })
  })

  // Le select couvert ici était « Statut » ; ce champ a été retiré de la table
  // Projet (voir projects-no-status-field.test.js). « Type » est le select
  // restant et donne la même couverture : autosave d'un <select>.
  test('changement de Type → autosave persisté', async () => {
    const dialog = page.locator('div[role="dialog"]:has(h2:has-text("Modifier le projet"))')
    const typeSelect = dialog.locator('select:has(option[value="Expansion"])')
    await typeSelect.selectOption('Expansion')

    const proj = await waitForProject(token, projectId, p => p.type === 'Expansion', 12000)
    assert.equal(proj.type, 'Expansion', 'le Type doit être autosauvegardé')
  })
})
