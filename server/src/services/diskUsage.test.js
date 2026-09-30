import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, linkSync, symlinkSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseDiskSizes, buildDiskBreakdown } from './diskUsage.js'

const home = '/home/test'
const repo = `${home}/erp`
const options = { home, repo }

test('partitions nested directories without double counting and combines both call stores', () => {
  const sizes = new Map([
    [home, 1000], [repo, 700], [`${repo}/server/uploads`, 400],
    [`${repo}/server/uploads/calls`, 100], [`${repo}/server/uploads/soumissions`, 200],
    [`${repo}/server/uploads/products`, 50], [`${repo}/server/data`, 100],
    [`${repo}/server/data/security-backups`, 30], [`${repo}/client/dist`, 120],
    [`${repo}/client/dist.prev`, 50], [`${home}/ftp-server`, 90], [`${home}/ftp-server/uploads`, 80],
    [`${home}/.npm`, 100], ['/var', 100], ['/var/log', 70], ['/var/cache', 20], ['/usr', 200],
  ])
  const groups = buildDiskBreakdown(sizes, 1500, options)
  const byId = Object.fromEntries(groups.map(group => [group.id, group]))
  assert.equal(byId.calls.bytes, 180)
  assert.deepEqual(byId.calls.details.map(item => item.bytes), [100, 80])
  assert.equal(byId.documents.bytes, 100)
  assert.equal(byId.database.bytes, 70)
  assert.equal(byId.backups.bytes, 30)
  assert.equal(byId.erp.bytes, 30)
  assert.equal(byId.services.bytes, 120)
  assert.equal(byId.system.bytes, 210)
  assert.equal(byId.unallocated.bytes, 200)
  assert.equal(groups.reduce((sum, group) => sum + group.bytes, 0), 1500)
  for (const group of groups.filter(group => group.details.length)) {
    assert.equal(group.bytes, group.details.reduce((sum, detail) => sum + detail.bytes, 0))
  }
  assert.ok(groups.every((group, i) => i === 0 || groups[i - 1].bytes >= group.bytes))
})

test('missing or unreadable paths remain unallocated instead of being labelled as system', () => {
  assert.deepEqual(buildDiskBreakdown(new Map(), 0, options), [])
  const groups = buildDiskBreakdown(new Map(), 500, options)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].id, 'unallocated')
  assert.equal(groups[0].bytes, 500)
  const partial = buildDiskBreakdown(new Map([[`${repo}/server/uploads/calls`, 50]]), 500, options)
  assert.equal(partial.reduce((sum, group) => sum + group.bytes, 0), 500)
})

test('uses allocated blocks without following symlinks or counting hard links twice', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'erp-disk-'))
  try {
    writeFileSync(path.join(directory, 'recording'), Buffer.alloc(8192))
    const scan = () => parseDiskSizes(execFileSync('du', ['-x', '-B1', '--max-depth=4', '--', directory], { encoding: 'utf8' })).get(directory)
    const before = scan()
    linkSync(path.join(directory, 'recording'), path.join(directory, 'hard-link'))
    symlinkSync('/usr', path.join(directory, 'symbolic-link'))
    assert.equal(scan(), before)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('parses paths containing spaces and ignores incomplete output', () => {
  assert.deepEqual([...parseDiskSizes('4096\t/home/test/a folder\ninvalid\n')], [['/home/test/a folder', 4096]])
})
