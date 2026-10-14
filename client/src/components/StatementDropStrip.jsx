// Dépôt sans fenêtre (maquette A2, 2026-10-13) : on glisse un relevé ou une
// facture n'importe où sur la page, Boréal lit, et ce qui est sûr s'importe
// tout seul — les lignes tombent dans la liste, des pastilles disent ce qui
// s'est passé (+6, Drive ✓, 1 facture). Seul ce qui demande un humain reste,
// en bande orange au-dessus du tableau ; « Voir » ouvre la carte du fichier.
//
// « Sûr » = même règle que le rapprochement automatique : compte trouvé avec
// confiance ET soldes qui se tiennent. Un doute = rien n'est écrit.
import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, X } from 'lucide-react'
import api from '../lib/api.js'
import { Modal } from './Modal.jsx'
import Spinner from './Spinner.jsx'
import { UploadCard } from './StatementDropModal.jsx'
import { fmtMoney } from '../utils/formatters.js'

const freshCount = (up) => (up.rows_json || []).filter((r) => r._new).length

// Ce qui reste à regarder sur un dépôt lu, ou null s'il peut s'importer seul.
export function dropIssue(up) {
  if (up.status === 'erreur') return up.error || 'Lecture impossible'
  if (up.status !== 'pret') return null
  if (up.document_kind === 'facture') return up.sale_receipt_id ? null : (up.error || 'Facture non créée')
  if (up.document_kind === 'solde') {
    const s = up.snapshot || {}
    return s.verdict === 'different' ? `Solde différent de Boréal (Δ ${fmtMoney(s.delta)})` : null
  }
  if (!up.account_id) return 'Quel compte ?'
  if (up.detect_confidence < 0.6) return 'Compte à confirmer'
  if (up.balance_ok === false) {
    return up.balance_method === 'chaine' ? 'Soldes qui ne s’enchaînent pas' : `Il manque ${fmtMoney(Math.abs(up.balance_check))}`
  }
  if (up.balance_ok == null && freshCount(up)) return 'Soldes non vérifiables'
  return null
}

export function useStatementDrops({ onImported }) {
  const [uploads, setUploads] = useState([])
  const [chips, setChips] = useState([])
  const [error, setError] = useState(null)
  const handled = useRef(new Set())
  const chipSeq = useRef(0)

  const chip = useCallback((c) => {
    const id = ++chipSeq.current
    setChips((cs) => [...cs, { ...c, id }])
    if (!c.sticky) setTimeout(() => setChips((cs) => cs.filter((x) => x.id !== id)), 8000)
  }, [])

  const replace = (up) => setUploads((prev) => prev.map((u) => (u.id === up.id ? up : u)))

  const add = useCallback(async (files) => {
    if (!files?.length) return
    setError(null)
    try {
      const fd = new FormData()
      for (const f of files) fd.append('file', f)
      const res = await api.bank.statements.upload(fd)
      setUploads((prev) => [...prev, ...res.uploads])
    } catch (e) { setError(e.message) }
  }, [])

  const commit = useCallback(async (up) => {
    try {
      const r = await api.bank.statements.commit(up.id)
      setUploads((prev) => prev.filter((u) => u.id !== up.id))
      if (r.inserted) chip({ kind: 'ok', text: `+${r.inserted}`, title: up.account_name || up.original_name })
      else chip({ kind: 'mute', text: 'Rien de nouveau', title: up.original_name })
      await onImported?.(r)
      // Le rangement au Drive suit la lecture, en tâche de fond.
      setTimeout(async () => {
        const after = await api.bank.statements.get(up.id).catch(() => null)
        if (after?.drive_filing === 'depose') chip({ kind: 'ok', text: 'Drive ✓', title: after.drive_file_name })
      }, 4000)
    } catch (e) {
      replace({ ...up, status: 'erreur', error: e.message })
    }
  }, [chip, onImported])

  // Lecture côté serveur : on redemande tant qu'un fichier est en cours.
  const pending = uploads.some((u) => u.status === 'en_analyse')
  useEffect(() => {
    if (!pending) return undefined
    const t = setInterval(async () => {
      const ids = uploads.filter((u) => u.status === 'en_analyse').map((u) => u.id)
      const fresh = await Promise.all(ids.map((id) => api.bank.statements.get(id).catch(() => null)))
      setUploads((prev) => prev.map((u) => fresh.find((f) => f?.id === u.id) || u))
    }, 2000)
    return () => clearInterval(t)
  }, [pending, uploads])

  // Chaque dépôt lu passe une fois ici : sûr → importé ou rangé ; sinon il reste.
  useEffect(() => {
    for (const up of uploads) {
      if (up.status !== 'pret' || handled.current.has(up.id) || dropIssue(up)) continue
      handled.current.add(up.id)
      if (up.document_kind === 'facture') {
        chip({ kind: 'blue', text: '1 facture', to: `/sale-receipts/${up.sale_receipt_id}`, title: up.original_name })
        setUploads((prev) => prev.filter((u) => u.id !== up.id))
      } else if (up.document_kind === 'solde' || !freshCount(up)) {
        chip({ kind: 'mute', text: 'Rien de nouveau', title: up.original_name })
        setUploads((prev) => prev.filter((u) => u.id !== up.id))
      } else {
        commit(up)
      }
    }
  }, [uploads, chip, commit])

  const dismiss = (id) => setUploads((prev) => prev.filter((u) => u.id !== id))

  return { uploads, setUploads, replace, chips, error, setError, add, commit, dismiss, pending }
}

