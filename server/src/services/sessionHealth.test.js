import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLoginRedirect, redirectsToLoginPage, looksLikeLoginPage } from './sessionHealth.js'

const res = (status, headers = {}) => ({
  status,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
})

test('302 vers la page de connexion = session morte', () => {
  const r = res(302, { location: 'https://www.instagram.com/accounts/login/?next=/api/v1/media/1/info/' })
  assert.equal(isLoginRedirect(r), true)
  assert.equal(redirectsToLoginPage(r), true)
})

test('302 sans destination lisible compte quand même comme panne', () => {
  assert.equal(isLoginRedirect(res(302, { location: 'https://www.instagram.com/' })), true)
})

test('200 JSON = session vivante', () => {
  assert.equal(isLoginRedirect(res(200, { 'content-type': 'application/json' })), false)
})

test('200 qui rend une page de connexion HTML', () => {
  const r = res(200, { 'content-type': 'text/html' })
  assert.equal(looksLikeLoginPage(r, '<html><body><form>Password</form></body></html>'), true)
})

test('200 JSON n’est jamais pris pour une page de connexion', () => {
  const r = res(200, { 'content-type': 'application/json' })
  assert.equal(looksLikeLoginPage(r, '{"user":{"username":"orisha_auto"}}'), false)
})
