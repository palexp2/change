import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/erp/',
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
