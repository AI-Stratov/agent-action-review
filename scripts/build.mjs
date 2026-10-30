import { build } from 'esbuild';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const license = await readFile(join(root, 'LICENSE'), 'utf8');
for (const name of ['core', 'dsh']) await writeFile(join(root, 'packages', name, 'LICENSE'), license);
const output = join(root, 'packages/dsh/dist');
await mkdir(output, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ['packages/dsh/src/index.js'],
  outfile: join(output, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: 'inline',
  metafile: true,
  logLevel: 'warning',
});
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  let directory = dirname(resolve(root, input));
  while (directory !== root && directory !== dirname(directory)) {
    const manifestPath = join(directory, 'package.json');
    try {
      await access(manifestPath);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        if (relative(root, directory).split(/[\\/]/).includes('node_modules')) packages.set(directory, manifest);
        break;
      }
      directory = dirname(directory);
    } catch {
      directory = dirname(directory);
    }
  }
}
const notices = [];
for (const [directory, manifest] of [...packages].sort(([, left], [, right]) => left.name.localeCompare(right.name))) {
  let license;
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'license']) {
    try {
      license = await readFile(join(directory, filename), 'utf8');
      break;
    } catch {}
  }
  if (!license) throw new Error(`Bundled dependency ${manifest.name} has no license text.`);
  notices.push(`${manifest.name}@${manifest.version}\n\n${license.trim()}\n`);
}
await writeFile(join(output, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n---\n\n'));
console.log(`Built packages/dsh/dist/index.js with ${packages.size} dependency license notices.`);
