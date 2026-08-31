// Helpers partagés entre NovoxpressLabelModal (envois sortants) et
// RetourActionsDrawer (étiquettes de retour) — extraits pour éviter la
// duplication du choix de boîte / affichage de tarif entre les deux flux.

export const BOX_PRESETS = {
  enveloppe: { label: 'Enveloppe (documents légers)', length: '13', width: '10', depth: '1', packagingType: 'envelope' },
  grande:    { label: 'Grande (20 × 20 × 16 po)',  length: '20', width: '20', depth: '16' },
  moyenne:   { label: 'Moyenne (20 × 16 × 8 po)',  length: '20', width: '16', depth: '8'  },
  petite:    { label: 'Petite (15 × 15 × 7 po)',   length: '15', width: '15', depth: '7'  },
  sunshield: { label: 'Sunshield (8 × 6 × 5 po)',  length: '8',  width: '6',  depth: '5'  },
  custom:    { label: 'Personnalisée…',             length: '',   width: '',   depth: ''   },
}

export function fmtPrice(rate) {
  const val = rate.total?.value ?? rate.total_charge ?? rate.total ?? null
  if (val == null) return '—'
  const currency = rate.total?.currency || 'CAD'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(parseFloat(val))
}

export function getRateName(rate) {
  return rate.service_name || rate.name || rate.service_id || 'Service inconnu'
}

export function getRateCarrier(rate) {
  return rate.carrier_name || rate.carrier || ''
}

export function getRateDelivery(rate) {
  const d = rate.expected_delivery_date
  if (d) {
    return new Date(d.year, d.month - 1, d.day).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' })
  }
  if (rate.total_transit_day != null) return `${rate.total_transit_day} jour(s)`
  return null
}

export function DebugDetails({ details }) {
  if (!details) return null
  const { sent, response, responseBody, novoxpressStatus } = details
  const sections = []
  if (sent) sections.push(['Payload envoyé à Novoxpress', sent])
  if (responseBody) sections.push([`Réponse brute Novoxpress${novoxpressStatus ? ` (HTTP ${novoxpressStatus})` : ''}`, responseBody])
  if (response && Object.keys(response).length > 0) sections.push(['Réponse Novoxpress (parsée, hors ratelist)', response])
  if (!sections.length) return null
  return (
    <details className="bg-slate-50 border border-slate-200 rounded-xl text-xs">
      <summary className="cursor-pointer px-3 py-2 font-medium text-slate-700 select-none">
        🔍 Détails techniques (cliquer pour voir)
      </summary>
      <div className="px-3 pb-3 space-y-3">
        {sections.map(([title, content]) => {
          const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
          return (
            <div key={title}>
              <div className="flex items-center justify-between mb-1">
                <span className="font-semibold text-slate-600">{title}</span>
                <button
                  onClick={() => navigator.clipboard.writeText(text).catch(() => {})}
                  className="text-[10px] text-slate-500 hover:text-brand-600 underline"
                  type="button"
                >
                  copier
                </button>
              </div>
              <pre className="bg-white border border-slate-200 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all text-[11px] leading-snug text-slate-800 max-h-60 overflow-y-auto">
                {text}
              </pre>
            </div>
          )
        })}
      </div>
    </details>
  )
}
