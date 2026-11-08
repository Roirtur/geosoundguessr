// Empty on localhost, so Vite can proxy HTTP and WebSocket traffic to the game server.
// A separate static frontend host can set VITE_SERVER_URL at build time.
export const serverBase = (import.meta.env.VITE_SERVER_URL || '').replace(/\/$/, '');
