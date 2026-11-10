import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const [mode, input] = process.argv.slice(2);
if (!['inspect', 'edit'].includes(mode) || !input)
  throw new Error('Usage: node scripts/smoke.mjs inspect <URL> | edit <local-JSON-file>');
const specification =
  mode === 'edit' ? JSON.parse(await fs.readFile(input, 'utf8')) : { url: input };
const out = path.join(root, '.local');
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const client = new Client({ name: 'goodnotes-local-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'src/server.mjs')],
  env: { ...process.env },
  stderr: 'pipe',
});
transport.stderr?.on('data', (bytes) => process.stderr.write(bytes));
const evidence = { mode, started: new Date().toISOString(), calls: [] };
async function call(name, args) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  evidence.calls.push({ name, milliseconds: Date.now() - started, isError: !!result.isError });
  const text = result.content.find((c) => c.type === 'text');
  const json = text ? JSON.parse(text.text) : null;
  if (result.isError) throw new Error(JSON.stringify(json));
  return { result, json };
}
async function preview(viewId, file) {
  const { result } = await call('goodnotes_preview', { viewId });
  const picture = result.content.find((c) => c.type === 'image');
  if (!picture) throw new Error('No preview returned.');
  await fs.writeFile(path.join(out, file), Buffer.from(picture.data, 'base64'), { mode: 0o600 });
}
try {
  await client.connect(transport);
  evidence.tools = (await client.listTools()).tools.map((t) => t.name);
  const { json: view } = await call('goodnotes_inspect', { url: specification.url });
  evidence.view = { ...view, viewId: undefined };
  await preview(view.viewId, 'before.jpg');
  console.log(JSON.stringify({ view, preview: path.join(out, 'before.jpg') }, null, 2));
  if (mode === 'edit') {
    if (
      typeof specification.expectedText !== 'string' ||
      typeof specification.replacementText !== 'string'
    )
      throw new Error('expectedText and replacementText are required.');
    const { json: target } = await call('goodnotes_read_text', {
      viewId: view.viewId,
      x: specification.x,
      y: specification.y,
    });
    if (target.text !== specification.expectedText)
      throw new Error('The selected field does not match expectedText. No replacement was sent.');
    const { json: receipt } = await call('goodnotes_write_text', {
      targetId: target.targetId,
      text: specification.replacementText,
      operationId: specification.operationId,
    });
    evidence.receipt = receipt;
    console.log(JSON.stringify({ receipt }, null, 2));
    const { json: after } = await call('goodnotes_inspect', { url: specification.url });
    await preview(after.viewId, 'after.jpg');
  }
  evidence.ok = true;
} catch (error) {
  evidence.ok = false;
  evidence.error = error.message;
  process.exitCode = 1;
  process.stderr.write(error.message + '\n');
} finally {
  evidence.finished = new Date().toISOString();
  await fs.writeFile(
    path.join(out, 'smoke-result.json'),
    JSON.stringify(evidence, null, 2) + '\n',
    { mode: 0o600 },
  );
  await client.close();
}
