import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import { ExternalLink, Unlink, Check, X } from 'lucide-react'
import { varKey, VAR_LABELS } from '../lib/emailTemplateVars.js'

// Texte d'un modèle de courriel, édité en place :
//  - les liens [texte](url) s'affichent comme des liens ; un clic rouvre leur
//    fenêtre (url, jetons, ouvrir dans un onglet, retirer) au lieu de les suivre ;
//  - les jetons [Company]… s'affichent en petites étiquettes ; un clic ouvre
//    leur fenêtre : texte de remplacement quand la valeur manque (partagé par
//    toutes les étiquettes du même jeton), retirer.
// Le format enregistré ne change pas (texte + [texte](url) + [Variable]),
// rendu à l'insertion par lib/emailTemplateVars.js.

const LINK_RE = /\[([^\]\n]+)\]\(((?:[^)\s[]|\[[^\]\n]*\])+)\)/g
const VAR_RE = /\[([^\]\n]{1,40})\]/g
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const LINK_CLASS = 'tpl-link text-brand-700 underline cursor-pointer'
const CHIP_CLASS = 'tpl-var inline-block align-baseline mx-0.5 px-1.5 rounded border border-brand-200 bg-brand-50 text-brand-800 text-xs leading-5 cursor-pointer select-none'

const chipHtml = name => `<span contenteditable="false" data-var="${esc(name)}" class="${CHIP_CLASS}">${esc(name)}</span>`

// Texte hors lien : les jetons connus deviennent des étiquettes.
const textHtml = s => {
  let out = ''
  let last = 0
  for (const m of s.matchAll(VAR_RE)) {
    if (!varKey(m[1])) continue
    out += esc(s.slice(last, m.index)) + chipHtml(VAR_LABELS[varKey(m[1])] || m[1])
    last = m.index + m[0].length
  }
  return out + esc(s.slice(last))
}

function toHtml(text) {
  return String(text || '').split('\n').map(line => {
    let out = ''
    let last = 0
    for (const m of line.matchAll(LINK_RE)) {
      out += textHtml(line.slice(last, m.index))
      out += `<a data-url="${esc(m[2])}" class="${LINK_CLASS}">${esc(m[1])}</a>`
      last = m.index + m[0].length
    }
    out += textHtml(line.slice(last))
    return `<div>${out || '<br>'}</div>`
  }).join('')
}

