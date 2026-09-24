const go = document.getElementById('go')
const out = document.getElementById('out')

const MARK = { ok: '✓', absent: '–', erreur: '✕' }

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
  const items = [...(run.sent || [])]
  if (run.error) items.push({ state: 'erreur', label: 'Échec', detail: run.error })
  render(items)
  go.disabled = !!run.running
  go.textContent = run.running
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
