import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { X, Search } from 'lucide-react'
import api from '../lib/api.js'
import { parseLinkedKeys } from '../lib/customFieldDisplay.jsx'
import { useRecordLinks } from '../lib/useRecordLinks.js'

// ── Éditeur de cellule « lien » ─────────────────────────────────────────────
//
// Une cellule de lien n'affichait que ses pastilles : on voyait à quoi la ligne
// est liée, sans jamais pouvoir DÉFAIRE ni AJOUTER un lien. Cet éditeur est la
// contrepartie manipulable de `LinkedRecordsValue` — dans le mode tableur d'un
// DataTable, un double-clic sur la cellule ouvre :
//
//   • une pastille par lien existant, chacune avec un « × » → DISSOCIER
//   • un champ de recherche + la liste des fiches de la table cible → ASSOCIER
//
// La colonne dit ce qu'elle est (voir DataTable, prop `columns`) :
//   linkTarget   table ERP cible ('products', 'adresses'…). À défaut, elle est
//                déduite des liens déjà présents (le miroir sait de quelle table
//                vient un recXXXX) — sans cible connue, on peut encore dissocier.
//   linkMulti    plusieurs liens par cellule (champ lien Airtable) ; sinon un
//                seul (colonne FK : choisir remplace, « Aucun » vide).
//   linkOptions  liste de candidats fournie par la page — court-circuite la
//                recherche serveur quand la page a déjà la bonne liste (ex. les
//                produits ACTIFS du catalogue, et pas tout l'historique).
//   linkIdentity identifiant à stocker : 'erp' (id Boréal) ou 'airtable'
//                (recXXXX). Par défaut on suit ce que la colonne contient déjà.
//
// La valeur commitée garde la forme canonique de la colonne : tableau JSON pour
// un champ lien multi (comme l'écrit la sync Airtable, cf. convertValue), id nu
// ou null pour une FK.

const REC_ID = /^rec[A-Za-z0-9]{14}$/

