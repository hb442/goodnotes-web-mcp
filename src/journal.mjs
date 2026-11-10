import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export class Journal {
  constructor(directory) {
    this.directory = path.join(directory, 'operations');
  }
  file(id) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id))
      throw new Error('operationId must contain 8–80 letters, digits, hyphens or underscores.');
    return path.join(this.directory, `${id}.json`);
  }
  async begin(id, input) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(id),
      fingerprint = digest(input);
    const record = { id, fingerprint, status: 'pending', started: new Date().toISOString() };
    try {
      await fs.writeFile(file, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
      return { fresh: true, record };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = JSON.parse(await fs.readFile(file, 'utf8'));
      if (old.fingerprint !== fingerprint)
        throw new Error('operationId was already used for different input.');
      if (old.status === 'verified') return { fresh: false, record: old };
      throw new Error(
        'This operation may already have changed the document. Inspect it before retrying; automatic replay is blocked.',
      );
    }
  }
  async get(id) {
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { id, status: 'not-found' };
      throw error;
    }
  }
  async finish(id, status, result) {
    const file = this.file(id),
      record = JSON.parse(await fs.readFile(file, 'utf8'));
    // Deliberately store hashes/receipts, never the note text or session credentials.
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(
      temporary,
      JSON.stringify({ ...record, status, finished: new Date().toISOString(), result }, null, 2),
      { mode: 0o600 },
    );
    await fs.rename(temporary, file);
  }
}
