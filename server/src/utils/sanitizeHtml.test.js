import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeSignatureHtml } from './sanitizeHtml.js'

test('sanitizeSignatureHtml garde la mise en forme d\'une signature', () => {
  const html = '<div style="color:#333"><b>Pierre</b><br><img src="https://orisha.io/logo.png" width="80"> <a href="https://orisha.io">orisha.io</a></div>'
  assert.equal(sanitizeSignatureHtml(html), html)
})

test('sanitizeSignatureHtml retire scripts, gestionnaires et URL javascript:', () => {
  const out = sanitizeSignatureHtml('<p onclick="x()">Hi<script>alert(1)</script></p><a href="javascript:alert(1)">l</a><img src=x onerror=alert(1)>')
  assert.equal(out, '<p>Hi</p><a href="#">l</a><img src=x>')
})

test('sanitizeSignatureHtml : vide → chaîne vide', () => {
  assert.equal(sanitizeSignatureHtml(null), '')
  assert.equal(sanitizeSignatureHtml('  '), '')
})
