/**
 * Runtime-adjustable log level control.
 *
 * Patches the global `console` once on import so every module benefits from
 * level filtering without needing its own logger import. The level can be
 * changed at any time via `setLogLevel()` — including from the UI mid-run.
 */

const LEVELS = { error: 0, warning: 1, info: 2, debug: 3 };
let threshold = LEVELS.info;

// Capture originals before we overwrite them.
const _log  = console.log.bind(console);
const _warn = console.warn.bind(console);
const _err  = console.error.bind(console);
const ts    = () => new Date().toISOString();

console.log   = (...a) => { if (threshold >= LEVELS.info)    _log(`[${ts()}]`,         ...a); };
console.debug = (...a) => { if (threshold >= LEVELS.debug)   _log(`[${ts()}] [debug]`, ...a); };
console.warn  = (...a) => { if (threshold >= LEVELS.warning) _warn(`[${ts()}] [warn]`, ...a); };
console.error = (...a) =>                                     _err(`[${ts()}]`,         ...a);

export function setLogLevel(level) {
    const lvl = (level || '').toLowerCase();
    if (!(lvl in LEVELS)) throw new Error(`Unknown log level "${level}". Valid: ${Object.keys(LEVELS).join(', ')}`);
    const prev = getLogLevel();
    threshold = LEVELS[lvl];
    if (lvl !== prev) _log(`[${ts()}] Log level: ${prev} → ${lvl}`);
}

export function getLogLevel() {
    return Object.entries(LEVELS).find(([, v]) => v === threshold)?.[0] ?? 'info';
}
