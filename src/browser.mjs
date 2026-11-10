import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { HOME_URL } from './config.mjs';

export function manualLoginArguments(profile) {
  if (!path.isAbsolute(profile)) throw new Error('A dedicated absolute profile path is required.');
  // Launch a normal browser for the human sign-in: no automation/debugging channel,
  // identity spoofing, disabled protections, or imported personal browser profile.
  return [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', HOME_URL];
}

export async function browserExecutable(browser) {
  let candidates = [];
  if (browser === 'chromium') candidates = [chromium.executablePath()];
  else if (!['chrome', 'msedge'].includes(browser))
    throw new Error('Use chrome, msedge, or chromium.');
  else if (process.platform === 'win32') {
    const suffix =
      browser === 'chrome'
        ? ['Google', 'Chrome', 'Application', 'chrome.exe']
        : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
    candidates = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ]
      .filter(Boolean)
      .map((base) => path.join(base, ...suffix));
  } else if (process.platform === 'darwin') {
    const app = browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
    candidates = ['/Applications', path.join(os.homedir(), 'Applications')].map((base) =>
      path.join(base, `${app}.app`, 'Contents', 'MacOS', app),
    );
  } else {
    candidates =
      browser === 'chrome'
        ? ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']
        : [
            '/opt/microsoft/msedge/msedge',
            '/usr/bin/microsoft-edge-stable',
            '/usr/bin/microsoft-edge',
          ];
  }
  for (const candidate of candidates) {
    if ((await fs.stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  throw new Error(
    `${browser} is not installed. Install it or choose another browser with npm run login -- --browser msedge.`,
  );
}