const CHIP_CLS = {
  ok: 'bg-green-50 text-green-700',
  blue: 'bg-blue-50 text-blue-700',
  mute: 'bg-slate-100 text-slate-500',
}

// Pastilles + lecture en cours : à côté du titre du compte.
export function DropChips({ drops }) {
  const reading = drops.uploads.filter((u) => u.status === 'en_analyse').length
  if (!reading && !drops.chips.length) return null
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap" data-testid="statement-drop-chips">
      {reading > 0 && (
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
          <Spinner size="sm" />{reading} fichier{reading > 1 ? 's' : ''}
        </span>
      )}
      {drops.chips.map((c) => {
        const cls = `drop-chip-in inline-flex items-center h-[22px] px-2 rounded-full text-xs font-semibold ${CHIP_CLS[c.kind]}`
        return c.to
          ? <Link key={c.id} to={c.to} className={cls} title={c.title}>{c.text} ↗</Link>
          : <span key={c.id} className={cls} title={c.title}>{c.text}</span>
      })}
    </span>
  )
}

// Bandes orange : une par fichier qui attend un humain, plus la carte au clic.
export function DropBands({ drops, accounts }) {
  const [openId, setOpenId] = useState(null)
  const [rowsOpen, setRowsOpen] = useState(false)
  const waiting = drops.uploads.filter((u) => dropIssue(u))
  const open = drops.uploads.find((u) => u.id === openId)

  const act = async (fn) => {
    try { await fn() } catch (e) { drops.setError(e.message) }
  }

  return (
    <>
      {drops.error && (
        <div className="drop-band flex items-center gap-2 px-4 py-2 text-sm bg-red-50 text-red-700 border-b border-slate-200">
          <AlertCircle size={15} /> {drops.error}
          <button className="ml-auto p-1" onClick={() => drops.setError(null)}><X size={14} /></button>
        </div>
      )}
      {waiting.map((u) => (
        <div key={u.id} data-testid="statement-drop-band"
          className="drop-band flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-amber-50 text-amber-800 border-b border-slate-200">
          <AlertCircle size={15} className="shrink-0" />
          <span className="truncate">{u.account_name || u.original_name}</span>
          <span className="font-normal">· {dropIssue(u)}</span>
          <button className="ml-auto px-2.5 py-0.5 rounded-md bg-amber-500 text-white text-xs font-semibold hover:bg-amber-600"
            data-testid="statement-drop-voir" onClick={() => setOpenId(u.id)}>Voir</button>
          <button className="p-1 text-amber-700/60 hover:text-amber-900" title="Ignorer" onClick={() => drops.dismiss(u.id)}><X size={14} /></button>
        </div>
      ))}

      {open && (
        <Modal isOpen onClose={() => setOpenId(null)} title={dropIssue(open) || open.original_name} size="lg">
          <div className="space-y-3">
            <UploadCard up={open} accounts={accounts} expanded={rowsOpen} onToggle={() => setRowsOpen((v) => !v)}
              onChange={(p) => act(async () => drops.replace(await p))}
              onRemove={(id) => act(async () => { await api.bank.statements.remove(id); drops.dismiss(id); setOpenId(null) })}
              onReanalyze={(id) => act(async () => { drops.replace({ ...open, status: 'en_analyse', error: null }); await api.bank.statements.reanalyze(id) })}
              onToExtractor={(id) => act(async () => drops.replace(await api.bank.statements.toReceipt(id)))} />
            {open.status === 'pret' && open.document_kind !== 'facture' && open.document_kind !== 'solde' && open.account_id && freshCount(open) > 0 && (
              <div className="flex justify-end">
                <button className="px-3 py-1.5 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700"
                  data-testid="statement-drop-import"
                  onClick={async () => { setOpenId(null); await drops.commit(open) }}>
                  {dropIssue(open) ? 'Importer quand même' : 'Importer'} {freshCount(open)}
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}

// Saisie manuelle des lignes, pour un relevé qu'on n'a qu'à l'écran.
export function PasteLinesModal({ onClose, onFiles }) {
  const [text, setText] = useState('')
  return (
    <Modal isOpen onClose={onClose} title="Coller des lignes" size="lg">
      <div className="space-y-2">
        <textarea autoFocus className="w-full h-40 border border-slate-300 rounded-lg p-2 font-mono text-xs"
          value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex justify-end">
          <button type="button" disabled={!text.trim()}
            className="px-3 py-1.5 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            onClick={() => {
              onFiles([new File([text.trim()], `lignes-collees-${new Date().toISOString().slice(0, 10)}.csv`, { type: 'text/csv' })])
              onClose()
            }}>
            Lire
          </button>
        </div>
      </div>
    </Modal>
  )
}
