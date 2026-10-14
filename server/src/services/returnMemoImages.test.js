import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { loadFieldAttachmentBuffer, toPdfImage } from './returnMemoImages.js'

let tmp, prevUploads, png, webp
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-img-'))
  prevUploads = process.env.UPLOADS_PATH
  process.env.UPLOADS_PATH = tmp
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#f00' } }).png().toBuffer()
  webp = await sharp(png).webp().toBuffer()
  fs.mkdirSync(path.join(tmp, 'attachments', 'airtable'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'attachments', 'airtable', 'a.png'), png)
  fs.mkdirSync(path.join(tmp, 'attachments', 'fields', 'f1', 'p1'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'attachments', 'fields', 'f1', 'p1', 'x_t.webp'), webp)
})
after(() => {
  if (prevUploads === undefined) delete process.env.UPLOADS_PATH
  else process.env.UPLOADS_PATH = prevUploads
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('forme texte : premier chemin miroir', () => {
  const buf = loadFieldAttachmentBuffer('/erp/api/attachments/airtable/a.png, /erp/api/attachments/airtable/b.png', 'f1', 'p1')
  assert.ok(buf?.equals(png))
})

test('forme JSON : premier descripteur image du champ', () => {
  const value = JSON.stringify([{ id: 'doc.pdf', name: 'doc.pdf', type: 'application/pdf' }, { id: 'x_t.webp', name: 't.webp', size: 1, type: 'image/webp' }])
  assert.ok(loadFieldAttachmentBuffer(value, 'f1', 'p1')?.equals(webp))
})

test('URL Airtable brute, fichier absent ou JSON invalide → null', () => {
  assert.equal(loadFieldAttachmentBuffer('https://v5.airtableusercontent.com/x.png', 'f1', 'p1'), null)
  assert.equal(loadFieldAttachmentBuffer('[{"id":"absent.png","type":"image/png"}]', 'f1', 'p1'), null)
  assert.equal(loadFieldAttachmentBuffer('[oops', 'f1', 'p1'), null)
})

test('toPdfImage : webp converti en PNG, PNG inchangé', async () => {
  assert.equal(await toPdfImage(png), png)
  const out = await toPdfImage(webp)
  assert.equal(out.subarray(1, 4).toString(), 'PNG')
  assert.equal(await toPdfImage(Buffer.from('nope')), null)
})
