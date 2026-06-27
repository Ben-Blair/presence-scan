// Ambient declarations for the project's compile-time / debug globals.

// Injected by Vite `define` (vite.config.js); true in the kiosk / Pages build.
declare const __KIOSK__: boolean;

interface Window {
    // Debug handle exposed for console inspection (see main.js / ARCHITECTURE.md).
    __viewer: Record<string, unknown>;
}
