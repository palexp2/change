function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderMinimalMarkdown(text) {
  if (!text) return ''
  return text
    .split('\n')
    .map(line => {
      if (line.startsWith('### ')) return `<h3 class="text-base font-semibold text-gray-800 mb-1">${esc(line.slice(4))}</h3>`
      if (line.startsWith('## '))  return `<h2 class="text-lg font-semibold text-gray-800 mb-2">${esc(line.slice(3))}</h2>`
      if (line.startsWith('# '))   return `<h1 class="text-xl font-bold text-gray-900 mb-2">${esc(line.slice(2))}</h1>`
      if (line.trim() === '')       return '<br/>'
      let html = esc(line)
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
      html = html.replace(/`(.+?)`/g, '<code class="bg-gray-100 px-1 rounded text-xs font-mono">$1</code>')
      html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" class="text-indigo-600 hover:underline" target="_blank" rel="noopener">$1</a>')
      return `<p class="text-sm text-gray-700 mb-1">${html}</p>`
    })
    .join('')
}

export default function TextBlock({ config }) {
  const html = renderMinimalMarkdown(config.content || '')
  const align = config.align === 'center' ? 'text-center' : 'text-left'

  if (!config.content) {
    return <div className="flex items-center justify-center h-full text-sm text-gray-400 italic">Bloc texte</div>
  }

  return (
    <div
      className={`h-full overflow-y-auto p-2 ${align}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
