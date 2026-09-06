import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/erp/',
  // Les noms de composants survivent à la minification : le FAB « Modifier le
  // système » les lit sur le fiber React pour proposer la portée d'une demande.
  esbuild: { keepNames: true },
  build: {
    chunkSizeWarningLimit: 10000,
  },
  server: {
    proxy: {
      '/erp/api': {
        target: 'http://localhost:3004',
        rewrite: (p) => p.replace('/erp', '')
      }
    }
  }
})
