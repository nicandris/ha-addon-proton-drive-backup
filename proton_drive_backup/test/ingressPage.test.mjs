/**
 * The Web UI is one HTML file with an inline script (src/ui.html, served by
 * ingress.mjs). Nothing else parses that script before a browser does — and
 * 0.4.3 shipped a page whose script threw
 * "Uncaught SyntaxError: Invalid or unexpected token" and never rendered
 * (everything stayed on "Loading…"), back when it lived in a template literal.
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
    for (const id of ['statusCard', 'statsCard', 'settingsCard', 'syncNow', 'createBackup', 'pruneHA', 'saveSettings', 'backupRows', 'setPermDelete']) {
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
    // Everything between palette:start/palette:end is where literals belong.
    let rules = css.replace(/\/\* palette:start[\s\S]*?palette:end \*\//, '');
    rules = rules.replace(/\/\*[\s\S]*?\*\//g, '');
    const hex = rules.match(/#[0-9a-fA-F]{3,6}\b/g) || [];
    assert.deepEqual(hex, [], `hardcoded colours outside :root: ${hex.join(", ")}`);
});

test('an appearance selector offers Auto / Light / Dark and persists the choice', () => {
    assert.match(scripts[0], /id="themeSel"/);
    for (const v of ['auto', 'light', 'dark']) assert.ok(scripts[0].includes(`'${v}'`), `missing ${v} option`);
    assert.match(scripts[0], /localStorage\.setItem\(THEME_KEY/, 'choice is not persisted');
    // Applied before the first render, so there is no flash of the wrong theme.
    assert.match(scripts[0], /applyTheme\(currentTheme\(\)\);/);
});

test('forcing a theme overrides the prefers-color-scheme default in both directions', () => {
    // Dark forced explicitly...
    assert.match(css, /:root\[data-theme="dark"\] \{/);
    // ...and Light must beat the dark media query, or "Light" would do nothing on
    // a dark OS.
    assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
    // The dark values come from one constant, so the two blocks can't drift.
    const darkBlocks = css.match(/--card-background-color: #1c1c1c/g) || [];
    assert.equal(darkBlocks.length, 2, 'expected the dark palette in exactly the two override blocks');
});

test('the page shows progress while the first status is still unknown', () => {
    // The server answers instantly with pending:true (stale-while-revalidate), so
    // the page must render a spinner rather than guessing "disconnected" or
    // sitting on a bare "Loading…".
    assert.match(scripts[0], /s\.pending/, 'page ignores the pending flag');
    assert.match(scripts[0], /badge-idle"><span class="spinner"><\/span>/, 'no spinner on the status badge');
    // And it must not flash the Connect card at an already-connected user.
    assert.match(scripts[0], /!s\.connected && !s\.pending/);
    // Poll fast while pending so the fill-in feels immediate.
    assert.match(scripts[0], /s\.pending \? 1200/);
});

/**
 * Python's PurePath.match(), which the Supervisor uses for backup_exclude: a
 * relative pattern matches the path's LAST components (right-anchored), an
 * absolute one must match the whole path. `*` never crosses a `/`.
 */
function purePathMatch(path, pattern) {
    const parts = path.split('/').filter(Boolean);
    const pat = pattern.split('/').filter(Boolean);
    if (pattern.startsWith('/') ? pat.length !== parts.length : pat.length > parts.length) return false;
    const tail = parts.slice(parts.length - pat.length);
    return pat.every((seg, i) => new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`).test(tail[i]));
}

test('purePathMatch mirrors PurePath.match (right-anchored relative, whole-path absolute)', () => {
    assert.equal(purePathMatch('/data/addons/data/s/proton-drive-cli/x', 'proton-drive-cli/*'), true);
    assert.equal(purePathMatch('/data/addons/data/s/proton-drive-cli', 'proton-drive-cli'), true);
    assert.equal(purePathMatch('/data/addons/data/s/proton-drive-cli/x', '/data/proton-drive-cli/*'), false);
    assert.equal(purePathMatch('/data/proton-drive-cli/x', '/data/proton-drive-cli/*'), true);
});

test('the Proton session is excluded from Home Assistant backups (as the Supervisor matches it)', async () => {
    // Without a WORKING backup_exclude, every HA full backup (including the ones
    // this add-on uploads) contains a usable Proton session token. The Supervisor
    // matches each pattern against its own path for the file, not the
    // container's /data — 0.4.9 shipped "/data/proton-drive-cli/*", which never matched.
    const { readFile } = await import('node:fs/promises');
    const cfg = await readFile(new URL('../config.yaml', import.meta.url), 'utf8');
    const block = cfg.match(/^backup_exclude:\n((?:\s+- .+\n)+)/m);
    assert.ok(block, 'config.yaml has no backup_exclude list');
    const patterns = [...block[1].matchAll(/- (.+)/g)].map((m) => m[1].trim().replace(/^["']|["']$/g, ''));
    const supervisorDir = '/data/addons/data/a1b2c3d4_proton_drive_backup/proton-drive-cli';
    const excluded = (p) => patterns.some((pat) => purePathMatch(p, pat));
    // The directory itself (Supervisor then never recurses into it)...
    assert.ok(excluded(supervisorDir), `session dir not excluded by ${patterns.join(', ')}`);
    // ...and, belt and braces, the files directly in it.
    assert.ok(excluded(`${supervisorDir}/session.json`), 'session files not excluded');
    // Nothing else in /data is.
    assert.equal(excluded('/data/addons/data/a1b2c3d4_proton_drive_backup/options.json'), false);
});
