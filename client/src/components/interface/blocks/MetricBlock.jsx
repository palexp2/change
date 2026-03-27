import { useBlockData } from '../../../hooks/useBlockData.js'

function formatValue(value, format) {
  if (value == null) return '—'
  const n = Number(value)
  if (isNaN(n)) return String(value)
  switch (format) {
    case 'currency':
      return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
    case 'currency_usd':
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
    case 'percent':
      return `${n.toFixed(1)}%`
    case 'integer':
      return Math.round(n).toLocaleString('fr-CA')
    default:
      return n.toLocaleString('fr-CA', { maximumFractionDigits: 2 })
  }
}

export default function MetricBlock({ block, config, filterValues }) {
  const { data, loading } = useBlockData(block.id, filterValues)

  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      {loading ? (
        <div className="w-20 h-8 bg-gray-100 rounded animate-pulse" />
      ) : (
        <span className="text-3xl font-bold text-gray-800">
          {formatValue(data?.value, config.format)}
        </span>
      )}
      <span className="text-sm text-gray-500 mt-1">{config.label || 'Métrique'}</span>
    </div>
  )
}
