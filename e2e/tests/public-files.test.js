// Page "Fichiers publics" — vérifie :
// - la page se rend et propose une drop zone
// - upload via API d'un PNG (1 px) et d'un PDF (header minimaliste)
// - la liste les retourne et la page affiche les fichiers téléversés
// - l'URL publique /erp/p/<token> sert le contenu SANS authentification
// - la modification (description/tags/folder) persiste
// - la suppression révoque l'URL publique (404 par la suite)
//
// Cleanup : les fichiers créés sont systématiquement supprimés dans after(),
// même si un test a échoué.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL_BASE = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// 1×1 PNG transparent (base64). Pas besoin d'un vrai fichier sur disque.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

async function login() {
  const r = await fetch(`${URL_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  if (!r.ok) throw new Error(`Login failed: ${r.status}`)
  const { token } = await r.json()
  return token
}

async function uploadFile(token, { name, content, folder = '' }) {
  const fd = new FormData()
  fd.append('file', new Blob([content]), name)
  if (folder) fd.append('folder', folder)
  const r = await fetch(`${URL_BASE}/api/public-files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  })
  if (!r.ok) throw new Error(`Upload ${name} failed: ${r.status} ${await r.text()}`)
  return r.json()
}

async function deleteFile(token, id) {
  await fetch(`${URL_BASE}/api/public-files/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
}

describe('Fichiers publics — page + URL publique', () => {
  let token
  let browser, ctx, page
  const created = [] // { id, token } pour cleanup

  before(async () => {
    token = await login()
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    // Inject token côté navigateur pour court-circuiter l'écran de login.
    await page.goto(URL_BASE + '/')
    await page.evaluate((t) => localStorage.setItem('erp_token', t), token)
  })

  after(async () => {
    // Cleanup — supprime TOUS les fichiers créés pendant ce test, même si
    // une assertion a échoué entre-temps. Sinon la DB de prod conserve des
    // entrées zombies (CLAUDE.md "Règle — nettoyer les records créés").
    for (const c of created) {
      try { await deleteFile(token, c.id) } catch {}
    }
    await browser?.close()
  })

  test('page se rend et expose la drop zone', async () => {
    await page.goto(URL_BASE + '/public-files')
    await page.waitForSelector('h1:has-text("Fichiers publics")', { timeout: 5000 })
    const input = await page.$('[data-testid="public-files-input"]')
    assert.ok(input, 'L\'input fichier doit être présent dans la drop zone')
  })

  test('upload + listing + URL publique sans auth', async () => {
    const stamp = Date.now()
    const pngName = `e2e-public-${stamp}.png`
    const pdfName = `e2e-public-${stamp}.pdf`

    const png = await uploadFile(token, { name: pngName, content: PNG_1X1, folder: 'e2e-tests' })
    created.push(png)
    assert.ok(png.token && png.token.length >= 16, 'le token doit être généré')
    assert.equal(png.folder, 'e2e-tests')
    assert.equal(png.original_name, pngName)

    // PDF minimal — pas besoin d'être valide, on teste juste le pipeline binaire.
    const pdfContent = Buffer.from('%PDF-1.4\n%E2 E3 CF D3\n%%EOF\n', 'utf-8')
    const pdf = await uploadFile(token, { name: pdfName, content: pdfContent })
    created.push(pdf)

    // Listing via API
    const listResp = await fetch(`${URL_BASE}/api/public-files`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const { data } = await listResp.json()
    assert.ok(data.find(f => f.id === png.id), 'le PNG doit apparaître dans la liste')
    assert.ok(data.find(f => f.id === pdf.id), 'le PDF doit apparaître dans la liste')

    // URL publique SANS auth — c'est le cœur de la feature.
    const pubResp = await fetch(`${URL_BASE}/p/${png.token}`, { redirect: 'manual' })
    assert.equal(pubResp.status, 200, 'URL publique doit répondre 200 sans token')
    const buf = Buffer.from(await pubResp.arrayBuffer())
    assert.equal(buf.length, PNG_1X1.length, 'contenu binaire identique au PNG uploadé')
    assert.deepEqual(buf, PNG_1X1)

    // Page : naviguer et confirmer que les fichiers apparaissent dans le DataTable.
    await page.goto(URL_BASE + '/public-files')
    await page.waitForSelector('h1:has-text("Fichiers publics")')
    await page.waitForSelector(`text=${pngName}`, { timeout: 5000 })
    await page.waitForSelector(`text=${pdfName}`, { timeout: 5000 })
  })

  test('mise à jour de description/tags persiste', async () => {
    const f = await uploadFile(token, { name: `e2e-update-${Date.now()}.png`, content: PNG_1X1 })
    created.push(f)

    const patchResp = await fetch(`${URL_BASE}/api/public-files/${f.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Description test', tags: ['public', 'demo'], folder: 'docs' }),
    })
    assert.equal(patchResp.status, 200)
    const updated = await patchResp.json()
    assert.equal(updated.description, 'Description test')
    assert.deepEqual(updated.tags, ['public', 'demo'])
    assert.equal(updated.folder, 'docs')

    // Le folder mis à jour doit apparaître dans /folders
    const foldersResp = await fetch(`${URL_BASE}/api/public-files/folders`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const foldersJson = await foldersResp.json()
    assert.ok(foldersJson.data.find(d => d.folder === 'docs'), '"docs" doit apparaître dans la liste des dossiers')
  })

  test('suppression révoque le lien public', async () => {
    const f = await uploadFile(token, { name: `e2e-delete-${Date.now()}.png`, content: PNG_1X1 })

    // Avant : 200
    let r = await fetch(`${URL_BASE}/p/${f.token}`)
    assert.equal(r.status, 200)

    // Suppression
    const del = await fetch(`${URL_BASE}/api/public-files/${f.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(del.status, 200)

    // Après : 404, le lien est révoqué
    r = await fetch(`${URL_BASE}/p/${f.token}`)
    assert.equal(r.status, 404, 'URL publique doit retourner 404 après suppression')
  })

  test('GET /api/public-files sans token → 401', async () => {
    const r = await fetch(`${URL_BASE}/api/public-files`)
    assert.equal(r.status, 401, 'la liste authentifiée doit refuser un appel sans token')
  })
})
