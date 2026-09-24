import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeToken } from '../../browser-extension/token.mjs'

const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.ABC_def-123'

test('accepts an ERP token unchanged in an Authorization header', () => {
  assert.equal(new Headers({ Authorization: `Bearer ${normalizeToken(token)}` }).get('Authorization'), `Bearer ${token}`)
})

test('accepts surrounding whitespace and a copied Bearer prefix', () => {
  for (const value of [` \n${token}\r\n`, `Bearer ${token}`, `bearer ${token}`]) {
    assert.equal(normalizeToken(value), token)
  }
})

test('rejects Unicode, truncated tokens and header injection with actionable feedback', () => {
  for (const value of ['…', `«${token}»`, `${token}\u200b`, token.replace('ABC', 'AB\r\nC'), 'mot-de-passe-é', '', null, 'a.b', 'a.b.c.d']) {
    assert.throws(() => normalizeToken(value), /Jeton invalide.*onglet Collecte.*Réglages/)
  }
})


test('the worker rejects a previously saved Unicode token before making a request', async () => {
  const { readFile } = await import('node:fs/promises')
  const oldChrome = globalThis.chrome
  const oldFetch = globalThis.fetch
  let fetched = false
  globalThis.chrome = {
    storage: { local: { get: async () => ({ erpUrl: 'https://customer.orisha.io', token: 'jeton…' }) } },
    cookies: { onChanged: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
  }
  globalThis.fetch = async () => { fetched = true; throw new Error('Unexpected request') }
  try {
    const source = (await readFile(new URL('../../browser-extension/background.js', import.meta.url), 'utf8'))
      .replace(/'\.\/(token|erp-url)\.mjs'/g, (_, name) => JSON.stringify(new URL(`../../browser-extension/${name}.mjs`, import.meta.url).href))
    const worker = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
    await assert.rejects(worker.runBridge(), /Jeton invalide/)
    assert.equal(fetched, false)
  } finally {
    globalThis.chrome = oldChrome
    globalThis.fetch = oldFetch
  }
})
