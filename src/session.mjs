import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { acquireLock } from './lock.mjs';
import { ORIGIN, selectBrowser } from './config.mjs';
import { browserExecutable, manualLoginArguments } from './browser.mjs';

export async function openSession(config, { headless = true } = {}) {
  const release = await acquireLock(config.directory);
  let context;
  try {
    context = await chromium.launchPersistentContext(config.profile, {
      headless,
      channel: config.browser || 'chromium',
      executablePath: await browserExecutable(config.browser || 'chromium'),
      viewport: config.viewport,
      deviceScaleFactor: 1,
      locale: 'en-US',
      acceptDownloads: true,
      chromiumSandbox: true,
    });
    const page = await context.newPage();
    for (const old of context.pages()) if (old !== page) await old.close();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(45000);
    // No browser debugging port, desktop input, clipboard reads or cookie exports.
    let closed = false;
    return {
      page,
      context,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await context.close();
        } finally {
          await release();
        }
      },
    };
  } catch (error) {
    await context?.close().catch(() => {});
    await release();
    throw error;
  }
}

export async function login(config, { browser = 'chrome' } = {}) {
  const executable = await browserExecutable(browser);
  const release = await acquireLock(config.directory);
  try {
    config = await selectBrowser(config.directory, browser);
    process.stderr.write(
      `Sign in manually in the separate ${browser} window, then close all its windows. This login window is not automated. Your normal browser profile is not accessed.\n`,
    );
    const child = spawn(executable, manualLoginArguments(config.profile), {
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`The login browser exited with code ${code}.`)),
      );
    });
  } finally {
    await release();
  }
}

export async function ensureGoodnotes(page) {
  if (new URL(page.url()).origin !== ORIGIN)
    throw new Error('Goodnotes sign-in is required. Run npm run login first.');
}
