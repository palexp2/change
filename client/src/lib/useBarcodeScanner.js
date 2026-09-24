import { useEffect, useRef } from 'react'

// ── Lecture d'un pistolet code-barre ──────────────────────────────────────────
//
// `maxDelay` = intervalle MAX toléré entre deux frappes d'un même code.
// Un pistolet émet ses caractères en rafale puis un Enter terminateur ; on
// repart à zéro seulement après une vraie pause (frappe orpheline restée en
// buffer). 50 ms était trop serré : un scanner Bluetooth ou avec gigue USB/OS
// envoie souvent à 60–100 ms/caractère, avec des pointes occasionnelles bien
// plus hautes. Dès qu'UN seul intervalle dépassait 50 ms, le buffer était vidé
// et il ne restait qu'un caractère → onScan jamais appelé. 500 ms absorbe la
// gigue d'un scanner lent ; l'Enter vide le buffer de toute façon, donc deux
// scans successifs ne fusionnent pas.
export function useBarcodeScanner(onScan, { minLength = 3, maxDelay = 500 } = {}) {
  const bufferRef = useRef('')
  const lastTimeRef = useRef(0)

  useEffect(() => {
    // Signale qu'un scanner est actif sur cette page. `Layout` s'en sert pour
    // désactiver ses raccourcis clavier à lettre unique (d/t/b/p/c) : sinon le
    // 1er caractère d'un code (ex. « T » de TH5267 → raccourci /feuille-de-temps)
    // déclenche une navigation avant que le code complet ne soit lu. Compteur
    // (et non booléen) pour rester correct si plusieurs scanners coexistent.
    window.__barcodeScannerActive = (window.__barcodeScannerActive || 0) + 1
    function handleKeyDown(e) {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.ctrlKey || e.metaKey || e.altKey) return

      const now = Date.now()
      if (now - lastTimeRef.current > maxDelay && bufferRef.current.length > 0) {
        bufferRef.current = ''
      }
      lastTimeRef.current = now

      if (e.key === 'Enter') {
        if (bufferRef.current.length >= minLength) onScan(bufferRef.current)
        bufferRef.current = ''
        return
      }
      if (e.key.length === 1) bufferRef.current += e.key
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.__barcodeScannerActive = Math.max(0, (window.__barcodeScannerActive || 1) - 1)
    }
  }, [onScan, minLength, maxDelay])
}

export default useBarcodeScanner
