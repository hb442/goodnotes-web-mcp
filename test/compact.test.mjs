import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.mjs';
import { Journal } from '../src/journal.mjs';
import { mutate } from '../src/mutations.mjs';
const value = (r) => JSON.parse(r.content[0].text);
test('compact MCP discovery preserves strict action validation, routes and journal replay', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-compact-'));
  let writes = 0;
  const a = {
    config: { directory },
    journal: new Journal(directory),
    status: async () => ({ signedIn: true }),
  };
  a.library = {
    create: async (args) =>
      mutate(a, args.operationId, args, async (mark) => {
        mark();
        writes++;
        return { verified: true, kind: args.kind, folderPath: args.folderPath };
      }),
  };
  const server = createServer(a, { mode: 'compact' }),
    client = new Client({ name: 'compact-test', version: '1' }),
    [st, ct] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await server.connect(st);
  await client.connect(ct);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'goodnotes_help',
    'goodnotes_read',
    'goodnotes_write',
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(tools)) < 5000);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const search = value(await call('goodnotes_help', { query: 'folder', limit: 2 }));
  assert.equal(search.actions.length, 2);
  assert.equal(search.nextOffset, 2);
  const details = value(
    await call('goodnotes_help', {
      actions: ['goodnotes_create', 'goodnotes_edit_text', 'goodnotes_status'],
    }),
  );
  assert.equal(details.actions[0].route, 'goodnotes_write');
  assert.equal(
    details.actions[1].inputSchema.properties.format.properties.highlight.type,
    'string',
  );
  assert.equal(details.actions[2].route, 'goodnotes_read');
  assert.deepEqual(value(await call('goodnotes_read', { action: 'goodnotes_status' })), {
    signedIn: true,
  });
  assert.equal(
    value(await call('goodnotes_read', { action: 'goodnotes_create', parameters: {} })).error,
    'WRONG_ACTION_ROUTE',
  );
  assert.equal(
    value(await call('goodnotes_write', { action: 'goodnotes_status' })).error,
    'WRONG_ACTION_ROUTE',
  );
  assert.equal(
    value(await call('goodnotes_read', { action: '__proto__' })).error,
    'UNKNOWN_ACTION',
  );
  for (const parameters of [
    { kind: 'folder', title: 'Test', operationId: 'bad' },
    {
      kind: 'folder',
      title: 'Test',
      operationId: 'compact-valid-operation',
      hiddenCode: 'unexpected',
    },
  ]) {
    const result = await call('goodnotes_write', { action: 'goodnotes_create', parameters });
    assert.equal(result.isError, true);
    assert.equal(value(result).error, 'INVALID_ACTION_INPUT');
  }
  assert.equal(writes, 0);
  const args = {
    action: 'goodnotes_create',
    parameters: { kind: 'folder', title: 'Test', operationId: 'compact-valid-operation' },
  };
  const created = value(await call('goodnotes_write', args));
  assert.equal(created.verified, true);
  assert.deepEqual(created.folderPath, []);
  assert.equal(value(await call('goodnotes_write', args)).replayed, true);
  assert.equal(writes, 1);
});
test('compact stdio starts without a browser and exposes on-demand schemas', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-compact-stdio-'));
  const client = new Client({ name: 'compact-stdio-test', version: '1' }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
      env: { ...process.env, GOODNOTES_MCP_HOME: directory, GOODNOTES_MCP_MODE: 'compact' },
      stderr: 'pipe',
    });
  t.after(async () => {
    await client.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 3);
  const result = await client.callTool({
    name: 'goodnotes_help',
    arguments: { actions: ['goodnotes_manage_folder'] },
  });
  assert.equal(result.isError, undefined);
  assert.ok(value(result).actions[0].inputSchema.properties.destinationPath);
  const revisions = value(
    await client.callTool({
      name: 'goodnotes_help',
      arguments: {
        actions: [
          'goodnotes_prepare_study_revision',
          'goodnotes_plan_study_revision',
          'goodnotes_study_revision_status',
        ],
      },
    }),
  ).actions;
  assert.deepEqual(
    revisions.map((a) => a.route),
    ['goodnotes_write', 'goodnotes_write', 'goodnotes_read'],
  );
  assert.equal(revisions[0].inputSchema.properties.copy.default, true);
  assert.equal(revisions[1].inputSchema.properties.changes.properties.updates.maxItems, 24);
  const invalid = await client.callTool({
    name: 'goodnotes_write',
    arguments: {
      action: 'goodnotes_plan_study_revision',
      parameters: { revisionId: 'invalid', changes: { updates: [] } },
    },
  });
  assert.equal(value(invalid).error, 'INVALID_ACTION_INPUT');
  assert.equal(
    (await fs.readdir(directory)).some((n) => n.startsWith('browser-profile')),
    false,
  );
});
