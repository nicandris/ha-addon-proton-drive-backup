/**
 * The Web UI is a single inline HTML+JS string built inside a template literal in
 * ingress.mjs. `node --check src/ingress.mjs` validates the OUTER file only — it
 * cannot see a syntax error inside the emitted page, and 0.4.3 shipped exactly
 * that: a `\n` written inside the template literal became a REAL newline in the
 * browser's single-quoted string, so the page threw
 * "Uncaught SyntaxError: Invalid or unexpected token" and never rendered
 * (everything stayed on "Loading…").
 *
 * These tests compile the rendered page's script the way a browser would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { renderPage } = await import('../src/ingress.mjs');

const html = renderPage();
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('the page contains exactly one inline script', () => {
    assert.equal(scripts.length, 1);
    assert.ok(scripts[0].length > 500, 'script looks suspiciously short');
});

test('the inline page script parses (catches unterminated strings / bad escapes)', () => {
    // new vm.Script() throws SyntaxError on exactly what the browser would reject.
    assert.doesNotThrow(() => new vm.Script(scripts[0]), SyntaxError);
});

test('the page still wires the expected controls', () => {
    for (const id of ['statusCard', 'statsCard', 'settingsCard', 'syncNow', 'createBackup', 'pruneHA', 'saveSettings', 'backupRows']) {
        assert.ok(html.includes(`id="${id}"`) || scripts[0].includes(`'${id}'`), `missing ${id}`);
    }
    assert.ok(scripts[0].includes('function esc('), 'escaping helper missing');
    assert.ok(scripts[0].includes('scheduleNextPoll'), 'adaptive polling missing');
});

// --- theme palette -----------------------------------------------------------

const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];

test('the page declares Home Assistant\'s palette under HA\'s own variable names', () => {
    // Same names as HA uses, so a future step can override :root with the user's
    // real theme without touching any rule. CSS vars don't cross the ingress
    // iframe, so we must declare them ourselves rather than inherit them.
    for (const v of [
        '--primary-color', '--primary-background-color', '--card-background-color',
        '--secondary-background-color', '--primary-text-color', '--secondary-text-color',
        '--divider-color', '--error-color', '--success-color', '--info-color',
        '--text-primary-color', '--ha-card-border-radius',
    ]) {
        assert.ok(new RegExp(`${v}:\\s*[^;]+;`).test(css), `missing ${v} declaration`);
    }
    assert.match(css, /@media \(prefers-color-scheme: dark\)/, 'no dark override');
    // HA's stock values, so the panel matches an unthemed HA.
    assert.match(css, /--primary-color:\s*#009ac7/);
    assert.match(css, /--card-background-color:\s*#1c1c1c/); // HA dark card
});

test('page rules use the palette variables, not hardcoded colours', () => {
    // Strip comments and the :root/dark blocks, where literals belong.
    let rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    rules = rules.replace(/:root \{[\s\S]*?\n  \}/g, '');
    const hex = rules.match(/#[0-9a-fA-F]{3,6}\b/g) || [];
    assert.deepEqual(hex, [], `hardcoded colours outside :root: ${hex.join(", ")}`);
});
