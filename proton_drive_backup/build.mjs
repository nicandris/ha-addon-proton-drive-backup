import { build } from 'esbuild';

await build({
    entryPoints: ['src/main.mjs'],
    outfile: 'dist/main.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    legalComments: 'none',
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
