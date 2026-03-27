import { useState, useEffect } from 'react'
import { Modal } from '../Modal.jsx'
import { AlertCircle, Upload } from 'lucide-react'

export function PastePreviewModal({ open, onClose, rawText, fields = [], onImport }) {
  const [rows, setRows] = useState([])
  const [headers, setHeaders] = useState([])
  const [mapping, setMapping] = useState({})
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    if (!rawText) return
    try {
      const lines = rawText.trim().split('\n')
      const parseRow = (line) => line.split('\t').map(c => c.trim())
      const hdrs = parseRow(lines[0])
      const data = lines.slice(1).map(parseRow)
      setHeaders(hdrs)
      setRows(data)
      // Auto-map by name
      const map = {}
      hdrs.forEach((h, i) => {
        const match = fields.find(f => f.name.toLowerCase() === h.toLowerCase() || f.key.toLowerCase() === h.toLowerCase())
        if (match) map[i] = match.key
      })
      setMapping(map)
    } catch {
      setError('Impossible de lire les données copiées')
    }
  }, [rawText])

  async function handleImport() {
    const records = rows.map(row => {
      const data = {}
      headers.forEach((_, i) => {
        if (mapping[i]) data[mapping[i]] = row[i] ?? ''
      })
      return { data }
    })
    setImporting(true)
    try {
      await onImport(records)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  const mappedCount = Object.values(mapping).filter(Boolean).length

  return (
    <Modal isOpen={open} onClose={onClose} title="Aperçu du collage" size="lg">
      <div className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 text-red-600 bg-red-50 px-3 py-2 rounded-lg text-sm">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        <p className="text-sm text-slate-500">
          {rows.length} ligne{rows.length > 1 ? 's' : ''} détectée{rows.length > 1 ? 's' : ''} — associez les colonnes aux champs.
        </p>

        {/* Column mapping */}
        <div className="grid grid-cols-2 gap-2">
          {headers.map((h, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-600 w-24 truncate flex-shrink-0">{h}</span>
              <span className="text-slate-300 text-xs">→</span>
              <select
                value={mapping[i] || ''}
                onChange={e => setMapping(prev => ({ ...prev, [i]: e.target.value || undefined }))}
                className="input text-xs flex-1 py-1"
              >
                <option value="">— ignorer —</option>
                {fields.map(f => (
                  <option key={f.id} value={f.key}>{f.name}</option>
                ))}
              </select>
            </div>
          ))}
        </div>

        {/* Preview */}
        <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-40">
          <table className="text-xs w-full">
            <thead className="bg-slate-50 sticky top-0">
              <tr>
                {headers.map((h, i) => (
                  <th key={i} className="px-3 py-1.5 text-left font-medium text-slate-600 border-r border-slate-200 last:border-0">
                    {mapping[i] ? fields.find(f => f.key === mapping[i])?.name : <span className="text-slate-300 italic">ignoré</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.slice(0, 5).map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} className={`px-3 py-1 border-r border-slate-100 last:border-0 truncate max-w-[150px] ${!mapping[ci] ? 'text-slate-300' : ''}`}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 5 && (
            <p className="text-xs text-slate-400 text-center py-1">… et {rows.length - 5} autres lignes</p>
          )}
        </div>

        <div className="flex justify-end gap-3 pt-1">
          <button onClick={onClose} className="btn-secondary">Annuler</button>
          <button
            onClick={handleImport}
            disabled={importing || mappedCount === 0}
            className="btn-primary flex items-center gap-2"
          >
            <Upload size={14} />
            {importing ? 'Importation…' : `Importer ${rows.length} ligne${rows.length > 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </Modal>
  )
}
