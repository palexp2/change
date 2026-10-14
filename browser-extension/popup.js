const go = document.getElementById('go')
const out = document.getElementById('out')

const MARK = { ok: '✓', absent: '–', erreur: '✕', wait: '…' }
const STALE_MS = 60000 // un envoi plus vieux est considéré comme figé

function render(items) {
  out.innerHTML = ''
  for (const it of items) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="${it.state}">${MARK[it.state] || '·'}</span>`
      + `<span class="n">${it.label}<br><span class="d">${it.detail}</span></span>`
    out.appendChild(li)
  }
}

// La fenêtre ne fait qu'AFFICHER : le travail vit dans le module et son
// avancement s'écrit dans le stockage. On peut donc la fermer et la rouvrir.
function paint(run) {
  if (!run) return
  const running = !!run.running && Date.now() - (run.at || 0) < STALE_MS
  const items = [...(run.sent || [])]
  if (running && !items.length) items.push({ state: 'wait', label: 'Envoi', detail: 'liste des portails…' })
  if (run.error) items.push({ state: 'erreur', label: 'Échec', detail: run.error })
  render(items)
  go.disabled = running
  go.textContent = running
    ? 'Envoi…'
    : (run.collect ? 'Collecte lancée' : 'Envoyer mes sessions et collecter')
}

chrome.storage.local.get('lastRun').then(({ lastRun }) => paint(lastRun))
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lastRun) paint(changes.lastRun.newValue)
})

go.addEventListener('click', async () => {
  go.disabled = true
  go.textContent = 'Envoi…'
  out.innerHTML = ''
  const res = await chrome.runtime.sendMessage({ type: 'run-bridge' }).catch(e => ({ ok: false, error: e.message }))
  if (!res?.ok) paint({ running: false, error: res?.error || 'le module n’a pas répondu' })
})

document.getElementById('opts').addEventListener('click', (e) => {
  e.preventDefault()
  chrome.runtime.openOptionsPage()
})

// ── Envoyer ce document ──────────────────────────────────────────────────────
const doc = document.getElementById('doc')
const docOut = document.getElementById('docOut')

function paintDoc(d) {
  if (!d) return
  const running = !!d.running && Date.now() - (d.at || 0) < STALE_MS
  doc.disabled = running
  doc.textContent = running ? 'Envoi…' : 'Envoyer ce document à l’extracteur'
  docOut.textContent = ''
  docOut.className = d.error ? 'erreur' : 'ok'
  if (running) return
  if (d.error) { docOut.textContent = `✕ ${d.error}`; return }
  docOut.append(d.status === 'duplicate' ? '✓ Déjà dans l’extracteur ' : '✓ Envoyé ')
  if (d.link) {
    const a = document.createElement('a')
    a.href = d.link; a.target = '_blank'; a.textContent = 'Ouvrir'
    docOut.append(a)
  }
}

chrome.storage.local.get('lastDoc').then(({ lastDoc }) => {
  if (lastDoc && Date.now() - (lastDoc.at || 0) < 120000) paintDoc(lastDoc)
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lastDoc) paintDoc(changes.lastDoc.newValue)
})

doc.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  paintDoc({ running: true, at: Date.now() })
  const res = await chrome.runtime.sendMessage({ type: 'send-document', tabId: tab?.id }).catch(e => ({ ok: false, error: e.message }))
  if (!res?.ok) paintDoc({ running: false, error: res?.error || 'le module n’a pas répondu' })
})

// ── Capture pour Claude ──────────────────────────────────────────────────────
const shot = document.getElementById('shot')
const shotOut = document.getElementById('shotOut')
const pick = document.getElementById('pick')

function preview(file) {
  shot.querySelector('img')?.remove()
  const img = document.createElement('img')
  img.src = URL.createObjectURL(file)
  shot.append(img)
}

async function sendShot(file, buf) {
  if (!file?.type?.startsWith('image/')) { shotOut.className = 'erreur'; shotOut.textContent = '✕ Image attendue'; return }
  shotOut.className = 'd'; shotOut.textContent = 'Envoi…'
  preview(file)
  buf ||= new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  const res = await chrome.runtime.sendMessage({ type: 'send-screenshot', mime: file.type, data: btoa(bin) })
    .catch(e => ({ ok: false, error: e.message }))
  shotOut.className = res?.ok ? 'ok' : 'erreur'
  shotOut.textContent = res?.ok ? '✓ Reçue — dis à Claude « regarde ma capture »' : `✕ ${res?.error || 'le module n’a pas répondu'}`
  return !!res?.ok
}

shot.addEventListener('dragover', (e) => { e.preventDefault(); shot.classList.add('over') })
shot.addEventListener('dragleave', () => shot.classList.remove('over'))
document.addEventListener('dragover', e => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault(); shot.classList.remove('over')
  sendShot(e.dataTransfer?.files?.[0])
})
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'))
  if (item) sendShot(item.getAsFile())
})
shot.addEventListener('click', () => pick.click())
pick.addEventListener('change', () => sendShot(pick.files?.[0]))
document.getElementById('tab').addEventListener('click', (e) => {
  e.preventDefault()
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') })
})

// Capture prise dans le presse-papiers (⌘⌃⇧4 sur Mac) : envoyée dès qu'on ouvre
// le module — une seule fois par image (empreinte retenue).
async function fromClipboard() {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find(t => t.startsWith('image/'))
      if (!type) continue
      const blob = await item.getType(type)
      const buf = new Uint8Array(await blob.arrayBuffer())
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('')
      const { lastShotHash } = await chrome.storage.local.get('lastShotHash')
      if (hash === lastShotHash) return
      if (await sendShot(new File([blob], 'capture', { type }), buf)) await chrome.storage.local.set({ lastShotHash: hash })
      return
    }
  } catch { /* presse-papiers illisible : glisser ou coller reste possible */ }
}
fromClipboard()
