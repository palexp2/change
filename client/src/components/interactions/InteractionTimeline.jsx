import { useState } from 'react'
import { Phone, Mail, MessageSquare, FileText, CalendarDays, Paperclip, Link2, Pencil, Trash2 } from 'lucide-react'
import { DynamicIcon } from '../ui/DynamicIcon.jsx'

export const TYPE_ICONS = { call: Phone, email: Mail, sms: MessageSquare, note: FileText, meeting: CalendarDays }

export const TYPE_STYLES = {
  call:    { outbound: 'text-blue-500', inbound: 'text-green-500', missed: 'text-red-500', default: 'text-blue-500' },
  email:   { outbound: 'text-indigo-500', inbound: 'text-teal-500', default: 'text-indigo-500' },
  sms:     { outbound: 'text-purple-500', inbound: 'text-purple-400', default: 'text-purple-500' },
  note:    { default: 'text-yellow-500' },
  meeting: { default: 'text-orange-500' },
}

export function formatRelativeTime(dateString) {
  if (!dateString) return ''
  const d = new Date(dateString)
  if (isNaN(d)) return dateString
  const diff = (Date.now() - d) / 1000
  if (diff < 60) return "à l'instant"
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)}h`
  if (diff < 604800) return `il y a ${Math.floor(diff / 86400)}j`
  return d.toLocaleString('fr-CA', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatDuration(seconds) {
  if (!seconds) return null
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}min ${s.toString().padStart(2, '0')}s`
}

const DIRECTION_LABELS = { inbound: 'entrant', outbound: 'sortant' }
const STATUS_LABELS = {
  missed: 'Manqué', voicemail: 'Messagerie', scheduled: 'Planifié',
  completed: '', draft: 'Brouillon', failed: 'Échoué',
}

function InteractionCard({ interaction, showLinkedRecords, onDelete }) {
  const [expanded, setExpanded] = useState(false)
  const Icon = TYPE_ICONS[interaction.type] || MessageSquare
  const styles = TYPE_STYLES[interaction.type] || {}
  const iconColor = interaction.status === 'missed' || interaction.status === 'failed'
    ? (styles.missed || styles.default || 'text-red-500')
    : (styles[interaction.direction] || styles.default || 'text-gray-400')

  const borderColor = iconColor.replace('text-', 'border-')

  return (
    <div className="relative pl-8 pb-4 group">
      {/* Timeline dot */}
      <div className={`absolute left-1.5 w-3 h-3 rounded-full bg-white border-2 ${borderColor}`} />

      <div className="bg-white border rounded-lg p-3 hover:shadow-sm transition-shadow relative">
        {/* Header */}
        <div className="flex items-start justify-between mb-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Icon size={14} className={iconColor} />
            <span className="text-sm font-medium text-gray-700">
              {interaction.type === 'call' && `Appel ${DIRECTION_LABELS[interaction.direction] || ''}`}
              {interaction.type === 'email' && (interaction.subject || 'Sans sujet')}
              {interaction.type === 'sms' && `SMS ${DIRECTION_LABELS[interaction.direction] || ''}`}
              {interaction.type === 'note' && (interaction.subject || 'Note')}
              {interaction.type === 'meeting' && (interaction.subject || 'Réunion')}
            </span>
            {['missed','voicemail','scheduled','failed'].includes(interaction.status) && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                interaction.status === 'missed' || interaction.status === 'failed' ? 'bg-red-100 text-red-600' :
                interaction.status === 'scheduled' ? 'bg-blue-100 text-blue-600' :
                'bg-gray-100 text-gray-500'
              }`}>
                {STATUS_LABELS[interaction.status]}
              </span>
            )}
          </div>
          <span className="text-xs text-gray-400 shrink-0 ml-2">
            {formatRelativeTime(interaction.completed_at || interaction.created_at)}
          </span>
        </div>

        {/* Meta */}
        <div className="text-xs text-gray-500 space-y-0.5">
          {interaction.type === 'call' && interaction.duration_seconds && (
            <p>Durée : {formatDuration(interaction.duration_seconds)}</p>
          )}
          {interaction.type === 'call' && interaction.phone_number && (
            <p>{interaction.phone_number}</p>
          )}
          {interaction.type === 'email' && (
            <p>
              {interaction.direction === 'outbound' ? 'À' : 'De'} :{' '}
              {interaction.direction === 'outbound'
                ? (() => { try { return JSON.parse(interaction.to_addresses || '[]').slice(0,2).join(', ') } catch { return '' } })()
                : interaction.from_address
              }
            </p>
          )}
          {interaction.type === 'sms' && interaction.phone_number && (
            <p>{interaction.phone_number}</p>
          )}
          {interaction.type === 'meeting' && interaction.scheduled_at && (
            <p>
              {new Date(interaction.scheduled_at).toLocaleString('fr-CA')}
              {interaction.duration_seconds && ` • ${formatDuration(interaction.duration_seconds)}`}
            </p>
          )}
        </div>

        {/* Body */}
        {interaction.body && (
          <div className="mt-1.5">
            <p className={`text-xs text-gray-600 ${expanded ? '' : 'line-clamp-2'}`}>
              {interaction.body}
            </p>
            {interaction.body.length > 150 && (
              <button onClick={() => setExpanded(!expanded)}
                className="text-[10px] text-indigo-600 hover:text-indigo-700 mt-0.5">
                {expanded ? 'Réduire' : 'Voir plus'}
              </button>
            )}
          </div>
        )}

        {/* Attachments */}
        {interaction.attachments?.length > 0 && (
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <Paperclip size={10} className="text-gray-400" />
            {interaction.attachments.map(att => (
              <a key={att.id} href={att.url} target="_blank" rel="noopener noreferrer"
                className="text-[10px] text-indigo-600 hover:underline">
                {att.name}{att.size ? ` (${(att.size / 1024 / 1024).toFixed(1)} Mo)` : ''}
              </a>
            ))}
          </div>
        )}

        {/* Linked records */}
        {showLinkedRecords && interaction.links?.length > 0 && (
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            <Link2 size={10} className="text-gray-400" />
            {interaction.links.map(link => (
              <a key={link.id} href={`/tables/${link.table_slug || ''}/${link.record_id}`}
                className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 flex items-center gap-1">
                <DynamicIcon name={link.table_icon || 'Table'} size={10} />
                {link.primary_value || link.record_id}
              </a>
            ))}
          </div>
        )}

        {/* Source badge */}
        {interaction.source && interaction.source !== 'manual' && (
          <div className="mt-2">
            <span className="text-[9px] px-1.5 py-0.5 bg-gray-100 text-gray-400 rounded uppercase tracking-wider">
              {interaction.source}
            </span>
          </div>
        )}

        {/* User */}
        {interaction.user_name && (
          <p className="text-[10px] text-gray-400 mt-1">Par : {interaction.user_name}</p>
        )}

        {/* Hover actions */}
        {onDelete && (
          <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 flex gap-1">
            <button onClick={() => onDelete(interaction.id)}
              className="p-1 text-gray-400 hover:text-red-500 bg-white rounded border border-gray-200">
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function InteractionTimeline({ interactions, showLinkedRecords = true, onDelete }) {
  if (!interactions || interactions.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-4">Aucune interaction</p>
  }

  return (
    <div className="relative">
      {/* Vertical line */}
      <div className="absolute left-3 top-0 bottom-0 w-px bg-gray-200" />
      {interactions.map(itr => (
        <InteractionCard
          key={itr.id}
          interaction={itr}
          showLinkedRecords={showLinkedRecords}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}
