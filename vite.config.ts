import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
// GitHub Pages serves this as a PROJECT site at
// https://abdulrehmansqae.github.io/dymo-label-xml-viewer/ so production
// builds need base '/dymo-label-xml-viewer/'. Local dev/preview stay at '/'.
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/dymo-label-xml-viewer/' : '/',
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
}));
