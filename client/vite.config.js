import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { resolve, join } from 'node:path'

// Un onglet ouvert continue à importer les noms hachés de son ancien build.
// Capturer avant que Vite vide outDir, puis restaurer sans écraser le nouveau
// build. Les dates originales bornent la rétention, même après plusieurs builds.
export function retainRecentAssets() {
  let outputDir
  let retained = new Map()
  return {
    name: 'retain-recent-assets',
    apply: 'build',
    configResolved(config) {
      outputDir = resolve(config.root, config.build.outDir)
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      for (const directory of [resolve(config.root, 'dist/assets'), resolve(config.root, 'dist.prev/assets')]) {
        if (!existsSync(directory)) continue
        for (const name of readdirSync(directory)) {
          const file = join(directory, name)
          const stat = statSync(file)
          if (!stat.isFile() || stat.mtimeMs < cutoff || retained.has(name)) continue
          retained.set(name, { data: readFileSync(file), mtime: stat.mtime })
        }
      }
    },
    writeBundle() {
      const directory = join(outputDir, 'assets')
      mkdirSync(directory, { recursive: true })
      for (const [name, { data, mtime }] of retained) {
        const file = join(directory, name)
        if (existsSync(file)) continue
        writeFileSync(file, data)
        utimesSync(file, mtime, mtime)
      }
      retained.clear()
    },
  }
}

export default defineConfig({
  plugins: [react(), retainRecentAssets(), {
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
