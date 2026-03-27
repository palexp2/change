import { useState } from 'react'
import { X, Upload } from 'lucide-react'
import { useToast } from '../ui/ToastProvider.jsx'

// ── Step 1 — Upload ───────────────────────────────────────────────────────────

function Step1Upload({ onFileReady }) {
  const [dragOver, setDragOver] = useState(false)

  function handleFile(file) {
    if (!file) return
    const ext = file.name.split('.').pop().toLowerCase()
    if (!['csv', 'xlsx', 'json'].includes(ext)) {
      alert('Format non supporté. Utilisez .csv, .xlsx ou .json')
      return
    }

    if (ext === 'xlsx') {
      onFileReady({ file, ext, columns: [], preview: [] })
      return
    }

    const reader = new FileReader()
    reader.onload = (e) => {
      let columns = [], preview = []
      try {
        if (ext === 'csv') {
          const lines = e.target.result.split('\n').filter(l => l.trim())
          columns = lines[0].split(',').map(c => c.trim().replace(/^"|"$/g, ''))
          preview = lines.slice(1, 6).map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')))
        } else if (ext === 'json') {
          const data = JSON.parse(e.target.result)
          const arr = Array.isArray(data) ? data : [data]
          columns = Object.keys(arr[0] || {})
          preview = arr.slice(0, 5).map(row => columns.map(c => row[c]))
        }
      } catch { columns = []; preview = [] }
      onFileReady({ file, ext, columns, preview })
    }
    reader.readAsText(file)
  }

  return (
    <div className="p-6">
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]) }}
        className={`border-2 border-dashed rounded-xl p-12 text-center transition-colors ${
          dragOver ? 'border-indigo-400 bg-indigo-50' : 'border-gray-300 hover:border-gray-400'
        }`}>
        <Upload size={32} className="mx-auto text-gray-400 mb-3" />
        <p className="text-sm text-gray-600 mb-1">Glissez un fichier ici ou cliquez pour parcourir</p>
        <p className="text-xs text-gray-400 mb-3">CSV, Excel (.xlsx) ou JSON • Max 5 000 lignes</p>
        <input type="file" accept=".csv,.xlsx,.json"
          onChange={e => handleFile(e.target.files[0])}
          className="hidden" id="import-file-input" />
        <label htmlFor="import-file-input"
          className="inline-block px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg cursor-pointer hover:bg-indigo-700">
          Parcourir
        </label>
      </div>
    </div>
  )
}

// ── Step 2 — Mapping ──────────────────────────────────────────────────────────

const READONLY_TYPES = new Set(['autonumber', 'formula', 'rollup', 'lookup', 'created_at', 'updated_at'])

