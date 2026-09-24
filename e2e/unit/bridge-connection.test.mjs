import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { normalizeErpUrl, erpOriginPermission } from '../../browser-extension/erp-url.mjs'

async function extensionModule(name) {
  const source = (await readFile(new URL(`../../browser-extension/${name}.js`, import.meta.url), 'utf8'))
    .replace(/'\.\/(token|erp-url)\.mjs'/g, (_, name) => JSON.stringify(new URL(`../../browser-extension/${name}.mjs`, import.meta.url).href))
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

test('ERP page URLs normalize to the HTTPS origin', () => {
  for (const path of ['', '/', '/erp', '/erp/sale-receipts?onglet=collecte#tab']) {
    assert.equal(normalizeErpUrl(` https://customer.orisha.io${path} `), 'https://customer.orisha.io')
    assert.equal(erpOriginPermission(`https://customer.orisha.io${path}`), 'https://customer.orisha.io/*')
  }
  for (const value of ['', 'customer.orisha.io', 'http://customer.orisha.io', 'https://user:pass@customer.orisha.io', 'file:///erp']) {
    assert.throws(() => normalizeErpUrl(value), /Adresse ERP invalide/)
  }
})

test('worker handles missing permissions, network errors, expiry and successful requests', async () => {
  const oldChrome = globalThis.chrome
  const oldFetch = globalThis.fetch
  const requests = []
  let allowed = false
  let mode = 'success'
  globalThis.chrome = {
    storage: { local: {
      get: async () => ({ erpUrl: 'https://customer.orisha.io/erp/sale-receipts?onglet=collecte', token: 'abc.def.ghi' }),
      set: async () => {},
    } },
    permissions: { contains: async permission => {
      assert.deepEqual(permission.origins, ['https://customer.orisha.io/*'])
      return allowed
    } },
    cookies: { onChanged: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
  }
  globalThis.fetch = async (url, options) => {
    requests.push(url)
    assert.equal(options.headers.Authorization, 'Bearer abc.def.ghi')
    if (mode === 'network') throw new TypeError('Failed to fetch')
    if (mode === 'expired') return new Response('{}', { status: 401 })
    if (mode === 'html') return new Response('<html>Login</html>')
    return new Response(JSON.stringify(url.endsWith('/targets') ? [] : { ok: true }))
  }
  try {
    const worker = await extensionModule('background')
    await assert.rejects(worker.runBridge(), /Accès à l’ERP non autorisé/)
    assert.equal(requests.length, 0)
    allowed = true
    mode = 'network'
    await assert.rejects(worker.runBridge(), /Connexion à https:\/\/customer.orisha.io impossible/)
    mode = 'expired'
    await assert.rejects(worker.runBridge(), /Jeton expiré ou refusé/)
    mode = 'html'
    await assert.rejects(worker.runBridge(), /Réponse ERP inattendue/)
    mode = 'success'
    assert.deepEqual(await worker.runBridge(), { sent: [], collect: { ok: true } })
    assert.ok(requests.every(url => url.startsWith('https://customer.orisha.io/erp/api/scrapers/session-bridge/')))
  } finally {
    globalThis.chrome = oldChrome
    globalThis.fetch = oldFetch
  }
})

test('options request the exact origin on Save and preserve settings when denied', async () => {
  const oldChrome = globalThis.chrome
  const oldDocument = globalThis.document
  let onSave
  let stored = false
  let requested
  const fields = Object.fromEntries(['erpUrl', 'token', 'auto', 'saved', 'save'].map(id => [id, { style: {}, addEventListener: (_, cb) => { onSave = cb } }]))
  globalThis.document = { getElementById: id => fields[id] }
  globalThis.chrome = {
    storage: { local: { get: async () => ({}), set: async () => { stored = true } } },
    permissions: { request: async permission => { requested = permission; return false } },
  }
  try {
    await extensionModule('options')
    fields.erpUrl.value = 'https://customer.orisha.io/erp/'
    fields.token.value = 'abc.def.ghi'
    await onSave()
    assert.deepEqual(requested, { origins: ['https://customer.orisha.io/*'] })
    assert.equal(stored, false)
    assert.match(fields.saved.textContent, /Accès refusé/)
  } finally {
    globalThis.chrome = oldChrome
    globalThis.document = oldDocument
  }
})
