import { useCallback, useMemo, useState } from 'react'
import { PackageCheck, AlertTriangle, XCircle } from 'lucide-react'
import api from '../lib/api.js'
import { localISODate } from '../lib/formatDate.js'
import { useCustomFields } from '../lib/useCustomFields.js'
import { parseSelectChoices } from '../lib/customFieldDisplay.jsx'
import { useBarcodeScanner } from '../lib/useBarcodeScanner.js'
import ManualScanInput from './ManualScanInput.jsx'

// Réceptionniste par défaut : Martin reçoit les retours à l'atelier.
const DEFAULT_PERSON = 'Martin'
// Filet si le champ « Réceptionné par » n'a pas (encore) ses choix Airtable.
const FALLBACK_PEOPLE = ['Martin', 'PA', 'Marc-Antoine', 'Frédéric', 'Alicia', 'Charles']

const TONE = {
  received: { icon: PackageCheck, cls: 'bg-emerald-50 border-emerald-200 text-emerald-900' },
  already_received: { icon: AlertTriangle, cls: 'bg-amber-50 border-amber-200 text-amber-900' },
  not_in_return: { icon: XCircle, cls: 'bg-red-50 border-red-200 text-red-900' },
}

// Section « Réception » de la fiche retour : le réceptionniste, la date, et le
// pistolet. Un scan pose la date et la personne sur l'article du retour, puis
// affiche l'instruction d'étagère (règle reprise d'Airtable, calculée par le
// serveur — services/returnReception.js).
export default function RetourReceptionSection({ retour, onItemReceived }) {
  const { fields } = useCustomFields('return_items')
  const people = useMemo(() => {
    const choices = parseSelectChoices(fields.find(f => f.column_name === 'received_by'))
    const labels = choices.map(c => c.label).filter(Boolean)
    return labels.length ? labels : FALLBACK_PEOPLE
  }, [fields])

  const [person, setPerson] = useState(DEFAULT_PERSON)
  const [date, setDate] = useState(() => localISODate())
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)

  const scan = useCallback(async (code) => {
    setBusy(true)
    try {
      const r = await api.retours.receiveScan(retour.id, { code, received_by: person, received_at: date })
      setResult(r)
      if (r.action === 'received' && r.item) onItemReceived?.(r.item)
    } catch (e) {
      setResult({ action: 'not_in_return', message: e.message })
    } finally {
      setBusy(false)
    }
  }, [retour.id, person, date, onItemReceived])

  useBarcodeScanner(scan)

  const tone = TONE[result?.action] || TONE.not_in_return
  const Icon = tone.icon
  const selected = people.includes(person) ? person : ''

  return (
    <div className="card p-5 mb-4" data-testid="retour-reception">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="font-semibold text-slate-900 mr-2">Réception</h2>
        <select
          value={selected}
          aria-label="Réceptionné par"
          // Le pistolet ignore les frappes faites dans un champ : on rend la
          // main dès le choix fait, sinon le scan suivant tombe dans le select.
          onChange={e => { setPerson(e.target.value); e.target.blur() }}
          className="input py-1 text-sm w-40"
          data-testid="reception-person"
        >
          {!selected && <option value=""></option>}
          {people.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
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

      {result && (
        <div
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
      )}
    </div>
  )
}
