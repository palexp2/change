import * as Icons from 'lucide-react'

const FALLBACK = Icons.Table2

export function DynamicIcon({ name, size = 16, className }) {
  const Icon = (name && Icons[name]) ? Icons[name] : FALLBACK
  return <Icon size={size} className={className} />
}
