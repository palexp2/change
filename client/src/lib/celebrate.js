// Confirmation visuelle d'un geste accompli (demande de Charles, 2026-10-03 :
// « on n'a pas de feedback »). Une pastille verte avec un crochet qui se trace,
// au bas de l'écran, puis s'efface. Aucun état React : elle survit à la
// fermeture du panneau qui l'a déclenchée.
export function celebrate(text = 'Fait') {
  if (typeof document === 'undefined') return
  const el = document.createElement('div')
  el.className = 'celebrate'
  el.setAttribute('role', 'status')
  el.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#2ca01c"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span></span>'
  el.querySelector('span').textContent = text
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2200)
}
