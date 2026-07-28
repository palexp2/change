const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

const FIELD_NAME = 'E2E Colonne Plus'

// Mode champs custom auto-géré de DataTable : toute table supportée
// (CUSTOM_FIELD_TABLES) affiche un « + » en bout d'en-tête sans câblage page.
// On valide sur /paies (signalement utilisateur) : bouton présent, création
// d'un champ via la modale interne, colonne auto-affichée.
describe('DataTable — « + » d\'ajout de colonne auto-géré (/paies)', () => {
  let browser, ctx, page, token, db
  let createdFieldId, createdColumnName
  // Sauvegarde des pills de vue paies : l'auto-show de la nouvelle colonne
  // déclenche l'autosave de ViewToolbar dans la pill GLOBALE (voir gotchas) —
  // on capture avant et on restaure après.
  let savedPills

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    savedPills = db.prepare("SELECT * FROM table_view_pills WHERE table_name='paies'").all()
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => {
    try {
      // 1. Suppression API (régénère la vue paies_v proprement)…
      if (createdFieldId) {
        await page.evaluate(async ({ tok, id }) => {
          await fetch(`/erp/api/custom-fields/${id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${tok}` },
          })
        }, { tok: token, id: createdFieldId })
        // 2. …puis purge de la corbeille + drop de la colonne physique.
        db.prepare('DELETE FROM custom_fields WHERE id=?').run(createdFieldId)
        if (createdColumnName) {
          try { db.exec(`ALTER TABLE paies DROP COLUMN ${createdColumnName}`) } catch {}
        }
      }
      // 3. Restauration des pills de vue capturées avant le test.
      for (const p of savedPills || []) {
        const cols = Object.keys(p).filter(k => k !== 'id')
        db.prepare(`UPDATE table_view_pills SET ${cols.map(c => `${c}=?`).join(', ')} WHERE id=?`)
          .run(...cols.map(c => p[c]), p.id)
      }
    } catch {}
    db?.close()
    await browser?.close()
  })

  test('le bouton « + » est présent dans l\'en-tête sans câblage page', async () => {
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(URL + '/paies', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Paies")', { timeout: 10000 })
    const addBtn = page.locator('button[aria-label="Ajouter un champ"]')
    await addBtn.first().waitFor({ state: 'visible', timeout: 8000 })
    assert.ok(await addBtn.count() >= 1, 'Le bouton "+" doit être présent dans l\'en-tête du DataTable de /paies')
    assert.deepEqual(errors, [], `aucune erreur JS attendue, reçu: ${errors.join(' | ')}`)
  })

  test('le « + » ouvre la modale et crée un champ texte, colonne auto-affichée', async () => {
    // Le premier DataTable de la page est celui des paies (le tableau
    // paie_items n'existe que dans la modale de détail, fermée ici).
    await page.locator('button[aria-label="Ajouter un champ"]').first().click()
    await page.waitForSelector('text=Nouveau champ', { timeout: 5000 })

    await page.fill('input[placeholder="ex: Priorité interne"]', FIELD_NAME)
    await page.click('[data-testid="cf-type-text"]')
    await page.click('button[type="submit"]')

    // La modale se ferme et la colonne apparaît (auto-show des nouveaux champs).
    await page.waitForSelector('text=Nouveau champ', { state: 'detached', timeout: 8000 })
    await page.waitForFunction(
      (name) => document.body.textContent.includes(name),
      FIELD_NAME,
      { timeout: 8000 },
    )

    // Récupère le champ créé pour le cleanup + vérifie la persistance serveur.
    const created = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/custom-fields/paies', {
        headers: { Authorization: `Bearer ${tok}` },
      })
      const body = await res.json()
      return (body.data || []).find(f => f.name === 'E2E Colonne Plus') || null
    }, token)
    assert.ok(created, 'Le champ créé doit exister côté serveur pour la table paies')
    assert.equal(created.type, 'text')
    createdFieldId = created.id
    createdColumnName = created.column_name
  })

  test('clic-droit sur la colonne custom → menu Modifier / Supprimer le champ', async () => {
    // L'en-tête de la nouvelle colonne offre le menu contextuel du mode
    // auto-géré (source custom détectée via la Map interne).
    const header = page.locator(`div.group\\/header >> text=${FIELD_NAME}`).first()
    await header.click({ button: 'right' })
    await page.waitForSelector('button:has-text("Modifier le champ")', { timeout: 5000 })
    assert.ok(await page.locator('button:has-text("Supprimer le champ")').count() >= 1,
      'Le menu contextuel doit proposer la suppression du champ custom')
    // Referme le menu sans agir (le cleanup passe par l\'API).
    await page.keyboard.press('Escape')
    await page.mouse.click(10, 10)
  })
})
