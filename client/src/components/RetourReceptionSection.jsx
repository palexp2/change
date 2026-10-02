import { useCallback, useEffect, useMemo, useState } from 'react'
import { PackageCheck, AlertTriangle, XCircle } from 'lucide-react'
import api from '../lib/api.js'
import { useBarcodeScanner } from '../lib/useBarcodeScanner.js'
import ManualScanInput from './ManualScanInput.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'

const TONE = {
  received: { icon: PackageCheck, cls: 'bg-emerald-50 border-emerald-200 text-emerald-900' },
  already_received: { icon: AlertTriangle, cls: 'bg-amber-50 border-amber-200 text-amber-900' },
  not_in_return: { icon: XCircle, cls: 'bg-red-50 border-red-200 text-red-900' },
}

// Section « Réception » de la fiche retour : le réceptionniste, la date, et le
// pistolet. Un scan pose la date et la personne sur l'article du retour, puis
// affiche l'instruction d'étagère (règle reprise d'Airtable, calculée par le
// serveur — services/returnReception.js). Personne et date appartiennent à la
// fiche : le bouton « Réceptionner » des articles cochés s'en sert aussi, et
// sa consigne d'étagère s'affiche ici (`results`, une entrée par article).
export default function RetourReceptionSection({ retour, person, setPerson, date, setDate, onItemReceived, results, setResults }) {
  // Réceptionnistes = utilisateurs Boréal actifs ; l'utilisateur connecté est
  // pré-choisi par la fiche (RetourDetail).
  const [users, setUsers] = useState([])
  useEffect(() => { api.auth.users().then(setUsers).catch(() => {}) }, [])
  const people = useMemo(() => {
    const names = users.map(u => u.name).filter(Boolean)
    return person && !names.includes(person) ? [person, ...names] : names
  }, [users, person])

  const [busy, setBusy] = useState(false)

  const scan = useCallback(async (code) => {
    setBusy(true)
    try {
      const r = await api.retours.receiveScan(retour.id, { code, received_by: person, received_at: date })
      setResults([r])
      if (r.action === 'received' && r.item) onItemReceived?.(r.item)
    } catch (e) {
      setResults([{ action: 'not_in_return', message: e.message }])
    } finally {
      setBusy(false)
    }
  }, [retour.id, person, date, onItemReceived, setResults])

  useBarcodeScanner(scan)

  return (
    <div className="card p-5 mb-4" data-testid="retour-reception">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="font-semibold text-slate-900 mr-2">Réception</h2>
        <div className="w-48" aria-label="Réceptionné par">
          <SearchableSelect
            value={person || ''}
            options={people.map(p => ({ value: p, label: p }))}
            onChange={setPerson}
            className="input py-1 text-sm w-full"
            size="sm"
            testId="reception-person"
          />
        </div>
        <input
          type="date"
          value={date}
          aria-label="Date de réception"
          onChange={e => setDate(e.target.value)}
          className="input py-1 text-sm w-40"
          data-testid="reception-date"
        />
        <ManualScanInput onSubmit={scan} className={busy ? 'opacity-50 pointer-events-none' : ''} />
      </div>

      {(results || []).map((result, i) => {
        const tone = TONE[result.action] || TONE.not_in_return
        const Icon = tone.icon
        return (
          <div
            key={result.item?.id || i}
            className={`mt-3 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium ${tone.cls}`}
            data-testid="reception-message"
          >
            <Icon size={16} className="mt-0.5 flex-shrink-0" />
            <div>
              <div>{result.message || `Code ${result.code} : aucun article de ce retour`}</div>
              {result.item && (
                <div className="text-xs font-normal opacity-70">
                  {[result.item.serial_number, result.item.product_name].filter(Boolean).join(' · ')}
                  {result.action === 'already_received' && result.item.received_at
                    ? ` — déjà reçu le ${result.item.received_at}${result.item.received_by ? ` par ${result.item.received_by}` : ''}`
                    : ''}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
