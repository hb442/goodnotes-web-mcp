import { GoodnotesError, checkCancellation } from './errors.mjs';

export function requireWritable(adapter, view) {
  if (!adapter.config.documents.some((d) => d.url === view.url && d.title === view.title))
    throw new GoodnotesError(
      'WRITE_NOT_ALLOWED',
      'This document is not on the local write allowlist. Use a new MCP-created document, a duplicate, or the local allow command.',
    );
}
export async function mutate(adapter, operationId, input, action, { signal } = {}) {
  checkCancellation(signal);
  const existing = await adapter.journal.begin(operationId, input);
  if (!existing.fresh) return { ...existing.record.result, replayed: true };
  let sent = false;
  const mark = () => {
    checkCancellation(signal);
    sent = true;
  };
  try {
    const result = { operationId, ...(await action(mark)) };
    if (!result.verified)
      throw new GoodnotesError(
        'SAVE_UNVERIFIED',
        'The change was sent but its result could not be verified.',
      );
    await adapter.journal.finish(operationId, 'verified', result);
    return result;
  } catch (error) {
    await adapter.journal
      .finish(operationId, sent ? 'uncertain' : 'rejected', {
        code: error.code || 'ACTION_FAILED',
        mayHaveWritten: sent,
      })
      .catch(() => {});
    throw new GoodnotesError(error.code || 'ACTION_FAILED', error.message, {
      ...error.details,
      operationId,
      mayHaveWritten: sent,
    });
  }
}
