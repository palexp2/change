import { useEffect, useRef, useState } from 'react'

// Autocorrecteur d'un champ texte contrôlé : après une pause de frappe, le texte
// part au correcteur (`fix(text) → Promise<string>`) ; la correction n'est
// appliquée que si rien n'a été tapé entre-temps. Seul le passage modifié est
// remplacé, via insertText quand c'est possible : le curseur reste en place et
// Ctrl+Z annule la correction comme une frappe.
const IDLE_MS = 1200

// Plus long préfixe / suffixe communs → la zone réellement changée.
function diffRange(a, b) {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return { start: p, endA: a.length - s, endB: b.length - s }
}

export function useAutocorrect({ text, setText, ref, fix, enabled = true }) {
  const textRef = useRef(text)
  textRef.current = text
  // Dernier texte déjà passé au correcteur (ou rendu par « Annuler ») : pas de
  // second aller-retour pour le même contenu.
  const doneRef = useRef(text)
  // { before, after } de la dernière correction, tant que le texte est `after`.
  const [undo, setUndo] = useState(null)

  useEffect(() => {
    if (!enabled || !text.trim() || text.trim().length < 3 || text === doneRef.current) return
    let alive = true
    const timer = setTimeout(() => {
      const sent = text
      doneRef.current = sent
      fix(sent).then(corrected => {
        if (!alive || textRef.current !== sent || typeof corrected !== 'string' || corrected === sent) return
        apply(sent, corrected)
        doneRef.current = corrected
        setUndo({ before: sent, after: corrected })
      }).catch(() => {})
    }, IDLE_MS)
    return () => { alive = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, enabled])

  function apply(from, to) {
    const el = ref.current
    const { start, endA, endB } = diffRange(from, to)
    if (el && document.activeElement === el) {
      const caret = el.selectionStart
      el.setSelectionRange(start, endA)
      let ok = false
      try { ok = document.execCommand('insertText', false, to.slice(start, endB)) } catch { ok = false }
      if (ok && el.value === to) {
        const pos = caret <= start ? caret : caret >= endA ? caret + (endB - endA) : endB
        el.setSelectionRange(pos, pos)
        return
      }
    }
    setText(to)
  }

  function revert() {
    if (!undo) return
    doneRef.current = undo.before
    setText(undo.before)
    setUndo(null)
  }

  return { corrected: !!undo && undo.after === text, revert }
}
