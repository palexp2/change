export default function ErrorBanner({ children, className = '' }) {
  if (!children) return null
  return (
    <div role="alert" className={`rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 whitespace-pre-wrap break-words ${className}`}>
      {children}
    </div>
  )
}
