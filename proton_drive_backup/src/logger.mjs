/**
 * Runtime-adjustable log level control.
 *
 * Patches the global `console` once on import so every module benefits from
 * level filtering without needing its own logger import. The level can be
 * changed at any time via `setLogLevel()` — including from the UI mid-run.
 *
 * Internally there are only FOUR levels (error/warning/info/debug), but
 * `config.yaml` advertises Home Assistant's usual seven-value dropdown
 * (trace|debug|info|notice|warning|error|fatal). The extra HA values are
 * ALIASED onto the internal four — and an unknown value falls back to `info`
 * with a warning instead of throwing, because `setLogLevel` runs during boot
 * and a throw there crash-looped the add-on (0.4.1). Only the
 * `POST /api/log-level` endpoint validates strictly (see `setLogLevelStrict`).
 */

const LEVELS = { error: 0, warning: 1, info: 2, debug: 3 };

// Home Assistant's log_level dropdown offers more values than we implement.
// Map the extras onto the closest internal level.
const ALIASES = {
    trace: 'debug',
    notice: 'info',
    fatal: 'error',
    warn: 'warning',
    err: 'error',
    critical: 'error',
};

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

/** The internal levels actually implemented (what the UI dropdown offers). */
export function logLevels() {
    return Object.keys(LEVELS);
}

/**
 * Resolve any advertised log level (internal name or HA alias) to one of the
 * internal four. Returns null when the value isn't recognised at all.
 * @param {string} level
 * @returns {'error'|'warning'|'info'|'debug'|null}
 */
export function normalizeLogLevel(level) {
    const lvl = String(level ?? '').trim().toLowerCase();
    if (lvl in LEVELS) return lvl;
    if (lvl in ALIASES) return ALIASES[lvl];
    return null;
}

function apply(canonical) {
    const prev = getLogLevel();
    threshold = LEVELS[canonical];
    if (canonical !== prev) _log(`[${ts()}] Log level: ${prev} → ${canonical}`);
    return canonical;
}

/**
 * Set the log level. NEVER throws — an unrecognised value logs a warning and
 * falls back to `info`, so a bad/unmapped `log_level` option can't crash boot.
 * @param {string} level
 * @returns {string} the level actually applied.
 */
export function setLogLevel(level) {
    const canonical = normalizeLogLevel(level);
    if (!canonical) {
        _warn(`[${ts()}] [warn] Unknown log level "${level}" — falling back to "info". Valid: ${[...Object.keys(LEVELS), ...Object.keys(ALIASES)].join(', ')}`);
        return apply('info');
    }
    return apply(canonical);
}

/**
 * Strict variant for the API: THROWS on an unrecognised value so
 * `POST /api/log-level` can answer 400 instead of silently doing something else.
 * @param {string} level
 */
export function setLogLevelStrict(level) {
    const canonical = normalizeLogLevel(level);
    if (!canonical) {
        throw new Error(`Unknown log level "${level}". Valid: ${[...Object.keys(LEVELS), ...Object.keys(ALIASES)].join(', ')}`);
    }
    return apply(canonical);
}

export function getLogLevel() {
    return Object.entries(LEVELS).find(([, v]) => v === threshold)?.[0] ?? 'info';
}
