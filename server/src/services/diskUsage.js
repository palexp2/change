import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function readDf() {
  try {
    const { stdout } = await execFileAsync('df', ['-B1', '--output=size,used,avail', '/'], { timeout: 5000 })
    const [total, used, available] = stdout.trim().split('\n').at(-1).trim().split(/\s+/).map(Number)
    if ([total, used, available].every(Number.isFinite)) return { total, used, available }
  } catch { /* Keep other health metrics available when disk measurement fails. */ }
  return null
}

export async function getDiskUsage() {
  return { disk: await readDf() }
}
