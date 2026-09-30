import { useRef, useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import Spinner from './Spinner.jsx'

// Vignette d'image d'une fiche : clic = choisir un fichier (ajout ou
// remplacement), croix au survol = retirer. L'enregistrement est à la page.
export default function ImageSlot({ src, alt, size, onPick, onRemove, busy, testId = 'image-slot' }) {
  const inputRef = useRef(null)
  const [broken, setBroken] = useState(null)
  const usable = src && broken !== src
  return (
    <div className={`relative flex-shrink-0 group ${size}`} data-testid={testId}>
      <input
        ref={inputRef} type="file" accept="image/*" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPick(f) }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title={usable ? 'Changer l’image' : 'Ajouter une image'}
        aria-label={usable ? 'Changer l’image' : 'Ajouter une image'}
        className={`w-full h-full rounded-lg overflow-hidden flex items-center justify-center ${usable
          ? 'border border-slate-200 hover:border-brand-400'
          : 'border border-dashed border-slate-300 text-slate-300 hover:border-brand-400 hover:text-brand-500'}`}
      >
        {busy
          ? <Spinner size="sm" />
          : usable
            ? <img src={src} alt={alt} onError={() => setBroken(src)} className="w-full h-full object-cover" />
            : <ImagePlus size={18} />}
      </button>
      {usable && !busy && (
        <button
          type="button"
          onClick={onRemove}
          title="Retirer l’image"
          aria-label="Retirer l’image"
          data-testid={`${testId}-remove`}
          className="absolute -top-1.5 -right-1.5 hidden group-hover:flex h-5 w-5 items-center justify-center rounded-full bg-white border border-slate-300 text-slate-500 hover:text-red-600 hover:border-red-300 shadow-sm"
        >
          <X size={11} />
        </button>
      )}
    </div>
  )
}
