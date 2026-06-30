import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFileSync, existsSync, writeFileSync, readdirSync, rmSync, mkdtempSync } from 'fs'
import { writeFileAtomic, withFileLock } from './atomicFile.js'

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'atomicfile-'))
}

test('writeFileAtomic — écrit le contenu et ne laisse aucun .tmp', () => {
  const dir = freshDir()
  try {
    const f = join(dir, 'users.json')
    writeFileAtomic(f, JSON.stringify([{ ftpUser: 'a' }]))
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), [{ ftpUser: 'a' }])
    // Aucun fichier temporaire résiduel
    assert.deepEqual(readdirSync(dir), ['users.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeFileAtomic — remplace un fichier existant sans état intermédiaire vide', () => {
  const dir = freshDir()
  try {
    const f = join(dir, 'users.json')
    writeFileSync(f, 'ancien')
    writeFileAtomic(f, 'nouveau')
    assert.equal(readFileSync(f, 'utf8'), 'nouveau')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('withFileLock — exécute le callback et nettoie le .lock', () => {
  const dir = freshDir()
  try {
    const f = join(dir, 'users.json')
    const r = withFileLock(f, () => 42)
    assert.equal(r, 42)
    assert.equal(existsSync(`${f}.lock`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('withFileLock — libère le verrou même si le callback lève', () => {
  const dir = freshDir()
  try {
    const f = join(dir, 'users.json')
    assert.throws(() => withFileLock(f, () => { throw new Error('boom') }), /boom/)
    assert.equal(existsSync(`${f}.lock`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('withFileLock — un verrou détenu fait expirer le timeout', () => {
  const dir = freshDir()
  try {
    const f = join(dir, 'users.json')
    // Simule un verrou détenu par un autre process, non périmé.
    writeFileSync(`${f}.lock`, '')
    assert.throws(
      () => withFileLock(f, () => 'jamais atteint', { timeoutMs: 100, staleMs: 60000 }),
      /Lock timeout/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('withFileLock — récupère un verrou orphelin (périmé)', () => {
  const dir = freshDir()
  try {
    const f = join(dir, 'users.json')
    writeFileSync(`${f}.lock`, '') // mtime = maintenant
    // staleMs=0 → le verrou est immédiatement considéré comme orphelin et récupéré.
    const r = withFileLock(f, () => 'ok', { timeoutMs: 1000, staleMs: 0 })
    assert.equal(r, 'ok')
    assert.equal(existsSync(`${f}.lock`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('intégration — read-modify-write sérialisé préserve les deux écritures', () => {
  const dir = freshDir()
  try {
    const f = join(dir, 'users.json')
    writeFileAtomic(f, JSON.stringify([]))
    const add = (u) => withFileLock(f, () => {
      const arr = JSON.parse(readFileSync(f, 'utf8'))
      arr.push(u)
      writeFileAtomic(f, JSON.stringify(arr))
    })
    add({ ftpUser: 'a' })
    add({ ftpUser: 'b' })
    const final = JSON.parse(readFileSync(f, 'utf8'))
    assert.deepEqual(final.map(x => x.ftpUser), ['a', 'b'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
