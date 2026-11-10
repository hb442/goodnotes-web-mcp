import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

export const ORIGIN = 'https://web.goodnotes.com';
export const HOME_URL = `${ORIGIN}/home`;
export const VIEWPORT = { width: 1440, height: 1000 };

export function dataDirectory(env = process.env) {
  if (env.GOODNOTES_MCP_HOME) return path.resolve(env.GOODNOTES_MCP_HOME);
  const base =
    process.platform === 'win32'
      ? env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'goodnotes-web-mcp');
}

export function documentUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error('Expected a Goodnotes Web document URL.');
  }
  if (
    u.origin !== ORIGIN ||
    u.username ||
    u.password ||
    u.search ||
    !/^\/s\/[A-Za-z0-9_-]{8,100}\/?$/.test(u.pathname)
  ) {
    throw new Error('Only https://web.goodnotes.com/s/<document> URLs are accepted.');
  }
  if (u.hash && !/^#page-[1-9]\d*$/.test(u.hash))
    throw new Error('Unexpected document URL fragment.');
  return `${ORIGIN}${u.pathname.replace(/\/$/, '')}`;
}

export async function loadConfig(directory = dataDirectory()) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let raw = {};
  try {
    raw = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error('Could not read config.json. Fix it before continuing.');
  }
  if (raw.documents !== undefined && !Array.isArray(raw.documents))
    throw new Error('config.documents must be an array.');
  const browser = raw.browser || 'chromium';
  if (!['chromium', 'chrome', 'msedge'].includes(browser))
    throw new Error('config.browser must be chromium, chrome, or msedge.');
  const documents = (raw.documents || []).map((d) => {
    if (!d.title || typeof d.title !== 'string')
      throw new Error('Every allowed document requires its exact title.');
    return { url: documentUrl(d.url), title: d.title };
  });
  return {
    directory,
    browser,
    profile: path.join(
      directory,
      browser === 'chromium' ? 'browser-profile' : `browser-profile-${browser}`,
    ),
    documents,
    viewport: VIEWPORT,
  };
}

export async function authorizeDocument(directory, url, title) {
  if (typeof title !== 'string' || !title.trim())
    throw new Error('The exact document title is required.');
  const config = await loadConfig(directory);
  const canonical = documentUrl(url);
  const documents = config.documents.filter((d) => d.url !== canonical);
  documents.push({ url: canonical, title });
  await fs.writeFile(
    path.join(directory, 'config.json'),
    JSON.stringify({ browser: config.browser, documents }, null, 2) + '\n',
    { mode: 0o600 },
  );
  return { url: canonical, title };
}

export async function revokeDocument(directory, url) {
  const config = await loadConfig(directory),
    canonical = documentUrl(url);
  const documents = config.documents.filter((d) => d.url !== canonical);
  await fs.writeFile(
    path.join(directory, 'config.json'),
    JSON.stringify({ browser: config.browser, documents }, null, 2) + '\n',
    { mode: 0o600 },
  );
  return {
    url: canonical,
    removed: documents.length !== config.documents.length,
    restartRequired: true,
  };
}

export async function selectBrowser(directory, browser) {
  if (!['chromium', 'chrome', 'msedge'].includes(browser))
    throw new Error('Use chrome, msedge, or chromium.');
  const config = await loadConfig(directory);
  await fs.writeFile(
    path.join(directory, 'config.json'),
    JSON.stringify({ browser, documents: config.documents }, null, 2) + '\n',
    { mode: 0o600 },
  );
  return loadConfig(directory);
}
