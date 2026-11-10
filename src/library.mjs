import { authorizeDocument, loadConfig, documentUrl } from './config.mjs';
import { GoodnotesError } from './errors.mjs';
import { mutate, requireWritable } from './mutations.mjs';
import { collectScrollList } from './scroll-list.mjs';
import { authorizeFolder } from './folders.mjs';

const TITLES =
  '[id^="libraryFolderTitle-"],[id^="libraryDocumentWhiteboardNameId-"],[id^="libraryDocumentNameId-"]';
export class LibraryController {
  constructor(adapter) {
    this.a = adapter;
  }
  async allow(url, title) {
    await authorizeDocument(this.a.config.directory, url, title);
    this.a.config.documents = (await loadConfig(this.a.config.directory)).documents;
  }
  async folder(folderPath = []) {
    const listing = await this.a.list({ folderPath, limit: 10000 });
    if (listing.truncated || listing.scanComplete === false)
      throw new GoodnotesError(
        'LIBRARY_LIST_INCOMPLETE',
        'Cannot safely identify new or moved items from an incomplete folder scan.',
      );
    const page = await this.a.getPage();
    // This informational migration notice can reappear on every library navigation.
    const notice = page.getByText(
      'Your files are being moved from your iOS device to Goodnotes Cloud',
      { exact: true },
    );
    if (await notice.isVisible().catch(() => false))
      await page.getByRole('button', { name: 'Ok', exact: true }).click();
    return { page, listing };
  }
  async card(page, id) {
    const card = page.locator(`[data-document-id="${id}"]`);
    if (!(await card.count()))
      await collectScrollList(page, {
        selector: '[data-document-id]',
        read: () => this.a.readLibraryCards(page),
        stopId: id,
        restore: false,
      });
    await card.waitFor({ state: 'visible', timeout: 15000 });
    return card;
  }
  async menu(page, id) {
    const card = await this.card(page, id);
    await card.locator(TITLES).click();
  }
  async favoriteState(page, id) {
    const card = await this.card(page, id),
      control = card.locator('[id^="libraryDocumentNotebookFavorited_' + id + '_"]');
    if ((await control.count()) !== 1)
      throw new GoodnotesError(
        'FAVORITE_UNAVAILABLE',
        'Cannot identify one native document favorite control.',
      );
    const value = await control.getAttribute('id');
    if (!value.endsWith('_true') && !value.endsWith('_false'))
      throw new GoodnotesError(
        'FAVORITE_UNAVAILABLE',
        'The native favorite state is not readable.',
      );
    return { favorite: value.endsWith('_true'), control };
  }
  async setFavorite({ itemPath, expectedTitle, expectedFavorite, favorite, operationId }, options) {
    const parent = itemPath.slice(0, -1),
      id = itemPath.at(-1);
    return mutate(
      this.a,
      operationId,
      { action: 'favorite-document', itemPath, expectedTitle, expectedFavorite, favorite },
      async (mark) => {
        const a = this.a,
          view = await a.openItem({ itemPath });
        requireWritable(a, view);
        if (view.title !== expectedTitle)
          throw new GoodnotesError('DOCUMENT_CONFLICT', 'The expected document title changed.');
        const { page, listing } = await this.folder(parent);
        const sameItem = (items) =>
          items.some((i) => i.id === id && i.kind !== 'folder' && i.title === expectedTitle);
        if (!sameItem(listing.items))
          throw new GoodnotesError(
            'DOCUMENT_CONFLICT',
            'The original document is missing from this folder.',
          );
        let before = await this.favoriteState(page, id);
        await page.waitForTimeout(400);
        const settled = await this.favoriteState(page, id);
        if (before.favorite !== settled.favorite || settled.favorite !== expectedFavorite)
          throw new GoodnotesError(
            'FAVORITE_CONFLICT',
            'The favorite state changed. Read the library again.',
          );
        if (favorite === expectedFavorite)
          return {
            verified: true,
            changed: false,
            url: view.url,
            title: expectedTitle,
            itemPath,
            favorite,
          };
        requireWritable(a, view);
        mark();
        await settled.control.click();
        await page.waitForTimeout(1200);
        const after = await this.folder(parent);
        if (!sameItem(after.listing.items))
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'The document identity or title changed after the favorite update.',
          );
        let saved = await this.favoriteState(after.page, id);
        for (let attempt = 0; attempt < 4 && saved.favorite !== favorite; attempt++) {
          await after.page.waitForTimeout(800);
          saved = await this.favoriteState(after.page, id);
        }
        if (saved.favorite !== favorite)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'The requested favorite state did not survive reload.',
          );
        a.invalidate();
        return {
          verified: true,
          changed: true,
          url: view.url,
          title: expectedTitle,
          itemPath,
          favorite,
          verification: 'document-identity-title-and-favorite-after-reload',
        };
      },
      options,
    );
  }
  async findNew(page, before) {
    await page.waitForFunction(
      (old) =>
        Array.from(document.querySelectorAll('[data-document-id]')).some(
          (e) => !old.includes(e.getAttribute('data-document-id')),
        ),
      before,
      { timeout: 30000 },
    );
    const ids = await page
      .locator('[data-document-id]')
      .evaluateAll((es) => es.map((e) => e.getAttribute('data-document-id')));
    const added = ids.filter((id) => !before.includes(id));
    if (added.length !== 1)
      throw new GoodnotesError(
        'AMBIGUOUS_CREATED_ITEM',
        'More than one new library item appeared. Inspect the library before retrying.',
      );
    return added[0];
  }
  async renameCard(page, id, title, mark) {
    await this.menu(page, id);
    await page.locator('#libraryRequestRenameId').click();
    const input = (await this.card(page, id)).locator('input');
    await input.waitFor({ state: 'visible' });
    await input.fill(title);
    mark();
    await input.press('Enter');
    await input.waitFor({ state: 'detached' });
    const saved = (await (await this.card(page, id)).locator(TITLES).innerText()).trim();
    if (saved !== title)
      throw new GoodnotesError(
        'SAVE_UNVERIFIED',
        'The library title did not match after renaming.',
      );
    // The card updates optimistically; let its native save complete before navigating away.
    await page.waitForTimeout(1200);
  }
  async create({ kind, title, folderPath = [], operationId }, options) {
    if (!title?.trim() || title.length > 150)
      throw new GoodnotesError('INVALID_TITLE', 'Use a non-empty title of at most 150 characters.');
    if (kind === 'folder' && folderPath.length >= 12)
      throw new GoodnotesError('FOLDER_DEPTH_LIMIT', 'Folders are limited to twelve levels.');
    return mutate(
      this.a,
      operationId,
      { action: 'create', kind, title, folderPath },
      async (mark) => {
        const { page, listing } = await this.folder(folderPath),
          before = listing.items.map((i) => i.id);
        await page.getByRole('button', { name: 'New', exact: true }).click();
        if (kind === 'folder') {
          await page.locator('#libraryCreateNewFolderMenuOption').click();
          await page.locator('#libraryCreateFolderInput').fill(title);
          mark();
          await page.locator('#libraryCreateFolderConfirmBtn').click();
          const id = await this.findNew(page, before);
          await page.waitForTimeout(600);
          const verify = await this.a.list({ folderPath, limit: 10000 });
          if (!verify.items.some((i) => i.id === id && i.title === title && i.kind === 'folder'))
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'The new folder did not survive a library reload.',
            );
          await authorizeFolder(this.a.config.directory, [...folderPath, id], title);
          return {
            verified: true,
            kind,
            title,
            itemPath: [...folderPath, id],
            verification: 'library-reload',
          };
        }
        if (!['whiteboard', 'notebook'].includes(kind))
          throw new GoodnotesError('INVALID_KIND', 'Choose folder, notebook or whiteboard.');
        const board = kind === 'whiteboard';
        await page
          .locator(
            board
              ? '#libraryCreateNewWhiteboardDocumentMenuOption'
              : '#libraryCreateNewDocumentMenuOption',
          )
          .click();
        await page
          .locator(
            board ? '#create-whiteboard-title-input' : '#template-library-sidebar-title-text-input',
          )
          .fill(title);
        mark();
        await page
          .locator(
            board ? '#create-whiteboard-footer-create' : '#template-library-create-document-button',
          )
          .click();
        await page.locator('#infoButton').waitFor({ state: 'visible', timeout: 45000 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('#infoButton').waitFor({ state: 'visible', timeout: 45000 });
        const url = await this.a.settledDocumentUrl(page);
        await this.a.openDocument(url);
        if ((await page.locator('#infoButton').innerText()).trim() !== title)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'The new document title could not be verified.',
          );
        await this.allow(url, title);
        const after = await this.a.list({ folderPath, limit: 10000 }),
          added = after.items.filter((i) => !before.includes(i.id) && i.title === title);
        if (added.length !== 1)
          throw new GoodnotesError(
            'AMBIGUOUS_CREATED_ITEM',
            'Cannot uniquely identify the created library item.',
          );
        return {
          verified: true,
          kind,
          title,
          url,
          itemPath: added[0].itemPath,
          writesAllowed: true,
          verification: 'document-and-library-reload',
        };
      },
      options,
    );
  }
  async manage({ action, itemPath, title, destinationPath = [], operationId }, options) {
    const parent = itemPath.slice(0, -1),
      id = itemPath.at(-1);
    return mutate(
      this.a,
      operationId,
      { action, itemPath, title, destinationPath },
      async (mark) => {
        const view = await this.a.openItem({ itemPath });
        if (action !== 'duplicate') requireWritable(this.a, view);
        if (title !== undefined && (!title.trim() || title.length > 150))
          throw new GoodnotesError(
            'INVALID_TITLE',
            'Use a non-empty title of at most 150 characters.',
          );
        const destinationNames = [];
        if (action === 'move') {
          for (let i = 0; i < destinationPath.length; i++) {
            const listing = await this.a.list({
              folderPath: destinationPath.slice(0, i),
              limit: 10000,
            });
            const folder = listing.items.find(
              (f) => f.id === destinationPath[i] && f.kind === 'folder',
            );
            if (!folder)
              throw new GoodnotesError(
                'FOLDER_NOT_FOUND',
                'The destination path no longer exists.',
              );
            destinationNames.push(folder.title);
          }
          if (JSON.stringify(parent) === JSON.stringify(destinationPath))
            return { verified: true, changed: false, itemPath, url: view.url, title: view.title };
        }
        const { page, listing } = await this.folder(parent);
        if (action === 'rename') {
          if (!title) throw new GoodnotesError('TITLE_REQUIRED', 'Provide the new title.');
          await this.renameCard(page, id, title, mark);
          const fresh = await this.a.openItem({ itemPath });
          if (fresh.title !== title || fresh.url !== view.url)
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'The new title was not confirmed after reopening.',
            );
          await this.allow(view.url, title);
          await this.a.documents.invalidate(view.url);
          return {
            verified: true,
            changed: title !== view.title,
            url: view.url,
            title,
            itemPath,
            verification: 'reopen-title',
          };
        }
        if (action === 'duplicate') {
          await this.menu(page, id);
          mark();
          await page.locator('#duplicateDocumentButton').click();
          const newId = await this.findNew(
              page,
              listing.items.map((i) => i.id),
            ),
            newPath = [...parent, newId];
          if (title) await this.renameCard(page, newId, title, mark);
          let copy = await this.a.openItem({ itemPath: newPath });
          await page.reload({ waitUntil: 'domcontentloaded' });
          copy = await this.a.inspect({ url: copy.url });
          if (title && copy.title !== title)
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'The duplicate title did not persist after reload. Inspect the new library item before retrying.',
            );
          if (copy.url === view.url)
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'The duplicate did not get an independent document URL.',
            );
          await this.allow(copy.url, copy.title);
          return {
            verified: true,
            url: copy.url,
            title: copy.title,
            itemPath: newPath,
            writesAllowed: true,
            verification: 'independent-document-open',
          };
        }
        if (action === 'move') {
          await this.menu(page, id);
          await page.locator('#libraryMoveId').click();
          await page.locator('#moveConfirmButton').waitFor({ state: 'visible' });
          const names = ['Documents', ...destinationNames];
          for (const name of names) {
            const target = page.locator(`[id=${JSON.stringify('moveModalItem_folder_' + name)}]`);
            await target.first().waitFor({ state: 'visible', timeout: 10000 });
            if ((await target.count()) !== 1)
              throw new GoodnotesError(
                'AMBIGUOUS_FOLDER',
                'Goodnotes identifies move destinations by name. Duplicate names are not safe to select.',
              );
            await target.click();
          }
          const confirm = page.locator('#moveConfirmButton');
          if (!(await confirm.isEnabled()))
            throw new GoodnotesError('MOVE_UNAVAILABLE', 'Goodnotes disabled this destination.');
          mark();
          await confirm.click();
          await confirm.waitFor({ state: 'detached' });
          const fresh = await this.a.list({ folderPath: destinationPath, limit: 10000 });
          if (!fresh.items.some((i) => i.id === id))
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'The item was not found in the destination after reloading.',
            );
          return {
            verified: true,
            title: view.title,
            url: view.url,
            itemPath: [...destinationPath, id],
            verification: 'destination-library-reload',
          };
        }
        throw new GoodnotesError('INVALID_ACTION', 'Choose rename, duplicate or move.');
      },
      options,
    );
  }
}
