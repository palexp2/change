// Tests pour collectAttachments — le filtre qui décide quelles pièces jointes
// Gmail deviennent des reçus candidats.
//
// Contexte : un faux reçu (sale_receipt fa2488c9-…) a été créé à partir d'une
// icône de signature courriel « facebook_32x32_….png » (~1-2 Ko) avalée par le
// pipeline d'ingestion. On rejette donc les images trop petites (logos sociaux,
// pixels de suivi).
//
// À l'inverse, certaines factures arrivent comme une PHOTO collée dans le corps
// du courriel (inline, avec un Content-ID) plutôt qu'en pièce jointe. Ces images
// pèsent plusieurs dizaines de Ko et doivent être conservées — le seul critère
// de rejet est la taille (< 20 Ko), pas le caractère inline. Compromis assumé :
// un gros logo de signature inline (> 20 Ko) peut passer, mais c'est rare et
// l'extraction le marquera comme reçu sans valeur, là où perdre une vraie
// facture-photo est bien plus coûteux.

import test from 'node:test'
import assert from 'node:assert/strict'

import { collectAttachments } from './gmail.js'

// Pièce jointe « reçu » légitime : photo/capture de plusieurs Ko, en attachment.
const realReceiptImage = {
  filename: 'recu-quincaillerie.jpg',
  mimeType: 'image/jpeg',
  body: { attachmentId: 'att-real', size: 240 * 1024 },
  headers: [{ name: 'Content-Disposition', value: 'attachment; filename="recu-quincaillerie.jpg"' }],
}

const realReceiptPdf = {
  filename: 'facture.pdf',
  mimeType: 'application/pdf',
  body: { attachmentId: 'att-pdf', size: 1200 },  // un PDF peut être petit : jamais filtré sur la taille
  headers: [{ name: 'Content-Disposition', value: 'attachment; filename="facture.pdf"' }],
}

// L'icône fautive du ticket d'origine.
const facebookIcon = {
  filename: 'facebook_32x32_6bb94b44-b4d1-4169-ae0d-6acab1a7af63.png',
  mimeType: 'image/png',
  body: { attachmentId: 'att-fb', size: 1834 },
  headers: [
    { name: 'Content-Disposition', value: 'inline' },
    { name: 'Content-ID', value: '<facebook_32x32>' },
  ],
}

// Facture envoyée comme photo collée dans le corps : inline avec Content-ID,
// mais volumineuse (plusieurs dizaines de Ko). Doit être conservée.
const inlineInvoicePhoto = {
  filename: 'image.png',
  mimeType: 'image/png',
  body: { attachmentId: 'att-photo', size: 180 * 1024 },
  headers: [
    { name: 'Content-Disposition', value: 'inline; filename="image.png"' },
    { name: 'Content-ID', value: '<ii_facture>' },
  ],
}

test('le vrai reçu image (attachment, >20 Ko) est conservé', () => {
  const found = collectAttachments({ parts: [realReceiptImage] })
  assert.equal(found.length, 1)
  assert.equal(found[0].attachmentId, 'att-real')
})

test('un PDF n\'est jamais filtré sur la taille', () => {
  const found = collectAttachments({ parts: [realReceiptPdf] })
  assert.equal(found.length, 1)
  assert.equal(found[0].attachmentId, 'att-pdf')
})

test('l\'icône facebook_32x32 (image < 20 Ko) est rejetée', () => {
  const found = collectAttachments({ parts: [facebookIcon] })
  assert.equal(found.length, 0)
})

test('une photo de facture inline (Content-ID) > 20 Ko est conservée', () => {
  const found = collectAttachments({ parts: [inlineInvoicePhoto] })
  assert.equal(found.length, 1)
  assert.equal(found[0].attachmentId, 'att-photo')
})

test('email mixte : reçus + photo inline ressortent, pas l\'icône', () => {
  const found = collectAttachments({
    parts: [facebookIcon, realReceiptImage, inlineInvoicePhoto, realReceiptPdf],
  })
  assert.deepEqual(found.map(f => f.attachmentId).sort(), ['att-pdf', 'att-photo', 'att-real'])
})

test('une image en double (copie inline + copie pièce jointe) ne donne qu\'un reçu', () => {
  // Même photo présente deux fois : une fois inline (cid) pour le rendu dans le
  // corps, une fois en pièce jointe. Même nom + même taille → un seul reçu.
  const inlineCopy = {
    filename: 'IMG_4808.jpeg',
    mimeType: 'image/jpeg',
    body: { attachmentId: 'att-inline', size: 320 * 1024 },
    headers: [
      { name: 'Content-Disposition', value: 'inline; filename="IMG_4808.jpeg"' },
      { name: 'Content-ID', value: '<ii_img4808>' },
    ],
  }
  const attachmentCopy = {
    filename: 'IMG_4808.jpeg',
    mimeType: 'image/jpeg',
    body: { attachmentId: 'att-pj', size: 320 * 1024 },
    headers: [{ name: 'Content-Disposition', value: 'attachment; filename="IMG_4808.jpeg"' }],
  }
  const found = collectAttachments({ parts: [inlineCopy, attachmentCopy] })
  assert.equal(found.length, 1)
})

test('deux photos distinctes (noms différents) donnent deux reçus', () => {
  const page1 = {
    filename: 'IMG_4808.jpeg',
    mimeType: 'image/jpeg',
    body: { attachmentId: 'att-1', size: 320 * 1024 },
    headers: [{ name: 'Content-Disposition', value: 'attachment; filename="IMG_4808.jpeg"' }],
  }
  const page2 = {
    filename: 'IMG_4809.jpeg',
    mimeType: 'image/jpeg',
    body: { attachmentId: 'att-2', size: 290 * 1024 },
    headers: [{ name: 'Content-Disposition', value: 'attachment; filename="IMG_4809.jpeg"' }],
  }
  const found = collectAttachments({ parts: [page1, page2] })
  assert.equal(found.length, 2)
})

test('une image attachment sans header de taille reste conservée (pas de faux négatif)', () => {
  const noSize = {
    filename: 'scan.png',
    mimeType: 'image/png',
    body: { attachmentId: 'att-nosize' },  // size absent → on ne rejette pas
    headers: [{ name: 'Content-Disposition', value: 'attachment' }],
  }
  const found = collectAttachments({ parts: [noSize] })
  assert.equal(found.length, 1)
})
