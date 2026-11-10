import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = [
  'src',
  'scripts',
  'docs',
  'examples',
  'test',
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'CHANGELOG.md',
  'setup.cmd',
  '.gitignore',
  '.gitattributes',
  '.prettierrc.json',
  '.prettierignore',
  'package.json',
  'package-lock.json',
];
const manifest = [];
async function inspect(relative) {
  const absolute = path.join(root, relative),
    stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${relative}`);
  if (stat.isDirectory()) {
    for (const child of (await fs.readdir(absolute)).sort())
      await inspect(path.join(relative, child));
  } else if (stat.isFile()) {
    const bytes = await fs.readFile(absolute);
    // Every allowlisted asset is text; reject damaged Windows encodings before
    // publishing an archive that silently replaces characters when installed.
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Release text is not valid UTF-8: ${relative}`);
    }
    manifest.push({
      path: relative.replaceAll('\\', '/'),
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  } else throw new Error(`Unsupported release entry: ${relative}`);
}
for (const entry of entries) await inspect(entry);
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) throw new Error('Unexpected version.');
const out = path.join(root, 'dist');
await fs.mkdir(out, { recursive: true });
const name = `goodnotes-web-mcp-${version}.tar.gz`,
  archive = path.join(out, name);
const run = spawnSync('tar', ['-czf', archive, ...entries], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
});
if (run.error) throw run.error;
if (run.status !== 0) throw new Error(run.stderr || 'tar failed');
const archiveHash = crypto
  .createHash('sha256')
  .update(await fs.readFile(archive))
  .digest('hex');
await fs.writeFile(archive + '.sha256', `${archiveHash}  ${name}\n`);
await fs.writeFile(
  path.join(out, 'manifest.json'),
  JSON.stringify({ version, files: manifest }, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    { archive, files: manifest.length, bytes: (await fs.stat(archive)).size, sha256: archiveHash },
    null,
    2,
  ),
);
