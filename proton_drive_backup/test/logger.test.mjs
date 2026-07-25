/**
 * Log-level tests, including the CONTRACT between `config.yaml`'s advertised
 * `log_level` dropdown and what `logger.setLogLevel` actually accepts.
 *
 * Regression (0.4.1): config.yaml offered HA's seven values
 * (trace|debug|info|notice|warning|error|fatal) while the logger only knew four
 * and THREW on anything else — and `main()` calls setLogLevel at boot, so picking
 * `notice` in the HA UI crash-looped the add-on. setLogLevel must therefore never
 * throw; only the API path (`setLogLevelStrict`) validates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG_YAML = join(here, '..', 'config.yaml');

const logger = await import('../src/logger.mjs');

/** The values HA's Configuration tab will offer, read straight from the manifest. */
function advertisedLogLevels() {
    const yaml = readFileSync(CONFIG_YAML, 'utf8');
    const m = yaml.match(/^\s*log_level:\s*list\(([^)]*)\)\s*$/m);
    assert.ok(m, 'config.yaml must declare `log_level: list(...)` in its schema');
    return m[1].split('|').map((s) => s.trim()).filter(Boolean);
}

test('CONTRACT: every log_level advertised in config.yaml is accepted without throwing', () => {
    const advertised = advertisedLogLevels();
    assert.ok(advertised.length >= 4, `expected several advertised levels, got ${advertised}`);
    for (const level of advertised) {
        assert.doesNotThrow(() => logger.setLogLevel(level), `setLogLevel("${level}") must not throw`);
        // …and it must land on one of the levels we actually implement.
        assert.ok(
            logger.logLevels().includes(logger.getLogLevel()),
            `setLogLevel("${level}") left an unknown effective level ${logger.getLogLevel()}`,
        );
    }
    // The default from config.yaml's `options:` must also be accepted.
    const dflt = readFileSync(CONFIG_YAML, 'utf8').match(/^\s{2}log_level:\s*(\S+)\s*$/m)?.[1];
    assert.ok(dflt, 'config.yaml must set a default log_level in options:');
    assert.doesNotThrow(() => logger.setLogLevel(dflt));
});

test('HA-only levels map onto the internal four', () => {
    assert.equal(logger.normalizeLogLevel('trace'), 'debug');
    assert.equal(logger.normalizeLogLevel('notice'), 'info');
    assert.equal(logger.normalizeLogLevel('fatal'), 'error');
    assert.equal(logger.normalizeLogLevel('DEBUG'), 'debug'); // case-insensitive
    assert.equal(logger.normalizeLogLevel(' warning '), 'warning');
    assert.equal(logger.normalizeLogLevel('nonsense'), null);
    assert.equal(logger.normalizeLogLevel(undefined), null);
});

test('setLogLevel never throws: an unknown value falls back to info', () => {
    logger.setLogLevel('debug');
    assert.equal(logger.getLogLevel(), 'debug');
    assert.doesNotThrow(() => logger.setLogLevel('totally-bogus'));
    assert.equal(logger.getLogLevel(), 'info');
    assert.doesNotThrow(() => logger.setLogLevel(undefined));
    assert.equal(logger.getLogLevel(), 'info');
});

test('setLogLevelStrict throws on garbage (so POST /api/log-level can answer 400)', () => {
    assert.throws(() => logger.setLogLevelStrict('totally-bogus'), /Unknown log level/);
    assert.throws(() => logger.setLogLevelStrict(''), /Unknown log level/);
    // Aliases are still valid input for the API.
    assert.equal(logger.setLogLevelStrict('fatal'), 'error');
    assert.equal(logger.getLogLevel(), 'error');
    logger.setLogLevel('info'); // leave a sane level behind
});

test('logLevels() lists exactly the four internal levels the UI offers', () => {
    assert.deepEqual(logger.logLevels(), ['error', 'warning', 'info', 'debug']);
});
