import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../src/server.mjs';
import { GoodnotesError } from '../src/adapter.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('real MCP initialization, tool discovery and error semantics', async (t) => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({
    status: async () => ({ signedIn: true }),
    inspect: async () => {
      throw new GoodnotesError('LOGIN_REQUIRED', 'Sign in first.');
    },
  });
  const client = new Client({ name: 'integration-test', version: '1' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 107);
  assert.equal(new Set(tools.map((t) => t.name)).size, tools.length);
  assert.ok(JSON.stringify(tools.find((t) => t.name === 'goodnotes_plan_batch')).length < 2000);
  const help = await client.callTool({
    name: 'goodnotes_batch_help',
    arguments: { actions: ['copy-page', 'edit-text'] },
  });
  const instructions = JSON.parse(help.content[0].text);
  assert.equal(instructions.actions.length, 2);
  assert.equal(instructions.actions[0].schema.properties.sourcePage.type, 'integer');
  assert.equal(instructions.actions[1].schema.properties.format.properties.strike.type, 'boolean');
  assert.equal(instructions.actions[1].schema.properties.formatRanges.type, 'array');
  assert.equal(
    tools.find((t) => t.name === 'goodnotes_edit_text').inputSchema.properties.formatRanges
      .maxItems,
    20,
  );
  assert.equal(
    tools.find((t) => t.name === 'goodnotes_write_text').annotations.readOnlyHint,
    false,
  );
  assert.equal(
    tools.find((t) => t.name === 'goodnotes_write_text').annotations.destructiveHint,
    true,
  );
  const status = await client.callTool({ name: 'goodnotes_status', arguments: {} });
  assert.deepEqual(JSON.parse(status.content[0].text), { signedIn: true });
  const failure = await client.callTool({
    name: 'goodnotes_inspect',
    arguments: { url: 'https://web.goodnotes.com/s/TestDocument123' },
  });
  assert.equal(failure.isError, true);
  assert.equal(JSON.parse(failure.content[0].text).error, 'LOGIN_REQUIRED');
});
test('stdio server starts without login or browser and exits cleanly', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnmcp-protocol-'));
  const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, GOODNOTES_MCP_HOME: dir },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1' });
  t.after(async () => {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await client.connect(transport);
  const response = await client.listTools();
  assert.equal(response.tools.length, 107);
  assert.equal((await fs.readdir(dir)).includes('browser-profile'), false);
});
