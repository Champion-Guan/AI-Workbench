import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  configFile: false,
  plugins: [react()],
  base: '/playground-settings/',
  define: {
    __APP_VERSION__: JSON.stringify('0.7.12'),
    __DEV_PROXY_CONFIG__: 'null',
    'import.meta.env.VITE_LOCAL_IMAGE_RELAY': JSON.stringify('true'),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/index.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
