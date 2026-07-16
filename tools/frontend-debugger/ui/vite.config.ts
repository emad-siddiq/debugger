import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: here,
  base: '/',
  plugins: [react()],
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
  },
})
