import { defineConfig } from 'vite';

const isKiosk = process.env.VITE_KIOSK === 'true';

export default defineConfig({
    base: isKiosk ? '/garage-splat-viewer/' : '/',
    define: {
        __KIOSK__: isKiosk,
    },
});
