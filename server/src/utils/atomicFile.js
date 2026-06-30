import {
  openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync, statSync,
} from 'fs'

// Écrit un fichier de façon atomique : écriture dans un tmp voisin puis rename(2),
// qui est atomique sur un même système de fichiers POSIX. Un lecteur concurrent
// (ex. le process ftp-arc qui lit users.json à chaque login) voit toujours soit
// l'ancien contenu complet, soit le nouveau — jamais un fichier tronqué ou à
// moitié écrit. Un crash en cours d'écriture ne corrompt pas le fichier d'origine.
export function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, filePath)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
}

// Verrou inter-process pour sérialiser un cycle read-modify-write sur un fichier
// partagé. S'appuie sur open(..., 'wx') (création exclusive) comme flock advisory :
// deux admins (ou deux process) qui éditent en même temps sont mis en file plutôt
// que de s'écraser mutuellement. Détecte et récupère un verrou orphelin laissé par
// un process mort (mtime > staleMs). Les handlers concernés étant synchrones et les
// écritures quasi-instantanées, l'attente est en pratique nulle ; le busy-wait court
// borné garantit la robustesse même en cas de contention réelle.
export function withFileLock(filePath, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const lockPath = `${filePath}.lock`
  const start = Date.now()
  let fd
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx')
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      // Verrou détenu : récupérer s'il est orphelin, sinon attendre puis réessayer.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        continue // le verrou a disparu entre-temps → retenter immédiatement
      }
      if (Date.now() - start > timeoutMs) throw new Error(`Lock timeout sur ${lockPath}`)
      const until = Date.now() + 25
      while (Date.now() < until) { /* busy-wait court (handlers synchrones) */ }
    }
  }
  try {
    return fn()
  } finally {
    try { closeSync(fd) } catch {}
    try { unlinkSync(lockPath) } catch {}
  }
}
