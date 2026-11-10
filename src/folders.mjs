import path from 'node:path';
import { readJson, writeJson } from './store.mjs';
import { GoodnotesError } from './errors.mjs';
import { mutate } from './mutations.mjs';
import { digest } from './journal.mjs';

export function validateFolderPath(itemPath) {
  if (
    !Array.isArray(itemPath) ||
    !itemPath.length ||
    itemPath.length > 12 ||
    itemPath.some(
      (id) =>
        typeof id !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id),
    ) ||
    new Set(itemPath).size !== itemPath.length
  )
    throw new GoodnotesError(
      'INVALID_FOLDER_PATH',
      'Use a nonempty folder path of at most twelve distinct native IDs.',
    );
  return itemPath;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export async function folderPermissions(directory) {
  return readJson(path.join(directory, 'folder-permissions.json'), []);
}
export async function authorizeFolder(directory, itemPath, title) {
  validateFolderPath(itemPath);
  if (typeof title !== 'string' || !title.trim() || title.length > 150)
    throw new GoodnotesError('INVALID_TITLE', 'The exact folder title is required.');
  const permissions = await folderPermissions(directory),
    id = itemPath.at(-1),
    next = permissions.filter((p) => p.itemPath.at(-1) !== id);
  next.push({ itemPath, title });
  await writeJson(path.join(directory, 'folder-permissions.json'), next);
  return { itemPath, title };
}
export async function revokeFolder(directory, itemPath) {
  validateFolderPath(itemPath);
  const permissions = await folderPermissions(directory),
    next = permissions.filter((p) => !same(p.itemPath, itemPath));
  await writeJson(path.join(directory, 'folder-permissions.json'), next);
  return { itemPath, removed: next.length !== permissions.length };
}
export async function requireFolderPermission(directory, itemPath, title) {
  validateFolderPath(itemPath);
  if (
    !(await folderPermissions(directory)).some(
      (p) => same(p.itemPath, itemPath) && p.title === title,
    )
  )
    throw new GoodnotesError(
      'FOLDER_WRITE_NOT_ALLOWED',
      'This exact folder path/title is not authorized. Create a new MCP folder or use the local allow-folder command.',
    );
}
export async function updateFolderPermission(directory, before, after, title) {
  const permissions = await folderPermissions(directory);
  for (const p of permissions) {
    if (same(p.itemPath, before)) p.title = title;
    if (same(p.itemPath.slice(0, before.length), before))
      p.itemPath = [...after, ...p.itemPath.slice(before.length)];
  }
  await writeJson(path.join(directory, 'folder-permissions.json'), permissions);
}
export function validateFolderMove(itemPath, destinationPath) {
  validateFolderPath(itemPath);
  if (destinationPath.length) validateFolderPath(destinationPath);
  if (destinationPath.includes(itemPath.at(-1)))
    throw new GoodnotesError(
      'INVALID_FOLDER_MOVE',
      'A folder cannot be moved into itself or its descendants.',
    );
  if (destinationPath.length >= 12)
    throw new GoodnotesError(
      'FOLDER_DEPTH_LIMIT',
      'The destination exceeds the supported folder depth.',
    );
}
function contents(items) {
  return digest(
    items
      .map(({ id, kind, title }) => ({ id, kind, title }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}
export class FolderController {
  constructor(adapter) {
    this.a = adapter;
  }
  async manage(
    { action, itemPath, expectedTitle, title, destinationPath = [], operationId },
    options,
  ) {
    validateFolderPath(itemPath);
    if (!['rename', 'move'].includes(action))
      throw new GoodnotesError('INVALID_ACTION', 'Choose rename or move.');
    if (action === 'rename' && (!title?.trim() || title.length > 150))
      throw new GoodnotesError('INVALID_TITLE', 'Provide a nonempty new folder title.');
    if (action === 'move') validateFolderMove(itemPath, destinationPath);
    return mutate(
      this.a,
      operationId,
      { action: 'folder-' + action, itemPath, expectedTitle, title, destinationPath },
      async (mark) => {
        const a = this.a,
          id = itemPath.at(-1),
          parent = itemPath.slice(0, -1);
        await requireFolderPermission(a.config.directory, itemPath, expectedTitle);
        const source = await a.library.folder(parent),
          item = source.listing.items.find((i) => i.id === id && i.kind === 'folder');
        if (!item || item.title !== expectedTitle)
          throw new GoodnotesError(
            'FOLDER_CONFLICT',
            'The authorized folder is missing or its title changed.',
          );
        if (
          (action === 'rename' && title === expectedTitle) ||
          (action === 'move' && same(parent, destinationPath))
        )
          return { verified: true, changed: false, kind: 'folder', title: expectedTitle, itemPath };
        const before = await a.library.folder(itemPath),
          childrenHash = contents(before.listing.items);
        let nextPath = itemPath,
          nextTitle = expectedTitle;
        const structureBackup = path.join(
          a.config.directory,
          'folder-checkpoints',
          operationId + '.json',
        );
        await writeJson(structureBackup, {
          operationId,
          createdAt: new Date().toISOString(),
          itemPath,
          title: expectedTitle,
          children: before.listing.items.map(({ id, kind, title }) => ({ id, kind, title })),
          note: 'Folder structure only; not a backup of document contents.',
        });
        if (
          action === 'move' &&
          (await folderPermissions(a.config.directory)).some(
            (p) =>
              same(p.itemPath.slice(0, itemPath.length), itemPath) &&
              destinationPath.length + 1 + p.itemPath.length - itemPath.length > 12,
          )
        )
          throw new GoodnotesError(
            'FOLDER_DEPTH_LIMIT',
            'This move would put an authorized descendant beyond twelve folder levels.',
          );
        if (action === 'rename') {
          const { page, listing } = await a.library.folder(parent);
          if (
            !listing.items.some(
              (i) => i.id === id && i.kind === 'folder' && i.title === expectedTitle,
            )
          )
            throw new GoodnotesError(
              'FOLDER_CONFLICT',
              'The source folder changed before renaming.',
            );
          await requireFolderPermission(a.config.directory, itemPath, expectedTitle);
          await a.library.renameCard(page, id, title, mark);
          nextTitle = title;
        } else {
          const names = [];
          for (let i = 0; i < destinationPath.length; i++) {
            const { listing } = await a.library.folder(destinationPath.slice(0, i)),
              f = listing.items.find((f) => f.id === destinationPath[i] && f.kind === 'folder');
            if (!f)
              throw new GoodnotesError('FOLDER_NOT_FOUND', 'Destination folder no longer exists.');
            names.push(f.title);
          }
          const { page, listing } = await a.library.folder(parent);
          if (
            !listing.items.some(
              (i) => i.id === id && i.kind === 'folder' && i.title === expectedTitle,
            )
          )
            throw new GoodnotesError('FOLDER_CONFLICT', 'The source folder changed before moving.');
          await requireFolderPermission(a.config.directory, itemPath, expectedTitle);
          await a.library.menu(page, id);
          await page.locator('#libraryMoveId').click();
          await page.locator('#moveConfirmButton').waitFor({ state: 'visible' });
          for (const name of ['Documents', ...names]) {
            const target = page.locator(
              '[id=' + JSON.stringify('moveModalItem_folder_' + name) + ']',
            );
            await target.first().waitFor({ state: 'visible' });
            if ((await target.count()) !== 1)
              throw new GoodnotesError(
                'AMBIGUOUS_FOLDER',
                'The native move dialog has duplicate destination names.',
              );
            await target.click();
          }
          const confirm = page.locator('#moveConfirmButton');
          if (!(await confirm.isEnabled()))
            throw new GoodnotesError('MOVE_UNAVAILABLE', 'Goodnotes disabled this destination.');
          mark();
          await confirm.click();
          await confirm.waitFor({ state: 'detached' });
          await page.waitForTimeout(1200);
          nextPath = [...destinationPath, id];
        }
        const { listing } = await a.library.folder(nextPath.slice(0, -1));
        if (!listing.items.some((i) => i.id === id && i.kind === 'folder' && i.title === nextTitle))
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'The folder identity/title was not found in its expected parent after reload.',
          );
        if (action === 'move') {
          const old = await a.library.folder(parent);
          if (old.listing.items.some((i) => i.id === id))
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'The moved folder still appears in its old parent.',
            );
        }
        const after = await a.library.folder(nextPath);
        if (contents(after.listing.items) !== childrenHash)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Direct child identities or titles changed during folder management.',
          );
        await updateFolderPermission(a.config.directory, itemPath, nextPath, nextTitle);
        a.invalidate();
        return {
          verified: true,
          changed: true,
          kind: 'folder',
          title: nextTitle,
          itemPath: nextPath,
          previousPath: itemPath,
          previousTitle: expectedTitle,
          structureBackup,
          directChildren: after.listing.items.length,
          verification: 'folder-identity-title-parent-and-direct-children-after-reload',
          note: 'Refresh the library index after reorganizing folders. The saved manifest contains structure, not document contents. This checks immediate child identities, not every nested document content.',
        };
      },
      options,
    );
  }
}
