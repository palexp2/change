import { useEffect, useRef, useState } from 'react'
import { FileSpreadsheet } from 'lucide-react'

// Aperçu d'un tableur joint (xlsx, xls, ods, csv) : le classeur est lu dans le
// navigateur — le fichier d'origine reste celui qu'on télécharge. Même rôle que
// PdfThumb pour un PDF : une vignette qui montre les premières cellules, et une
// visionneuse (grille + onglets) pour la modale.

const MAX_ROWS = 500
const MAX_COLS = 50

// Un classeur lu par URL : la vignette et la modale partagent la même lecture.
const cache = new Map()

function readWorkbook(url) {
  if (cache.has(url)) return cache.get(url)
  const promise = (async () => {
    const headers = {}
    try {
      const parsed = new URL(url, window.location.origin)
      if (parsed.origin === window.location.origin && /^\/(erp\/)?api\//.test(parsed.pathname)) {
        headers.Authorization = `Bearer ${localStorage.getItem('erp_token') || ''}`
      }
    } catch { /* blob: ou URL externe */ }
    const res = await fetch(url, { headers })
    if (!res.ok) throw Object.assign(new Error('File unavailable'), { missing: true })
    const buf = new Uint8Array(await res.arrayBuffer())
    const XLSX = await import('xlsx')
    // Zip (xlsx/ods) ou OLE (xls) : binaire. Sinon c'est du texte (csv/tsv),
    // décodé en UTF-8 pour garder les accents.
    const binary = (buf[0] === 0x50 && buf[1] === 0x4b) || (buf[0] === 0xd0 && buf[1] === 0xcf)
    const wb = binary
      ? XLSX.read(buf, { type: 'array', sheetRows: MAX_ROWS + 1 })
      : XLSX.read(new TextDecoder().decode(buf), { type: 'string', sheetRows: MAX_ROWS + 1 })
    return wb.SheetNames.map(name => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: true })
      const width = Math.min(MAX_COLS, rows.reduce((m, r) => Math.max(m, r.length), 0))
      return {
        name,
        rows: rows.slice(0, MAX_ROWS).map(r => Array.from({ length: width }, (_, i) => r[i] ?? '')),
        truncated: rows.length > MAX_ROWS,
      }
    })
  })()
  cache.set(url, promise)
  promise.catch(() => cache.delete(url))
  if (cache.size > 30) cache.delete(cache.keys().next().value)
  return promise
}

function useWorkbook(url, enabled = true) {
  const [state, setState] = useState({ url: null, sheets: null, failed: null })
  useEffect(() => {
    if (!url || !enabled) return
    let cancelled = false
    readWorkbook(url).then(
      sheets => { if (!cancelled) setState({ url, sheets, failed: null }) },
      e => { if (!cancelled) setState({ url, sheets: null, failed: e?.missing ? 'missing' : 'error' }) },
    )
    return () => { cancelled = true }
  }, [url, enabled])
  return state.url === url ? state : { sheets: null, failed: null }
}

function colName(i) {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

// Vignette : les premières cellules de la 1re feuille, en tout petit.
export function SheetThumb({ url, label, onFail, lazy = false, compact = false }) {
  const ref = useRef(null)
  const [visible, setVisible] = useState(!lazy)
  const failRef = useRef(onFail)
  failRef.current = onFail

  useEffect(() => {
    if (!lazy || visible) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '100px' })
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [lazy, visible])

  const { sheets, failed } = useWorkbook(url, visible)
  useEffect(() => { if (failed) failRef.current?.(failed) }, [failed])

  const rows = sheets?.[0]?.rows.slice(0, compact ? 5 : 14).map(r => r.slice(0, compact ? 4 : 6)) || []
  if (failed || (sheets && !rows.length)) {
    return (
      <span ref={ref} className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-slate-400 px-1 text-center">
        <FileSpreadsheet size={compact ? 16 : 20} />
        {!compact && failed && <span className="text-[11px]">{failed === 'missing' ? 'Fichier introuvable' : 'Aperçu indisponible'}</span>}
      </span>
    )
  }
  return (
    <span ref={ref} role="img" aria-label={label} className="absolute inset-0 overflow-hidden bg-fixed-white" data-testid="sheet-thumb">
      {rows.length > 0 && (
        <table className="border-collapse text-slate-700" style={{ fontSize: compact ? 4 : 6, lineHeight: 1.2, tableLayout: 'fixed', width: '100%' }}>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i === 0 ? 'bg-emerald-50 font-semibold' : undefined}>
                {r.map((c, j) => (
                  <td key={j} className="border border-slate-200 px-px truncate" style={{ maxWidth: 0 }}>{String(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </span>
  )
}

// Visionneuse de la modale : grille de la feuille choisie, onglets en bas.
export function SheetViewer({ url }) {
  const { sheets, failed } = useWorkbook(url)
  const [index, setIndex] = useState(0)
  if (failed) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-500">
        <FileSpreadsheet size={32} className="text-slate-300" />
        <p className="text-sm">{failed === 'missing' ? 'Fichier introuvable.' : 'Tableur illisible.'}</p>
      </div>
    )
  }
  if (!sheets) return <div className="flex-1" />
  const sheet = sheets[index] || sheets[0]
  const width = sheet?.rows[0]?.length || 0
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="sheet-viewer">
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="border-collapse text-xs text-slate-800">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-20 bg-slate-100 border border-slate-200 w-10" />
              {Array.from({ length: width }, (_, j) => (
                <th key={j} className="sticky top-0 z-10 bg-slate-100 border border-slate-200 px-2 py-0.5 font-medium text-slate-500">{colName(j)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((r, i) => (
              <tr key={i}>
                <th className="sticky left-0 z-10 bg-slate-100 border border-slate-200 px-2 font-medium text-slate-500 text-right">{i + 1}</th>
                {r.map((c, j) => (
                  <td key={j} className="border border-slate-200 px-2 py-0.5 whitespace-nowrap max-w-xs truncate" title={String(c)}>{String(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.truncated && <p className="px-3 py-2 text-xs text-slate-400">{MAX_ROWS} premières lignes</p>}
      </div>
      {sheets.length > 1 && (
        <div className="flex flex-shrink-0 gap-1 overflow-x-auto border-t border-slate-200 bg-slate-50 px-2 py-1">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setIndex(i)}
              className={`rounded px-2 py-0.5 text-xs whitespace-nowrap ${i === index ? 'bg-white border border-slate-300 font-medium text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