function Step2Mapping({ columns, preview, fields, onConfirm }) {
  const editableFields = fields.filter(f => !READONLY_TYPES.has(f.type))

  const [mapping, setMapping] = useState(() => {
    const auto = {}
    columns.forEach(col => {
      const match = editableFields.find(f =>
        f.name.toLowerCase() === col.toLowerCase() ||
        f.key === col.toLowerCase().replace(/[^a-z0-9]+/g, '_')
      )
      auto[col] = match ? match.key : '__ignore__'
    })
    return auto
  })
  const [mode, setMode] = useState('append')

  if (columns.length === 0) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm text-gray-500 mb-4">
          Fichier Excel détecté. Les colonnes seront détectées automatiquement à l'import.
        </p>
        <div className="flex items-center gap-4 mb-4 justify-center">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="radio" name="mode" value="append" checked={mode === 'append'} onChange={() => setMode('append')} />
            Ajouter aux existants
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="radio" name="mode" value="replace" checked={mode === 'replace'} onChange={() => setMode('replace')} />
            Remplacer tout
          </label>
        </div>
        <button onClick={() => onConfirm({}, mode)}
          className="w-full px-4 py-2.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
          Continuer
        </button>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="border rounded-lg overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-2 font-medium text-gray-600">Colonne source</th>
              <th className="px-4 py-2 text-gray-400 text-center">→</th>
              <th className="text-left px-4 py-2 font-medium text-gray-600">Champ cible</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {columns.map(col => (
              <tr key={col}>
                <td className="px-4 py-2 font-mono text-xs text-gray-600">{col}</td>
                <td className="px-4 py-2 text-gray-400 text-center">→</td>
                <td className="px-4 py-2">
                  <select value={mapping[col]}
                    onChange={e => setMapping(prev => ({ ...prev, [col]: e.target.value }))}
                    className="w-full border rounded px-2 py-1 text-sm">
                    <option value="__ignore__">— Ignorer —</option>
                    {editableFields.map(f => <option key={f.key} value={f.key}>{f.name}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview.length > 0 && (
        <div className="mb-4">
          <p className="text-xs font-medium text-gray-500 mb-2">Aperçu (5 premières lignes)</p>
          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>{columns.map(c => <th key={c} className="px-3 py-1.5 text-left font-medium text-gray-500 whitespace-nowrap">{c}</th>)}</tr>
              </thead>
              <tbody className="divide-y">
                {preview.map((row, i) => (
                  <tr key={i}>
                    {row.map((val, j) => <td key={j} className="px-3 py-1.5 text-gray-600 whitespace-nowrap max-w-[150px] truncate">{val ?? ''}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex items-center gap-4 mb-4">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="radio" name="mode" value="append" checked={mode === 'append'} onChange={() => setMode('append')} />
          Ajouter aux existants
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="radio" name="mode" value="replace" checked={mode === 'replace'} onChange={() => setMode('replace')} />
          Remplacer tout
        </label>
      </div>

      {mode === 'replace' && (
        <div className="p-3 bg-orange-50 border border-orange-200 rounded-lg text-sm text-orange-700 mb-4">
          ⚠ Tous les enregistrements existants seront archivés.
        </div>
      )}

      <button onClick={() => onConfirm(mapping, mode)}
        className="w-full px-4 py-2.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
        Continuer
      </button>
    </div>
  )
}

// ── Step 3 — Import ───────────────────────────────────────────────────────────

function Step3Import({ tableId, file, mapping, mode, onDone }) {
  const { addToast } = useToast()
  const [status, setStatus] = useState('ready')
  const [result, setResult] = useState(null)

  const mappedCount = Object.values(mapping).filter(v => v !== '__ignore__').length

  async function handleImport() {
    setStatus('importing')
    const formData = new FormData()
    formData.append('file', file)
    const cleanMapping = {}
    for (const [col, field] of Object.entries(mapping)) {
      if (field !== '__ignore__') cleanMapping[col] = field
    }
    formData.append('mapping', JSON.stringify(cleanMapping))
    formData.append('mode', mode)

    try {
      const token = localStorage.getItem('erp_token')
      const res = await fetch(`/erp/api/base/tables/${tableId}/import`, {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        body: formData,
      })
      const data = await res.json()
      if (res.ok) {
        setResult(data)
        setStatus('done')
        addToast({ message: `${data.imported} enregistrement(s) importé(s)`, type: 'success' })
      } else {
        setResult({ error: data.error || 'Erreur inconnue' })
        setStatus('error')
      }
    } catch (e) {
      setResult({ error: e.message })
      setStatus('error')
    }
  }

  if (status === 'ready') return (
    <div className="p-6">
      <div className="text-center py-4 mb-4">
        <p className="text-sm text-gray-600 mb-1"><strong>{mappedCount}</strong> colonnes mappées</p>
        <p className="text-xs text-gray-400">Mode : {mode === 'append' ? 'Ajout aux existants' : 'Remplacement'}</p>
      </div>
      <button onClick={handleImport}
        className="w-full px-4 py-2.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
        Importer
      </button>
    </div>
  )

  if (status === 'importing') return (
    <div className="p-6 text-center py-8">
      <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
      <p className="text-sm text-gray-600">Import en cours...</p>
    </div>
  )

  if (status === 'done') return (
    <div className="p-6 space-y-3">
      <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
        ✓ {result.imported} enregistrement(s) importé(s)
      </div>
      {result.errors?.length > 0 && (
        <div className="p-4 bg-orange-50 border border-orange-200 rounded-lg">
          <p className="text-sm font-medium text-orange-700 mb-2">{result.errors.length} erreur(s) :</p>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {result.errors.map((err, i) => (
              <p key={i} className="text-xs text-orange-600">Ligne {err.row} : {err.message}</p>
            ))}
          </div>
        </div>
      )}
      <button onClick={onDone} className="w-full px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">
        Fermer
      </button>
    </div>
  )

  return (
    <div className="p-6 space-y-3">
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">Erreur : {result?.error}</div>
      <button onClick={() => setStatus('ready')} className="w-full px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">
        Réessayer
      </button>
    </div>
  )
}

// ── ImportModal (export) ──────────────────────────────────────────────────────

export function ImportModal({ tableId, fields, onClose, onImported }) {
  const [step, setStep] = useState(1)
  const [fileData, setFileData] = useState(null)
  const [mapping, setMapping] = useState(null)
  const [mode, setMode] = useState('append')

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4"
      onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-[560px] max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="font-semibold">
            Importer des données{step > 1 ? ` — Étape ${step}/3` : ''}
          </h3>
          <button onClick={onClose}><X size={18} className="text-gray-400 hover:text-gray-600" /></button>
        </div>

        {step === 1 && (
          <Step1Upload onFileReady={data => { setFileData(data); setStep(2) }} />
        )}
        {step === 2 && fileData && (
          <Step2Mapping
            columns={fileData.columns}
            preview={fileData.preview}
            fields={fields}
            onConfirm={(m, md) => { setMapping(m); setMode(md); setStep(3) }}
          />
        )}
        {step === 3 && (
          <Step3Import
            tableId={tableId}
            file={fileData.file}
            mapping={mapping}
            mode={mode}
            onDone={() => { onImported?.(); onClose() }}
          />
        )}
      </div>
    </div>
  )
}
