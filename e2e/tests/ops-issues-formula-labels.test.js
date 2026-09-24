const { test } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'

// Les écritures sont interceptées : aucun champ de production n'est créé.
test('Problèmes d’opérations : suggestions et insertion des libellés de champs', async () => {
  assert.ok(process.env.ERP_PASS, 'ERP_PASS requis')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.goto(`${URL}/login`)
    await page.locator('input[type="email"]').fill(process.env.ERP_EMAIL || 'claude@orisha.io')
    await page.locator('input[type="password"]').fill(process.env.ERP_PASS)
    await page.getByRole('button', { name: 'Se connecter' }).click()
    await page.waitForURL(u => !u.pathname.includes('/login'))

    let submitted
    await page.route('**/api/**', async route => {
      const req = route.request()
      if (['GET', 'HEAD'].includes(req.method())) return route.continue()
      if (req.url().endsWith('/custom-fields/ops_issues') && req.method() === 'POST') {
        submitted = req.postDataJSON()
        return route.fulfill({ status: 400, json: { error: 'Enregistrement intercepté pour vérification' } })
      }
      return route.abort()
    })

    for (const renamed of [false, true]) {
      if (renamed) {
        await page.route('**/api/custom-fields/ops_issues', async route => {
          if (route.request().method() !== 'GET') return route.fallback()
          const response = await route.fetch()
          const body = await response.json()
          body.data = body.data.filter(f => !(f.kind === 'native' && f.column_name === 'occurred_at'))
          body.data.push({ id: -123456, erp_table: 'ops_issues', kind: 'native', column_name: 'occurred_at', name: 'Date du problème', type: 'date' })
          await route.fulfill({ response, json: body })
        })
      }
      await page.goto(`${URL}/problemes-operations`)
      await page.getByRole('button', { name: 'Ajouter un champ', exact: true }).click()
      await page.getByTestId('cf-type').click()
      await page.getByTestId('cf-type-menu').getByText('Formule', { exact: true }).click()
      const editor = page.locator('textarea.formula-input')
      const label = renamed ? 'Date du problème' : 'Date'

      await editor.fill('Da')
      const suggestion = page.locator('li').filter({ has: page.getByText(label, { exact: true }) })
      await suggestion.waitFor({ state: 'visible' })
      await suggestion.hover()
      await editor.press('Enter')
      assert.equal(await editor.inputValue(), `{${label}}`)

      await editor.fill('{da}')
      await editor.press('ArrowLeft')
      await suggestion.click()
      assert.equal(await editor.inputValue(), `{${label}}`, 'une seule accolade fermante')

      await editor.fill('cre')
      await page.locator('li').filter({ has: page.getByText('Créé le', { exact: true }) }).click()
      assert.equal(await editor.inputValue(), '{Créé le}', 'recherche sans accent')

      await editor.fill('DATETIME_FORMAT( Da')
      await suggestion.click()
      await editor.press('End')
      await editor.pressSequentially(', "YYYY-ww" )')
      const form = page.locator('form').filter({ has: editor })
      await form.locator('input').first().fill('Vérification des suggestions')
      submitted = null
      await form.getByRole('button', { name: 'Créer', exact: true }).click()
      await page.getByText('Enregistrement intercepté pour vérification', { exact: true }).waitFor()
      assert.equal(submitted.formula_expr, 'DATETIME_FORMAT( occurred_at, "YYYY-ww" )')
    }
  } finally {
    await browser.close()
  }
})
