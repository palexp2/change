import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findChromium, renderEmailHtmlPdf, stripActiveContent } from './emailHtmlPdf.js'

// HTML de facture typique reçue dans le corps d'un courriel (gabarit en
// tableaux, à la Webflow) — sans image distante pour rester hermétique au réseau.
const INVOICE_HTML = `
<html><body>
  <table width="600"><tr><td>
    <h2>Thanks for your payment!</h2>
    <table width="100%">
      <tr><th align="left">Item</th><th align="right">Amount</th></tr>
      <tr><td>Site plans Premium Hosting Plan</td><td align="right">USD $89.68</td></tr>
    </table>
    <p>Subtotal: USD $89.68<br>Paid: USD $89.68</p>
  </td></tr></table>
</body></html>`

function pdfText(buffer) {
  const p = join(tmpdir(), `emailHtmlPdf-test-${process.pid}.pdf`)
  writeFileSync(p, buffer)
  try {
    const r = spawnSync('pdftotext', ['-layout', p, '-'], { encoding: 'utf8', timeout: 30000 })
    return r.status === 0 ? r.stdout : null
  } finally {
    try { unlinkSync(p) } catch {}
  }
}

test('renderEmailHtmlPdf imprime le HTML en PDF fidèle avec calque texte', { skip: !findChromium() && 'aucun Chromium disponible sur cet hôte' }, async () => {
  const buf = await renderEmailHtmlPdf({
    subject: 'Your Webflow receipt',
    from: 'Webflow <no-reply@webflow.com>',
    date: 'Sun, 2 Aug 2026 10:16:36 -0500',
    html: INVOICE_HTML,
  })
  assert.ok(Buffer.isBuffer(buf))
  assert.ok(buf.subarray(0, 5).toString().startsWith('%PDF'))
  const text = pdfText(buf)
  if (text != null) { // pdftotext présent sur l'hôte (requis par l'extraction)
    assert.match(text, /Thanks for your payment/)
    assert.match(text, /Subtotal: USD \$89\.68/)
    assert.match(text, /Paid: USD \$89\.68/)
    // Bandeau de traçabilité (sujet + expéditeur)
    assert.match(text, /Your Webflow receipt/)
    assert.match(text, /no-reply@webflow\.com/)
  }
})

test('renderEmailHtmlPdf rejette un corps HTML vide', async () => {
  await assert.rejects(() => renderEmailHtmlPdf({ subject: 'x', html: '' }), /HTML vide/)
})

test('stripActiveContent retire scripts, iframes, handlers et javascript:', () => {
  const dirty = `<div onclick="evil()">ok</div>
<script>alert(1)</script>
<script src="https://x/y.js"></script>
<iframe src="https://x"></iframe>
<a href="javascript:evil()">lien</a>
<img src="https://x/logo.png" onload='evil()'>`
  const clean = stripActiveContent(dirty)
  assert.ok(!/(<script|<iframe|onclick|onload|javascript:)/i.test(clean))
  assert.match(clean, />ok</)
  assert.match(clean, /logo\.png/)
})
