import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function acquireLock(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'session.lock');
  const nonce = crypto.randomUUID();
  const content = { pid: process.pid, nonce, started: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(content));
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = JSON.parse(await fs.readFile(file, 'utf8'));
          if (current.nonce === nonce) await fs.unlink(file);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let current;
      try {
        current = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        throw new Error(
          'Profile lock is unreadable. Close all helper sessions and inspect session.lock.',
        );
      }
      if (!Number.isInteger(current.pid) || current.pid < 1)
        throw new Error('Invalid profile lock; refusing to start.');
      let alive = true;
      try {
        process.kill(current.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') alive = false;
      }
      if (alive)
        throw new Error(
          'This Goodnotes helper profile is already in use. Close its login window or other MCP session first.',
        );
      const latest = JSON.parse(await fs.readFile(file, 'utf8'));
      if (latest.nonce !== current.nonce)
        throw new Error('The helper profile was claimed by another session.');
      await fs.unlink(file);
    }
  }
  throw new Error('Could not acquire the helper profile.');
}