// DOM de l'éditeur → texte du modèle (une ligne par bloc).
function fromDom(root) {
  const lines = []
  let cur = ''
  const flush = () => { lines.push(cur); cur = '' }
  const inline = node => {
    if (node.nodeType === 3) { cur += node.nodeValue.replace(/\u00a0/g, ' '); return }
    if (node.nodeType !== 1) return
    if (node.tagName === 'BR') return
    if (node.dataset?.var) { cur += `[${node.dataset.var}]`; return }
    if (node.tagName === 'A' && node.dataset.url !== undefined) {
      const label = node.textContent.replace(/[[\]\n]/g, ' ')
      cur += node.dataset.url ? `[${label}](${node.dataset.url})` : label
      return
    }
    if (node.tagName === 'DIV' || node.tagName === 'P') {
      if (cur) flush()
      node.childNodes.forEach(inline)
      flush()
      return
    }
    node.childNodes.forEach(inline)
  }
  root.childNodes.forEach(inline)
  if (cur) flush()
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

const TemplateBodyEditor = forwardRef(function TemplateBodyEditor(
  { value, onSave, vars = [], linkOptions = [], fallbacks = {}, onFallback, testId }, ref) {
  const rootRef = useRef(null)
  const wrapRef = useRef(null)
  const popRef = useRef(null)
  const savedRange = useRef(null)
  const inputRef = useRef(null)
  const [pop, setPop] = useState(null) // { kind: 'link'|'var', el, top, left }

  useEffect(() => {
    if (rootRef.current && fromDom(rootRef.current) !== (value || '')) rootRef.current.innerHTML = toHtml(value)
  }, [value])

  // Infobulle des étiquettes : texte de remplacement actuel.
  useEffect(() => {
    rootRef.current?.querySelectorAll('[data-var]').forEach(el => {
      const fb = fallbacks[varKey(el.dataset.var)]
      el.title = fb ? `Si vide : ${fb}` : 'Si vide : rien'
    })
  })

  const commit = () => { const text = fromDom(rootRef.current); if (text !== (value || '')) onSave(text) }

  function rememberCaret() {
    const sel = window.getSelection()
    if (sel.rangeCount && rootRef.current.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange()
  }

  function openPopover(el, kind) {
    const box = el.getBoundingClientRect()
    const wrap = wrapRef.current.getBoundingClientRect()
    setPop({ el, kind, top: box.bottom - wrap.top + 6, left: Math.max(0, box.left - wrap.left) })
  }

  // Bouton lien / Ctrl+K : le texte sélectionné devient un lien, fenêtre ouverte.
  function startLink() {
    const sel = window.getSelection()
    if (!sel.rangeCount || sel.isCollapsed || !rootRef.current.contains(sel.anchorNode)) return
    const range = sel.getRangeAt(0)
    const a = document.createElement('a')
    a.dataset.url = ''
    a.className = LINK_CLASS
    a.textContent = range.toString().replace(/\n/g, ' ')
    range.deleteContents()
    range.insertNode(a)
    sel.removeAllRanges()
    openPopover(a, 'link')
  }

  // Jeton inséré au curseur, sous forme d'étiquette.
  function insertVar(name) {
    const root = rootRef.current
    root.focus()
    const sel = window.getSelection()
    if (savedRange.current && root.contains(savedRange.current.startContainer)) { sel.removeAllRanges(); sel.addRange(savedRange.current) }
    if (!sel.rangeCount || !root.contains(sel.anchorNode)) {
      const r = document.createRange()
      r.selectNodeContents(root)
      r.collapse(false)
      sel.removeAllRanges()
      sel.addRange(r)
    }
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const holder = document.createElement('span')
    holder.innerHTML = chipHtml(name)
    const chip = holder.firstChild
    const after = document.createTextNode('\u00a0')
    range.insertNode(after)
    range.insertNode(chip)
    range.setStartAfter(after)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
    savedRange.current = range.cloneRange()
    commit()
  }

  useImperativeHandle(ref, () => ({ startLink, insertVar }))

  function closePopover(apply) {
    if (!pop) return
    const text = (inputRef.current?.value ?? '').trim()
    if (pop.kind === 'link') {
      if (apply && text) {
        pop.el.dataset.url = /^(https?:\/\/|mailto:|\[)/i.test(text) ? text : `https://${text}`
      } else if (!pop.el.dataset.url || (apply && !text)) {
        pop.el.replaceWith(document.createTextNode(pop.el.textContent))
      }
    } else if (apply) {
      const k = varKey(pop.el.dataset.var)
      if (k && text !== (fallbacks[k] || '')) onFallback?.(k, text)
    }
    setPop(null)
    commit()
  }

  function removeTarget() {
    if (pop.kind === 'link') pop.el.replaceWith(document.createTextNode(pop.el.textContent))
    else pop.el.remove()
    setPop(null)
    commit()
  }

  // Clic hors de la fenêtre : on garde ce qui est saisi.
  useEffect(() => {
    if (!pop) return undefined
    const onDown = e => { if (popRef.current && !popRef.current.contains(e.target)) closePopover(true) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  })

  function insertToken(name) {
    const input = inputRef.current
    const v = input.value
    const s = input.selectionStart ?? v.length, e = input.selectionEnd ?? v.length
    input.value = `${v.slice(0, s)}[${name}]${v.slice(e)}`
    input.focus()
    const pos = s + name.length + 2
    input.setSelectionRange(pos, pos)
  }

  // Aperçu : les jetons sont retirés (pas de destinataire ici).
  const previewUrl = () => (inputRef.current?.value || '').replace(/\[[^\]]*\]/g, '')
  const onKey = e => {
    if (e.key === 'Enter') { e.preventDefault(); closePopover(true) }
    if (e.key === 'Escape') { e.preventDefault(); closePopover(false) }
  }
  const iconBtn = 'btn-secondary !px-2 !py-1'

  return (
    <div ref={wrapRef} className="relative">
      <div ref={rootRef} contentEditable suppressContentEditableWarning data-testid={testId}
        className="input text-sm min-h-[20rem] whitespace-pre-wrap leading-relaxed"
        onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); startLink() } }}
        onKeyUp={rememberCaret} onMouseUp={rememberCaret}
        onClick={e => {
          const chip = e.target.closest('[data-var]')
          if (chip) { e.preventDefault(); openPopover(chip, 'var'); return }
          const a = e.target.closest('a[data-url]')
          if (a) { e.preventDefault(); openPopover(a, 'link') }
        }}
        onBlur={e => { if (!wrapRef.current.contains(e.relatedTarget)) commit() }} />
      {pop && (
        <div ref={popRef} className="absolute z-20 w-[26rem] max-w-full bg-white border border-slate-200 rounded-lg shadow-lg p-2 space-y-2"
          style={{ top: pop.top, left: Math.min(pop.left, 200) }}
          data-testid={pop.kind === 'link' ? 'template-link-popover' : 'template-var-popover'}>
          {pop.kind === 'link' ? (<>
            {/* Jetons au-dessus de l'adresse (rien ne les recouvre). */}
            <div className="flex flex-wrap gap-1">
              {vars.map(v => (
                <button key={v} type="button" data-testid="template-link-token"
                  className="text-xs px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:text-slate-800"
                  onMouseDown={e => e.preventDefault()} onClick={() => insertToken(v)}>[{v}]</button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <input ref={inputRef} className="input text-sm flex-1" autoFocus autoComplete="off" defaultValue={pop.el.dataset.url || ''}
                data-testid="template-link-url" onKeyDown={onKey} />
              <button type="button" className={iconBtn} title="Ouvrir dans un nouvel onglet" data-testid="template-link-open"
                onClick={() => { const u = previewUrl(); if (u) window.open(u, '_blank', 'noopener') }}>
                <ExternalLink size={13} />
              </button>
              <button type="button" className={iconBtn} title="Retirer le lien" data-testid="template-link-remove" onClick={removeTarget}>
                <Unlink size={13} />
              </button>
              <button type="button" className="btn-primary !px-2 !py-1" title="OK" data-testid="template-link-apply" onClick={() => closePopover(true)}>
                <Check size={13} />
              </button>
            </div>
            {linkOptions.length > 0 && (
              <select className="input text-xs" value="" data-testid="template-link-pages"
                onChange={e => { if (e.target.value && inputRef.current) { inputRef.current.value = e.target.value; inputRef.current.focus() } }}>
                <option value="">Page hébergée…</option>
                {linkOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}
          </>) : (<>
            <div className="text-xs text-slate-500">[{pop.el.dataset.var}] — si vide :</div>
            <div className="flex items-center gap-1">
              <input ref={inputRef} className="input text-sm flex-1" autoFocus autoComplete="off"
                defaultValue={fallbacks[varKey(pop.el.dataset.var)] || ''} data-testid="template-var-fallback" onKeyDown={onKey} />
              <button type="button" className={iconBtn} title="Retirer le jeton" data-testid="template-var-remove" onClick={removeTarget}>
                <X size={13} />
              </button>
              <button type="button" className="btn-primary !px-2 !py-1" title="OK" data-testid="template-var-apply" onClick={() => closePopover(true)}>
                <Check size={13} />
              </button>
            </div>
          </>)}
        </div>
      )}
    </div>
  )
})

export default TemplateBodyEditor
