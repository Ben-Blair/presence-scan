import { defineConfig } from 'vite';

const isKiosk = process.env.VITE_KIOSK === 'true';

// GitHub Pages project sites serve from /<repo-name>/, so the kiosk build's base
// must match the repo name. The deploy workflow passes it in as VITE_BASE (derived
// from the repo name), so a repo rename can't silently break asset URLs again.
const kioskBase = process.env.VITE_BASE || '/';

export default defineConfig({
    base: isKiosk ? kioskBase : '/',
    define: {
        __KIOSK__: isKiosk,
    },
});
