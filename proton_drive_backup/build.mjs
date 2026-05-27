import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

// Single source of truth for the version: package.json. Inlined at build time
// so x-pm-appversion always matches the actual build and can't drift.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const appVersion = `external-drive-ha_addon_proton_drive_backup@${version}-alpha`;

await build({
    entryPoints: ['src/main.mjs'],
    outfile: 'dist/main.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    legalComments: 'none',
    define: { __APP_VERSION__: JSON.stringify(appVersion) },
    alias: { 'openpgp/lightweight': 'openpgp' },
    banner: {
        js: [
            "import { createRequire as __cr } from 'module';",
            "import { fileURLToPath as __f } from 'url';",
            "import { dirname as __d } from 'path';",
            'const require = __cr(import.meta.url);',
            'const __filename = __f(import.meta.url);',
            'const __dirname = __d(__filename);',
        ].join('\n'),
    },
});

console.log('Build complete: dist/main.mjs');
