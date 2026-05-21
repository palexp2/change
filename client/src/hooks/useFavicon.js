import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { iconForPath } from '../lib/pageIcons.js'

const FAVICON_COLOR = '#21B14B' // tailwind brand-600
const FAVICON_SIZE = 64

function svgToDataUrl(svg) {
  // encodeURIComponent handles non-ASCII; data: URL avoids base64 cost
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

function setFavicon(href) {
  let link = document.querySelector("link[rel~='icon']")
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.type = 'image/svg+xml'
  link.href = href
}

export function useFavicon() {
  const { pathname } = useLocation()
  useEffect(() => {
    const Icon = iconForPath(pathname)
    const svg = renderToStaticMarkup(
      createElement(Icon, { size: FAVICON_SIZE, color: FAVICON_COLOR, strokeWidth: 2.25 })
    )
    setFavicon(svgToDataUrl(svg))
  }, [pathname])
}
