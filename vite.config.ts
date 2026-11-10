import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
// GitHub Pages serves this as a PROJECT site at
// https://abdulrehmansqae.github.io/dymo-label-xml-viewer/ so production
// builds need base '/dymo-label-xml-viewer/'. Vercel serves the same repo
// from the domain ROOT (dymo-label-xml-viewer.vercel.app), so on Vercel the
// base must be '/' — otherwise the built index.html points its JS/CSS at
// /dymo-label-xml-viewer/assets/... which 404s there and the page is blank.
// Vercel sets the VERCEL env var during builds, which is how we tell the two
// hosts apart. Local dev/preview stay at '/'.
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? (process.env.VERCEL ? '/' : '/dymo-label-xml-viewer/') : '/',
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
}));
