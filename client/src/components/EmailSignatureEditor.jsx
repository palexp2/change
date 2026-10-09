import { useEffect, useRef, useState } from 'react'
import { Check, ImagePlus, Link2 } from 'lucide-react'
import api from '../lib/api.js'
import { getEmailSignature, getUserEmailSignature, saveEmailSignature } from '../lib/emailSignature.js'
import { useToast } from '../contexts/ToastContext.jsx'

// URL saisie → href utilisable : « orisha.io » → https://, « a@b.c » → mailto:.
function normalizeUrl(raw) {
  const v = String(raw || '').trim()
  if (!v) return ''
  if (/^(https?:|mailto:|tel:)/i.test(v)) return v
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`
  return `https://${v.replace(/^\/+/, '')}`
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Signature de courriel (Paramètres › Ma boîte Gmail), une par langue (`lang`
// 'fr' | 'en') : le composeur pose celle de la langue du contact. Zone éditable riche :
// un copier-coller de la signature Gmail garde liens, gras et images.
// Images ajoutées (bouton ou collage) → fichier public, pour qu'elles
// s'affichent chez le destinataire. Enregistrée automatiquement à la sortie du champ.
// `userId` : signature d'un autre utilisateur (admin seulement).
export default function EmailSignatureEditor({ lang = 'fr', userId = null }) {
  const ref = useRef(null)
  const lastRef = useRef('')
  const rangeRef = useRef(null)
  const fileRef = useRef(null)
  const linkOpenRef = useRef(false)
  const [ready, setReady] = useState(false)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState(null) // { url, anchor } quand le champ URL est ouvert
  const { addToast } = useToast()

  useEffect(() => {
    let alive = true
    setReady(false)
    ;(userId ? getUserEmailSignature(userId, lang) : getEmailSignature(lang)).then(sig => {
      if (!alive || !ref.current) return
      ref.current.innerHTML = sig
      lastRef.current = ref.current.innerHTML
      setReady(true)
    }).catch(e => { if (alive) addToast({ message: e.message || 'Signature illisible', type: 'error' }) })
    return () => { alive = false }
  }, [lang, userId]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    const el = ref.current
    if (!el) return
    const html = (el.textContent.trim() || el.querySelector('img')) ? el.innerHTML : ''
    if (html === lastRef.current) return
    try {
      const sig = await saveEmailSignature(html, lang, userId)
      lastRef.current = html
      if (!html) el.innerHTML = ''
      else if (sig !== html) { el.innerHTML = sig; lastRef.current = el.innerHTML }
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      addToast({ message: e.message || 'Signature non enregistrée', type: 'error' })
    }
  }

  // Mémorise la position du curseur : les boutons et le champ URL volent le focus.
  const keepRange = () => {
    const sel = window.getSelection()
    if (sel?.rangeCount && ref.current?.contains(sel.anchorNode)) rangeRef.current = sel.getRangeAt(0).cloneRange()
  }

  const restoreRange = () => {
    const el = ref.current
    el.focus()
    const sel = window.getSelection()
    sel.removeAllRanges()
    if (rangeRef.current && el.contains(rangeRef.current.startContainer)) {
      sel.addRange(rangeRef.current)
    } else {
      const r = document.createRange()
      r.selectNodeContents(el)
      r.collapse(false)
      sel.addRange(r)
    }
  }

  const insertHtml = html => {
    restoreRange()
    document.execCommand('insertHTML', false, html)
    keepRange()
    save()
  }

  const uploadImages = async files => {
    const imgs = [...files].filter(f => f.type.startsWith('image/'))
    if (!imgs.length) return
    setBusy(true)
    try {
      for (const f of imgs) {
        const fd = new FormData()
        fd.append('file', f)
        fd.append('folder', 'signatures')
        const row = await api.publicFiles.upload(fd)
        const src = `${window.location.origin}/erp/p/${row.token}/${encodeURIComponent(row.original_name || f.name)}`
        insertHtml(`<img src="${escapeHtml(src)}" alt="" style="max-width:240px;height:auto">`)
      }
    } catch (e) {
      addToast({ message: e.message || 'Image non ajoutée', type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const onPaste = e => {
    const files = e.clipboardData?.files
    if (files?.length && [...files].some(f => f.type.startsWith('image/')) && !e.clipboardData.getData('text/html')) {
      e.preventDefault()
      keepRange()
      uploadImages([...files])
    }
  }

  const openLink = () => {
    const anchorNode = rangeRef.current?.startContainer
    const el = anchorNode?.nodeType === 1 ? anchorNode : anchorNode?.parentElement
    const anchor = el && ref.current?.contains(el) ? el.closest('a') : null
    linkOpenRef.current = true
    setLink({ url: anchor?.getAttribute('href') || '', anchor })
  }

  const closeLink = () => { linkOpenRef.current = false; setLink(null) }

  const applyLink = () => {
    if (!linkOpenRef.current) return
    const href = normalizeUrl(link?.url)
    const anchor = link?.anchor
    closeLink()
    if (anchor && ref.current?.contains(anchor)) {
      if (href) anchor.setAttribute('href', href)
      else anchor.replaceWith(...anchor.childNodes)
      save()
      return
    }
    if (!href) return
    const text = rangeRef.current && !rangeRef.current.collapsed ? rangeRef.current.toString() : ''
    const label = text || link.url.trim()
    insertHtml(`<a href="${escapeHtml(href)}" target="_blank">${escapeHtml(label)}</a>`)
  }

  const btn = 'p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-40'

  return (
    <div data-testid={`email-signature-${lang}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-sm font-medium text-slate-700">Signature {lang.toUpperCase()}</span>
        {saved && <Check size={14} className="text-green-500" />}
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" className={btn} title="Image" aria-label="Ajouter une image" data-testid={`email-signature-image-${lang}`}
            disabled={!ready || busy} onMouseDown={e => { e.preventDefault(); keepRange() }} onClick={() => fileRef.current?.click()}>
            <ImagePlus size={15} />
          </button>
          <button type="button" className={btn} title="Lien" aria-label="Ajouter un lien" data-testid={`email-signature-link-${lang}`}
            disabled={!ready} onMouseDown={e => { e.preventDefault(); keepRange() }} onClick={openLink}>
            <Link2 size={15} />
          </button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
            onChange={e => { uploadImages([...e.target.files]); e.target.value = '' }} />
        </div>
      </div>
      {link && (
        <input
          autoFocus
          type="text"
          value={link.url}
          onChange={e => setLink(l => ({ ...l, url: e.target.value }))}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); applyLink() }
            if (e.key === 'Escape') closeLink()
          }}
          onBlur={applyLink}
          aria-label="URL du lien"
          data-testid={`email-signature-link-url-${lang}`}
          className="w-full mb-1.5 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-brand-400"
        />
      )}
      <div
        ref={ref}
        contentEditable={ready}
        suppressContentEditableWarning
        onBlur={save}
        onKeyUp={keepRange}
        onMouseUp={keepRange}
        onPaste={onPaste}
        onDrop={e => { if (e.dataTransfer?.files?.length) { e.preventDefault(); uploadImages([...e.dataTransfer.files]) } }}
        aria-label={`Signature de courriel ${lang.toUpperCase()}`}
        className="border border-slate-200 rounded-xl bg-white px-4 py-3 text-sm min-h-[96px] max-h-80 overflow-y-auto focus:outline-none focus:border-brand-400"
        data-testid={`email-signature-editor-${lang}`}
      />
    </div>
  )
}
