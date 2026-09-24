import { useEffect, useState } from 'react'

export function usePrivateFile(url) {
  const [loaded, setLoaded] = useState(null)
  let target = null
  try {
    const parsed = new URL(url, window.location.origin)
    if (parsed.origin === window.location.origin && /^\/(erp\/)?api\//.test(parsed.pathname)) target = parsed
  } catch { /* absent/external URL */ }
  const privateUrl = target?.href
  useEffect(() => {
    if (!privateUrl) return
    const controller = new AbortController()
    let objectUrl
    const parsed = new URL(privateUrl)
    parsed.searchParams.delete('token')
    fetch(parsed.href, { headers: { Authorization: `Bearer ${localStorage.getItem('erp_token') || ''}` }, signal: controller.signal })
      .then(res => { if (!res.ok) throw new Error('File unavailable'); return res.blob() })
      .then(blob => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setLoaded({ source: privateUrl, url: objectUrl })
      }).catch(() => {})
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [privateUrl])
  return privateUrl ? (loaded?.source === privateUrl ? loaded.url : null) : url
}
