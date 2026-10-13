import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { googleTokenDevPlugin } from './scripts/google-token-dev-plugin.js'

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [tanstackRouter(), react(), tailwindcss(), googleTokenDevPlugin()],
})