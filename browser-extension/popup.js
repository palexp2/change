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
