import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import USA from '@svg-maps/usa'
import Canada from '@svg-maps/canada'

export function GeoClientsMap({ geoData = [] }) {
  const navigate = useNavigate()
  const containerRef = useRef(null)
  const [tooltip, setTooltip] = useState(null)

  // Build lookup: uppercase province code → count
  const countMap = {}
  for (const row of geoData) {
    countMap[row.province.toUpperCase()] = (countMap[row.province.toUpperCase()] || 0) + row.count
  }
  const maxCount = Math.max(...Object.values(countMap), 1)

  function getColor(code) {
    const count = countMap[code.toUpperCase()] || 0
    if (count === 0) return '#f1f5f9'
    // sqrt scale for better visual distribution, blue palette
    const t = Math.pow(count / maxCount, 0.5)
    const r = Math.round(219 + (29 - 219) * t)
    const g = Math.round(234 + (78 - 234) * t)
    const b = Math.round(254 + (216 - 254) * t)
    return `rgb(${r},${g},${b})`
  }

  function handleMouseMove(e, name, code) {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setTooltip({
      name,
      count: countMap[code.toUpperCase()] || 0,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })
  }

  function handleClick(code) {
    navigate(`/companies?farm_province=${code.toUpperCase()}`)
  }

  const pathProps = (loc) => ({
    key: loc.id,
    d: loc.path,
    fill: getColor(loc.id),
    stroke: 'white',
    strokeWidth: '0.8',
    style: { cursor: countMap[loc.id.toUpperCase()] ? 'pointer' : 'default' },
    onClick: () => handleClick(loc.id),
    onMouseMove: (e) => handleMouseMove(e, loc.name, loc.id),
    onMouseLeave: () => setTooltip(null),
  })

  const total = Object.values(countMap).reduce((a, b) => a + b, 0)

  return (
    <div ref={containerRef} className="relative select-none">
      {tooltip && (
        <div
          className="absolute z-20 bg-slate-800 text-white text-xs px-2 py-1 rounded shadow pointer-events-none whitespace-nowrap"
          style={{ left: tooltip.x + 12, top: tooltip.y - 28 }}
        >
          <span className="font-medium">{tooltip.name}</span>
          {' — '}
          <span>{tooltip.count} client{tooltip.count !== 1 ? 's' : ''}</span>
        </div>
      )}

      <div className="flex items-start gap-1">
        {/* Canada — plus large car QC/ON dominent */}
        <div style={{ flex: '0 0 52%' }}>
          <p className="text-[10px] text-slate-400 text-center mb-0.5 font-medium tracking-wide uppercase">Canada</p>
          <svg viewBox="0 480 793 552" className="w-full">
            {Canada.locations.map(loc => <path {...pathProps(loc)} />)}
          </svg>
        </div>
        {/* USA */}
        <div style={{ flex: '0 0 48%' }}>
          <p className="text-[10px] text-slate-400 text-center mb-0.5 font-medium tracking-wide uppercase">États-Unis</p>
          <svg viewBox={USA.viewBox} className="w-full">
            {USA.locations.map(loc => <path {...pathProps(loc)} />)}
          </svg>
        </div>
      </div>

      {/* Légende */}
      <div className="flex items-center justify-between mt-2 px-1">
        <span className="text-xs text-slate-400">{total} client{total !== 1 ? 's' : ''} total (adresse de ferme)</span>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-400">0</span>
          <div className="w-24 h-2.5 rounded" style={{
            background: 'linear-gradient(to right, #f1f5f9, #dbeafe, #93c5fd, #3b82f6, #1d4ed8)'
          }} />
          <span className="text-xs text-slate-400">{maxCount}</span>
        </div>
      </div>
    </div>
  )
}
