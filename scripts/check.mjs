import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let modules = 0;
async function syntax(relative) {
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) await syntax(child);
    else if (child.endsWith('.mjs')) {
      execFileSync(process.execPath, ['--check', path.join(root, child)], {
        stdio: 'pipe',
        windowsHide: true,
      });
      modules++;
    }
  }
}
for (const folder of ['src', 'scripts', 'test']) await syntax(folder);
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')),
  lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
assert.equal(pkg.version, lock.version);
assert.equal(pkg.version, lock.packages[''].version);
const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8'),
  reference = await fs.readFile(path.join(root, 'docs/TOOLS.md'), 'utf8'),
  mentioned = new Set(reference.match(/goodnotes_[a-z_]+/g)),
  measurements = {};
for (const mode of ['full', 'compact']) {
  const server = createServer({}, { mode }),
    client = new Client({ name: 'source-check', version: '1' }),
    [st, ct] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    assert.equal(client.getServerVersion().version, pkg.version);
    const { tools } = await client.listTools();
    assert.equal(new Set(tools.map((t) => t.name)).size, tools.length);
    if (mode === 'full') {
      assert.deepEqual(
        tools.filter((t) => !mentioned.has(t.name)).map((t) => t.name),
        [],
        'Undocumented full-mode tool',
      );
      assert.deepEqual(
        [...mentioned].filter((n) => !tools.some((t) => t.name === n)),
        [],
        'Action reference lists a nonexistent tool',
      );
      assert.ok(
        readme.includes('with ' + tools.length + ' actions'),
        'README action count is stale',
      );
    } else {
      assert.deepEqual(tools.map((t) => t.name).sort(), [
        'goodnotes_help',
        'goodnotes_read',
        'goodnotes_write',
      ]);
      const response = await client.callTool({ name: 'goodnotes_help', arguments: { limit: 100 } });
      assert.equal(response.isError, undefined);
      assert.equal(JSON.parse(response.content[0].text).total, measurements.full.tools);
    }
    measurements[mode] = {
      tools: tools.length,
      discoveryBytes: Buffer.byteLength(JSON.stringify(tools)),
    };
  } finally {
    await client.close();
    await server.close();
  }
}
console.log(
  JSON.stringify({ version: pkg.version, syntaxCheckedModules: modules, ...measurements }),
);
