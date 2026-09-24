// Formulaire réel dans un navigateur, API entièrement simulée : aucun achat.
const { test, describe, before, after, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const path = require('node:path')
const { chromium } = require('playwright')
const { build, stop } = require('../../client/node_modules/esbuild')

describe('Étiquettes /envois — dimensions par boîte', () => {
  let server, browser, page, url
  let requests
  const rate = { service_id: 'test-service', service_name: 'Service test', total: { value: 12, currency: 'CAD' } }

  before(async () => {
    const bundle = await build({
      stdin: {
        contents: `
          import React from 'react'
          import { createRoot } from 'react-dom/client'
          import Label from './src/components/NovoxpressLabelModal.jsx'
          createRoot(document.getElementById('root')).render(<Label
            envoi={{ id: 'test', address_contact_first_name: 'Martin', address_country: 'CA' }}
            orderItemsTotalWeight={9}
            individualBoxes={!location.search.includes('legacy')}
          />)
        `,
        resolveDir: path.resolve(__dirname, '../../client'),
        loader: 'jsx',
      },
      bundle: true, write: false, jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"test"' },
    })
    server = createServer((req, res) => {
      if (req.url === '/bundle.js') {
        res.setHeader('Content-Type', 'application/javascript')
        res.end(bundle.outputFiles[0].text)
      } else if (req.url.startsWith('/erp/api/')) {
        // Toute requête API oubliée par les mocks échoue localement.
        res.writeHead(500).end('{}')
      } else {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end('<div id="root"></div><script src="/bundle.js"></script>')
      }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${server.address().port}`
    browser = await chromium.launch({ headless: true })
  })

  after(async () => {
    stop()
    await browser?.close()
    if (server) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })

  beforeEach(async () => {
    requests = []
    page = await browser.newPage()
    await page.route('**/erp/api/**', async route => {
      const request = route.request()
      const pathname = new URL(request.url()).pathname
      requests.push({ pathname, body: request.postDataJSON() })
      const response = pathname.includes('/novoxpress/rates/')
        ? { request_id: 'request-test', rates: [rate] }
        : pathname.includes('/novoxpress/label/')
          ? { shipment_id: 'fake', label_url: '/fake.pdf' }
          : { rates: [rate], environment: 'production' }
      await route.fulfill({ json: response })
    })
    await page.goto(url)
  })

  afterEach(async () => { await page?.close() })

  async function getRates() {
    await page.getByRole('button', { name: 'Obtenir les tarifs' }).click()
    await page.getByRole('button', { name: /Service test/ }).waitFor()
  }

  test('chaque boîte garde ses dimensions dans les tarifs, UPS et l’achat', async () => {
    await page.getByLabel('Nombre de colis').fill('3')
    await page.locator('#label-box-2').selectOption('petite')
    await page.locator('#label-box-3').selectOption('custom')
    await page.getByLabel('Boîte 3 — longueur (po)').fill('11.5')
    await page.getByLabel('Boîte 3 — largeur (po)').fill('9')
    await page.getByLabel('Boîte 3 — hauteur (po)').fill('4')
    await getRates()
    const packages = [
      { quantity: '1', weight: '3', length: '20', width: '16', depth: '8' },
      { quantity: '1', weight: '3', length: '15', width: '15', depth: '7' },
      { quantity: '1', weight: '3', length: '11.5', width: '9', depth: '4' },
    ]
    assert.deepEqual(requests[0].body.packages, packages)
    await page.getByRole('button', { name: 'Comparer avec UPS' }).click()
    await page.getByRole('button', { name: 'Rafraîchir' }).waitFor()
    assert.deepEqual(requests[1].body.packages, packages)
    await page.getByRole('button', { name: /Service test/ }).click()
    assert.deepEqual(await page.locator('li').allTextContents(), [
      'Boîte 1 · 20 × 16 × 8 po', 'Boîte 2 · 15 × 15 × 7 po', 'Boîte 3 · 11.5 × 9 × 4 po',
    ])
    await page.getByRole('button', { name: 'Confirmer et acheter' }).click()
    await page.getByText('Étiquette créée !').waitFor()
    assert.deepEqual(requests[2].body.packages, packages)
    assert.equal(requests[2].body.request_id, 'request-test')
  })

  test('les dimensions vides, nulles et négatives bloquent les tarifs', async () => {
    await page.getByLabel('Nombre de colis').fill('2')
    await page.locator('#label-box-2').selectOption('custom')
    for (const invalid of ['', '0', '-2']) {
      await page.getByLabel('Boîte 2 — longueur (po)').fill(invalid)
      await page.getByLabel('Boîte 2 — largeur (po)').fill('8')
      await page.getByLabel('Boîte 2 — hauteur (po)').fill('4')
      await page.getByRole('button', { name: 'Obtenir les tarifs' }).click()
      await page.getByText('Boîte 2 : entrez trois dimensions supérieures à zéro.').waitFor()
      assert.equal(requests.length, 0)
    }
  })

  test('retour, changement de quantité et enveloppe préservent les boîtes restantes', async () => {
    await page.getByLabel('Nombre de colis').fill('3')
    await page.locator('#label-box-2').selectOption('sunshield')
    await page.locator('#label-box-3').selectOption('grande')
    await getRates()
    await page.getByRole('button', { name: '← Retour' }).click()
    assert.equal(await page.locator('#label-box-2').inputValue(), 'sunshield')
    assert.equal(await page.locator('#label-box-3').inputValue(), 'grande')
    await page.getByLabel('Nombre de colis').fill('2')
    assert.equal(await page.locator('#label-box-3').count(), 0)
    await page.getByRole('radio', { name: 'Enveloppe (documents légers)' }).check()
    await getRates()
    assert.equal(requests[1].body.packaging_type, 'envelope')
    assert.deepEqual(requests[1].body.packages, [
      { quantity: '1', weight: '1', length: '13', width: '10', depth: '1' },
    ])
    await page.getByRole('button', { name: '← Retour' }).click()
    await page.getByRole('radio', { name: 'Moyenne (20 × 16 × 8 po)' }).check()
    assert.equal(await page.locator('#label-box-2').inputValue(), 'sunshield')
    await getRates()
    assert.equal(requests[2].body.packages.length, 2)
    assert.equal(requests[2].body.packages[1].length, '8')
  })

  test('une seule boîte conserve les dimensions et le poids par défaut', async () => {
    await getRates()
    assert.deepEqual(requests[0].body.packages, [
      { quantity: '1', weight: '9', length: '20', width: '16', depth: '8' },
    ])
  })

  test('sans l’option /envois, les boîtes identiques restent groupées', async () => {
    await page.goto(url + '?legacy')
    await page.getByLabel('Nombre de colis').fill('3')
    assert.equal(await page.locator('select').count(), 0)
    await getRates()
    assert.deepEqual(requests[0].body.packages, [
      { quantity: '3', weight: '3', length: '20', width: '16', depth: '8' },
    ])
  })
})
