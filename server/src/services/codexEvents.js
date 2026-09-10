// Adapt Codex JSONL to the runner's shared transcript format.
export function codexEvents(evt, sessionId = null) {
  const base = { session_id: evt.thread_id || sessionId }
  if (evt.type === 'thread.started') return [{ ...base, type: 'system' }]
  const item = evt.item
  if (evt.type === 'item.completed' && item?.type === 'agent_message') {
    return [{ ...base, type: 'assistant', message: { content: [{ type: 'text', text: item.text }] } }]
  }
  if (evt.type === 'item.started' && item?.type === 'command_execution') {
    return [{ ...base, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: item.command } }] } }]
  }
  if (evt.type === 'item.completed' && item?.type === 'file_change') {
    return [{ ...base, type: 'assistant', message: { content: (item.changes || []).map(change => ({
      type: 'tool_use', name: 'Edit', input: { file_path: change.path },
    })) } }]
  }
  if (evt.type === 'item.completed' && item?.type === 'command_execution') {
    return [{ ...base, type: 'user', message: { content: [{ type: 'tool_result', content: item.aggregated_output || '' }] } }]
  }
  if (evt.type === 'turn.failed' || evt.type === 'error') {
    return [{ ...base, type: 'result', is_error: true, result: evt.error?.message || evt.message || 'Échec de Codex' }]
  }
  return []
}
