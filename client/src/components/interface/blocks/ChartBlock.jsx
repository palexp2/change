import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useBlockData } from '../../../hooks/useBlockData.js'

const COLOR_MAP = {
  indigo: '#6366f1', green: '#22c55e', red: '#ef4444',
  orange: '#f97316', purple: '#a855f7', cyan: '#06b6d4',
}

export default function ChartBlock({ block, config, filterValues }) {
  const { data, loading } = useBlockData(block.id, filterValues)

  if (loading) {
    return <div className="flex items-center justify-center h-full text-sm text-gray-400">Chargement…</div>
  }

  if (!data?.labels?.length) {
    return <div className="flex items-center justify-center h-full text-sm text-gray-400">Aucune donnée</div>
  }

  const chartData = data.labels.map((label, i) => ({
    name: String(label ?? ''),
    value: data.datasets?.[0]?.data?.[i] ?? 0,
  }))

  const color = COLOR_MAP[config.color] || COLOR_MAP.indigo
  const isLine = config.chart_type === 'line'

  return (
    <div className="h-full flex flex-col">
      {config.label && (
        <h3 className="text-sm font-medium text-gray-700 mb-2 px-1 shrink-0">{config.label}</h3>
      )}
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          {isLine ? (
            <LineChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }} />
              <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={{ r: 3, fill: color }} />
            </LineChart>
          ) : (
            <BarChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }} />
              <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  )
}
