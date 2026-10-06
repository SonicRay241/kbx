import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [tanstackRouter(), react(), tailwindcss()],
})