export default function LinkCellEditor({ col, value, onCommit, onCancel }) {
  const multi = !!col.linkMulti
  const pageOptions = Array.isArray(col.linkOptions) ? col.linkOptions : null

  const initial = useMemo(() => parseLinkedKeys(value), [value])
  const [sel, setSel] = useState(initial)
  const [q, setQ] = useState('')
  const [results, setResults] = useState(pageOptions || [])
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  // Ancre invisible laissée DANS la cellule : le panneau, lui, est rendu en
  // portail (voir plus bas) et n'a plus de position relative à la cellule.
  const anchorRef = useRef(null)
  const [pos, setPos] = useState(null)

  // Libellés des liens en place (le cache de useRecordLinks les a déjà pour la
  // cellule affichée : les pastilles ne clignotent pas à l'ouverture).
  const resolved = useRecordLinks(sel, col.linkTarget || null)
  // Table cible : déclarée par la colonne, sinon celle des liens déjà présents.
  const target = col.linkTarget || resolved.find(r => r?.table)?.table || null

  useEffect(() => { inputRef.current?.focus() }, [])

  // ── Position du panneau ───────────────────────────────────────────────────
  // Rendu dans <body> et non dans la cellule : le conteneur de scroll du tableau
  // rognait la liste (on ne voyait que deux ou trois produits sur une ligne du
  // bas). Il se cale sous la cellule, se retourne vers le haut quand la place
  // manque, et suit le tableau si on le fait défiler.
  const PANEL_H = 320
  const place = useCallback(() => {
    const cell = anchorRef.current?.parentElement
    if (!cell) return
    const r = cell.getBoundingClientRect()
    const width = Math.max(Math.round(r.width), 300)
    const below = window.innerHeight - r.bottom
    setPos({
      top: below > PANEL_H || r.top < PANEL_H ? Math.round(r.bottom + 2) : Math.round(r.top - PANEL_H - 2),
      left: Math.round(Math.max(8, Math.min(r.left, window.innerWidth - width - 8))),
      width,
      maxHeight: Math.round(Math.max(180, Math.min(PANEL_H, below > PANEL_H || r.top < PANEL_H ? below - 12 : r.top - 12))),
    })
  }, [])
  useLayoutEffect(() => { place() }, [place])
  useEffect(() => {
    const onMove = () => place()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [place])

  // Recherche des candidats. Liste de page → filtrage local ; sinon serveur,
  // débounce 200 ms (une frappe = pas un appel).
  useEffect(() => {
    const term = q.trim().toLowerCase()
    if (pageOptions) {
      const list = term
        ? pageOptions.filter(o => `${o.label || ''} ${o.sub || ''}`.toLowerCase().includes(term))
        : pageOptions
      setResults(list.slice(0, 60))
      setCursor(0)
      return
    }
    if (!target) { setResults([]); return }
    let alive = true
    const timer = setTimeout(() => {
      api.recordLinks.search(target, q.trim(), 40)
        .then(res => { if (alive) { setResults(res?.data || []); setCursor(0) } })
        .catch(() => { if (alive) setResults([]) })
    }, 200)
    return () => { alive = false; clearTimeout(timer) }
  }, [q, target, pageOptions])

  // Identifiant à stocker pour un candidat : celui qui a cours dans la colonne.
  // Un champ lien Airtable sans table cible garde ses recXXXX — y écrire un id
  // Boréal mélangerait les deux identités dans la même colonne.
  const keyFor = useCallback((rec) => {
    const wantAirtable = col.linkIdentity === 'airtable'
      || (col.linkIdentity !== 'erp' && initial.some(k => REC_ID.test(k)))
    return String((wantAirtable && rec.airtable_id) || rec.id)
  }, [col.linkIdentity, initial])

  const serialize = useCallback((keys) => (
    multi ? JSON.stringify(keys) : (keys[0] ?? null)
  ), [multi])

  function associate(rec) {
    const key = keyFor(rec)
    if (multi) {
      if (sel.includes(key)) return
      setSel(prev => [...prev, key])
      setQ('')
      inputRef.current?.focus()
    } else {
      onCommit(serialize([key]))
    }
  }

  function dissociate(key) {
    const next = sel.filter(k => k !== key)
    if (multi) setSel(next)
    else onCommit(serialize(next))
  }

  const candidates = results.filter(r => !sel.includes(keyFor(r)))

  const panel = (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="datatable-link-editor"
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, candidates.length - 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)) }
        else if (e.key === 'Enter') {
          e.preventDefault()
          if (candidates[cursor]) associate(candidates[cursor])
          else if (multi) onCommit(serialize(sel))
        }
      }}
      onBlur={e => {
        // Multi : le panneau se referme sur ce qui a été composé (associations et
        // dissociations comprises). Mono : choisir COMMIT déjà, un abandon ne
        // doit rien écrire.
        if (!e.currentTarget.contains(e.relatedTarget)) {
          if (multi) onCommit(serialize(sel)); else onCancel()
        }
      }}
      style={pos ? { position: 'fixed', top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight } : { visibility: 'hidden' }}
      className="z-50 overflow-y-auto rounded-lg border border-brand-500 bg-white shadow-lg py-1"
    >
      {/* Liens en place — un « × » par pastille pour dissocier. */}
      {sel.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2 pb-1.5 border-b border-slate-100" data-testid="link-editor-current">
          {sel.map((key, i) => {
            const rec = resolved[i]
            const label = rec === undefined ? '…' : (rec?.label || (key.length > 12 ? `${key.slice(0, 8)}…` : key))
            const title = rec?.sub ? `${rec.label} · ${rec.sub}` : label
            return (
              <span key={key} className="inline-flex items-center gap-0.5 rounded bg-slate-100 pl-2 pr-0.5 py-0.5 text-[11px] text-slate-700 max-w-full">
                {/* Dans une cellule éditable, le clic ne suit plus les liens
                    (il sélectionne la cellule) : c'est ici que la fiche visée
                    reste accessible d'un clic. */}
                {rec?.url
                  ? <Link to={rec.url} title={title} className="truncate text-brand-600 hover:underline">{label}</Link>
                  : <span className="truncate" title={title}>{label}</span>}
                <button
                  type="button"
                  onClick={() => dissociate(key)}
                  title="Dissocier"
                  data-testid={`link-editor-remove-${key}`}
                  className="p-0.5 rounded text-slate-400 hover:text-red-600 hover:bg-white"
                >
                  <X size={11} />
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* Association. Sans table cible connue, aucune liste n'est possible —
          le dire, plutôt qu'un champ de recherche qui ne rend jamais rien. */}
      {!target ? (
        <div className="px-3 py-2 text-xs text-slate-400">
          Table cible inconnue : ce champ ne permet que de dissocier.
        </div>
      ) : (
        <>
          <div className="px-2 py-1 sticky top-0 bg-white">
            <div className="relative">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                ref={inputRef}
                value={q}
                onChange={e => setQ(e.target.value)}
                data-testid="link-editor-search"
                className="input input-sm w-full pl-7"
              />
            </div>
          </div>
          {!multi && sel.length > 0 && (
            <button
              type="button"
              onClick={() => dissociate(sel[0])}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-50"
            >
              — Aucun —
            </button>
          )}
          <div>
            {candidates.length === 0 && (
              <div className="px-3 py-1.5 text-xs text-slate-400">Aucun enregistrement</div>
            )}
            {candidates.map((rec, i) => (
              <button
                type="button"
                key={rec.id}
                onClick={() => associate(rec)}
                onMouseEnter={() => setCursor(i)}
                data-testid="link-editor-option"
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-50 ${i === cursor ? 'bg-brand-50' : ''}`}
              >
                <span className="flex-1 truncate text-slate-700">{rec.label || rec.id}</span>
                {rec.sub && <span className="text-xs text-slate-400 truncate max-w-[40%]">{rec.sub}</span>}
              </button>
            ))}
          </div>
          {multi && (
            <div className="border-t border-slate-100 mt-1 pt-1 px-2">
              <button
                type="button"
                onClick={() => onCommit(serialize(sel))}
                className="w-full text-xs text-brand-600 hover:text-brand-700 py-1"
              >
                Terminé
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )

  return (
    <>
      <span ref={anchorRef} className="hidden" aria-hidden="true" />
      {createPortal(panel, document.body)}
    </>
  )
}
