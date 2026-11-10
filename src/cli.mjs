#!/usr/bin/env node
import {
  loadConfig,
  authorizeDocument,
  revokeDocument,
  dataDirectory,
  HOME_URL,
} from './config.mjs';
import { login, openSession } from './session.mjs';
import { authorizeFolder, revokeFolder } from './folders.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  const config = await loadConfig();
  if (command === 'allow-folder') {
    console.log(
      JSON.stringify(
        await authorizeFolder(config.directory, JSON.parse(args[0]), args.slice(1).join(' ')),
        null,
        2,
      ),
    );
  } else if (command === 'revoke-folder') {
    console.log(JSON.stringify(await revokeFolder(config.directory, JSON.parse(args[0])), null, 2));
  } else if (command === 'login') {
    if (args.length && (args[0] !== '--browser' || args.length !== 2))
      throw new Error('Usage: npm run login -- --browser chrome|msedge|chromium');
    await login(config, { browser: args[1] || 'chrome' });
  } else if (command === 'allow') {
    const [url, ...title] = args;
    console.log(
      JSON.stringify(await authorizeDocument(config.directory, url, title.join(' ')), null, 2),
    );
  } else if (command === 'revoke') {
    console.log(JSON.stringify(await revokeDocument(config.directory, args[0]), null, 2));
  } else if (command === 'doctor') {
    const session = await openSession(config);
    try {
      await session.page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
      await session.page
        .locator('#homeSidebarDocumentsOptionId')
        .waitFor({ state: 'visible', timeout: 30000 });
      console.log(
        JSON.stringify(
          {
            ok: true,
            signedIn: true,
            browser: config.browser,
            allowedDocuments: config.documents.length,
            dataDirectory: dataDirectory(),
          },
          null,
          2,
        ),
      );
    } finally {
      await session.close();
    }
  } else {
    console.log(
      'goodnotes-web-mcp\n  npm run login\n  npm run doctor\n  node src/cli.mjs allow <Goodnotes-document-URL> "Exact document title"\n  node src/cli.mjs revoke <Goodnotes-document-URL>\n  node src/cli.mjs allow-folder <JSON-itemPath> "Exact folder title"\n  node src/cli.mjs revoke-folder <JSON-itemPath>\n  npm start',
    );
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
