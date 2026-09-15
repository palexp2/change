import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), {
    name: 'survey-link-preview',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const index = bundle['index.html']
      if (!index || index.type !== 'asset') throw new Error('Missing index.html for survey preview')
      this.emitFile({
        type: 'asset',
        fileName: 'survey.html',
        source: String(index.source).replace(/<title>.*?<\/title>/s, `<title>Orisha</title>
    <meta property="og:title" content="Orisha" />
    <meta property="og:site_name" content="Orisha" />
    <meta property="og:type" content="website" />
    <meta name="twitter:title" content="Orisha" />`),
      })
    },
  }],
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
