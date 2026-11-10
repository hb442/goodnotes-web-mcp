import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { mutate, requireWritable } from './mutations.mjs';
import { GoodnotesError } from './errors.mjs';
import { documentUrl } from './config.mjs';
import { extractPdf, renderPdfPage } from './pdf.mjs';
import { compareRegion } from './visual.mjs';
import { digest } from './journal.mjs';
import { collectScrollList } from './scroll-list.mjs';

export function expectedPageOrder(ids, command, number, newId, destination) {
  const result = [...ids],
    index = number - 1;
  if (index < 0 || index >= ids.length)
    throw new GoodnotesError('INVALID_PAGE', 'Page is outside the document.');
  if (command === 'delete') result.splice(index, 1);
  if (command === 'duplicate' || command === 'add-after') result.splice(index + 1, 0, newId);
  if (command === 'add-before') result.splice(index, 0, newId);
  if (command === 'move') {
    if (!Number.isInteger(destination) || destination < 1 || destination > ids.length)
      throw new GoodnotesError(
        'INVALID_PAGE',
        'Destination is a final page position within this document.',
      );
    result.splice(index, 1);
    result.splice(destination - 1, 0, ids[index]);
  }
  return result;
}
export class PageController {
  constructor(adapter) {
    this.a = adapter;
  }
  async editMode(page) {
    const toolbar = page.locator('#editorTopbarTools');
    if (!(await toolbar.isVisible())) {
      const toggle = page.locator('#changeEditMode');
      if (!(await toggle.isVisible()) || !(await toggle.isEnabled()))
        throw new GoodnotesError(
          'EDIT_MODE_UNAVAILABLE',
          'Goodnotes does not allow editing this document.',
        );
      await toggle.click();
      await toolbar.waitFor({ state: 'visible' });
    }
  }
  async sidebar(page) {
    await this.a.closePanels(page);
    await page.locator('#sidebarButton').click();
    // Goodnotes remembers the last sidebar tab. Outlines have no thumbnails;
    // select the normal tab before waiting for a page row to exist.
    await page
      .locator('#filterOptionNormal:visible,#thumbnailEditing_0:visible')
      .first()
      .waitFor({ state: 'visible' });
    if (
      await page
        .locator('#filterOptionNormal')
        .isVisible()
        .catch(() => false)
    )
      await page.locator('#filterOptionNormal').click();
    await page.locator('#thumbnailEditing_0').waitFor({ state: 'attached' });
    // Avoid scrolling thumbnail ancestors while the sidebar is sliding into place.
    await page.waitForTimeout(550);
  }
  async snapshot(page) {
    const indicator = page.locator('#pageIndicator');
    const label = (await indicator.count()) ? await indicator.innerText() : '';
    const addPage = page.locator('#addPageAtTheEndButton');
    const board =
      ((await addPage.count()) ? await addPage.innerText() : '') === 'Add Board' ||
      (!(await indicator.count()) &&
        (await page.locator('[id^="interaction-layer-page-"]').evaluateAll((es) =>
          es.some((e) => {
            const b = e.getBoundingClientRect();
            return b.width > 10000 && b.height > 10000;
          }),
        )));
    let count = Number(label.match(/of\s+(\d+)/)?.[1]);
    const scan = await collectScrollList(page, {
      selector: '[id^="sidebarContent_"]',
      maxItems: 2000,
      read: () =>
        page.locator('[id^="sidebarContent_"]').evaluateAll((es) =>
          es
            .map((e) => ({
              page: Number(e.id.split('_').at(-1)) + 1,
              id: e.getAttribute('data-testid'),
            }))
            .sort((a, b) => a.page - b.page),
        ),
    });
    const pages = scan.items.sort((a, b) => a.page - b.page);
    if (!count && board) count = pages.length;
    if (
      !scan.complete ||
      !count ||
      count !== pages.length ||
      pages.some((p, i) => p.page !== i + 1 || !/^[a-f0-9-]{36}$/i.test(p.id)) ||
      new Set(pages.map((p) => p.id)).size !== count
    )
      throw new GoodnotesError(
        'PAGE_LIST_INCOMPLETE',
        'Cannot verify the complete page order in this document. No page mutation is safe with an incomplete sidebar.',
      );
    return { count, pages, orderHash: digest(pages.map((p) => p.id)) };
  }
  async list({ url }) {
    const page = await this.a.openDocument(url);
    await this.sidebar(page);
    this.a.invalidate();
    return {
      url: documentUrl(page.url()),
      title: (await page.locator('#infoButton').innerText()).trim(),
      ...(await this.snapshot(page)),
    };
  }
  async menu(page, number) {
    if (!(await page.locator(`#sidebarThumbnail_${number - 1}`).count())) {
      await collectScrollList(page, {
        selector: '[id^="sidebarContent_"]',
        key: 'page',
        stopId: number,
        restore: false,
        read: () =>
          page
            .locator('[id^="sidebarContent_"]')
            .evaluateAll((es) => es.map((e) => ({ page: Number(e.id.split('_').at(-1)) + 1 }))),
      });
    }
    const thumbnail = page.locator(`#sidebarThumbnail_${number - 1}`);
    const visible = await thumbnail.boundingBox(),
      vp = page.viewportSize();
    if (
      !visible ||
      visible.x < 0 ||
      visible.y < 48 ||
      visible.x + visible.width > vp.width ||
      visible.y + visible.height > vp.height
    )
      await thumbnail.scrollIntoViewIfNeeded();
    await page.locator(`#thumbnailEditing_${number - 1}`).click();
  }
  async manage(
    {
      url,
      command,
      page: number,
      expectedPageCount,
      expectedOrderHash,
      destination,
      title,
      operationId,
    },
    options,
  ) {
    const a = this.a;
    return mutate(
      a,
      operationId,
      {
        action: 'page-management',
        url: documentUrl(url),
        command,
        number,
        expectedPageCount,
        expectedOrderHash,
        destination,
        title,
      },
      async (mark) => {
        const page = await a.openDocument(url),
          view = {
            url: documentUrl(page.url()),
            title: (await page.locator('#infoButton').innerText()).trim(),
          };
        requireWritable(a, view);
        await this.sidebar(page);
        a.invalidate();
        const before = await this.snapshot(page),
          ids = before.pages.map((p) => p.id);
        if (
          before.count !== expectedPageCount ||
          (expectedOrderHash && expectedOrderHash !== before.orderHash)
        )
          throw new GoodnotesError(
            'PAGE_CONFLICT',
            'The page count or order changed. List pages again.',
          );
        expectedPageOrder(ids, command, number, 'new', destination);
        if (command === 'delete' && before.count === 1)
          throw new GoodnotesError('LAST_PAGE', 'The last page cannot be deleted.');
        if (command === 'outline' && !title?.trim())
          throw new GoodnotesError('TITLE_REQUIRED', 'An outline entry needs a title.');
        if (
          ![
            'duplicate',
            'delete',
            'add-before',
            'add-after',
            'rotate',
            'outline',
            'move',
            'bookmark',
            'unbookmark',
          ].includes(command)
        )
          throw new GoodnotesError('INVALID_ACTION', 'Unsupported page command.');
        let rotationBefore, deletion;
        if (command === 'delete') {
          const backup = await a.documents.exportPdf({ url: view.url }, options);
          if (
            backup.pageCount !== before.count ||
            backup.url !== view.url ||
            backup.title !== view.title
          )
            throw new GoodnotesError(
              'BACKUP_UNVERIFIED',
              'The pre-delete export must contain every page of the exact document.',
            );
          await this.sidebar(page);
          if ((await page.locator('#infoButton').innerText()).trim() !== view.title)
            throw new GoodnotesError(
              'TITLE_CONFLICT',
              'The document title changed while saving its backup.',
            );
          requireWritable(a, view);
          if ((await this.snapshot(page)).orderHash !== before.orderHash)
            throw new GoodnotesError(
              'PAGE_CONFLICT',
              'Page order changed while saving the pre-delete backup.',
            );
          deletion = await a.pageRecovery.checkpoint({
            operationId,
            view,
            order: ids,
            page: number,
            backupExportId: backup.exportId,
          });
        }
        if (command === 'rotate') {
          // Thumbnail canvases have a fixed aspect ratio even when the PDF page rotates.
          const exported = await a.documents.exportPdf({ url: view.url }, options);
          const { index } = await a.documents.get(exported.exportId);
          rotationBefore = index.pages[number - 1];
          if (Math.abs(rotationBefore.width - rotationBefore.height) < 1)
            throw new GoodnotesError(
              'ROTATION_UNVERIFIABLE',
              'Square page rotation cannot be verified from dimensions.',
            );
          await this.sidebar(page);
          if ((await this.snapshot(page)).orderHash !== before.orderHash)
            throw new GoodnotesError('PAGE_CONFLICT', 'Page order changed before rotation.');
        }
        await this.editMode(page);
        if (command === 'bookmark' || command === 'unbookmark') {
          await this.menu(page, number);
          await page.keyboard.press('Escape');
          const wanted = command === 'bookmark',
            current = page.locator(`#pageBookmark_${number - 1}_${wanted}`);
          if (await current.count())
            return { verified: true, changed: false, url: view.url, command, ...before };
          const toggle = page.locator(`#pageBookmark_${number - 1}_${!wanted}`);
          await toggle.waitFor({ state: 'attached' });
          mark();
          await toggle.click();
        } else if (command === 'move') {
          if (number === destination) return { verified: true, changed: false, ...before };
          const from = page.locator(`#sidebarContent_${number - 1}`),
            to = page.locator(`#sidebarThumbnail_${destination - 1}`);
          await from.scrollIntoViewIfNeeded();
          const box = await from.boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          mark();
          await page.mouse.down();
          try {
            await page.waitForTimeout(300);
            await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 12, {
              steps: 8,
            });
            await to.scrollIntoViewIfNeeded();
            const target = await to.boundingBox();
            await page.mouse.move(
              target.x + target.width / 2,
              number < destination ? target.y + target.height - 3 : target.y + 3,
              { steps: 25 },
            );
            await page.waitForTimeout(500);
          } finally {
            await page.mouse.up();
          }
        } else {
          await this.menu(page, number);
          const selector = {
            duplicate: '#duplicatePageItem',
            delete: '#moveToTrash',
            'add-before': '#addBefore',
            'add-after': '#addAfter',
            rotate: '#rotatePage',
            outline: '#addToOutline',
          }[command];
          if (command.startsWith('add-')) {
            await page.locator(selector).click();
            mark();
            await page.locator('#add-page-current-template').click();
          } else if (command === 'outline') {
            await page.locator(selector).click();
            await page.locator('#addOutlineInput').fill(title);
            mark();
            await page.locator('#addOutlineConfirmButton').click();
          } else {
            mark();
            await page.locator(selector).click();
            if (command === 'delete') {
              const confirm = page.locator('#confirmTrash');
              await confirm.waitFor({ state: 'visible' });
              mark();
              await confirm.click();
              await confirm.waitFor({ state: 'hidden' });
            }
          }
        }
        await page.waitForTimeout(1200);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await a.openDocument(view.url);
        await this.sidebar(page);
        const after = await this.snapshot(page),
          afterIds = after.pages.map((p) => p.id),
          added = afterIds.filter((id) => !ids.includes(id));
        if (['duplicate', 'add-before', 'add-after'].includes(command) && added.length !== 1)
          throw new GoodnotesError('SAVE_UNVERIFIED', 'Expected exactly one new page.');
        const expected = expectedPageOrder(ids, command, number, added[0], destination);
        if (JSON.stringify(expected) !== JSON.stringify(afterIds))
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Page identities/order did not match after reload.',
          );
        if (command === 'rotate') {
          const exported = await a.documents.exportPdf({ url: view.url }, options),
            { index } = await a.documents.get(exported.exportId),
            dimensions = index.pages[number - 1];
          if (
            Math.abs(dimensions.width - rotationBefore.height) > 1 ||
            Math.abs(dimensions.height - rotationBefore.width) > 1
          )
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'Rotation cannot be confirmed from exported page dimensions.',
            );
        }
        if (command === 'outline') {
          await page.locator('#filterOptionOutlines').click();
          await page.getByText(title, { exact: true }).last().waitFor({ state: 'visible' });
        }
        if (command === 'bookmark' || command === 'unbookmark') {
          await this.menu(page, number);
          await page.keyboard.press('Escape');
          await page
            .locator(`#pageBookmark_${number - 1}_${command === 'bookmark'}`)
            .waitFor({ state: 'attached' });
        }
        await a.documents.invalidate(view.url);
        return {
          verified: true,
          verification: 'stable-page-identities-and-order-after-reload',
          url: view.url,
          command,
          ...after,
          ...(deletion || {}),
        };
      },
      options,
    );
  }
  async importPdf({ filePath, title, folderPath = [], operationId }, options) {
    if (!path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.pdf')
      throw new GoodnotesError('INVALID_FILE', 'Provide an absolute local PDF path.');
    const absolute = await fs.realpath(filePath),
      info = await extractPdf(absolute, options),
      bytes = await fs.readFile(absolute);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!title?.trim() || title.length > 150)
      throw new GoodnotesError('INVALID_TITLE', 'Provide a title of 1–150 characters.');
    return mutate(
      this.a,
      operationId,
      { action: 'import-pdf', sha256, title, folderPath },
      async (mark) => {
        const { page, listing } = await this.a.library.folder(folderPath);
        await page.getByRole('button', { name: 'New', exact: true }).click();
        const pending = page.waitForEvent('filechooser');
        pending.catch(() => {});
        await page.locator('#libraryImportNewDocumentMenuOption').click();
        const chooser = await pending;
        mark();
        await chooser.setFiles({
          name: title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + '.pdf',
          mimeType: 'application/pdf',
          buffer: bytes,
        });
        // Some versions open the import; others remain in the library.
        await page.waitForFunction(
          (old) =>
            document.querySelector('#infoButton') ||
            Array.from(document.querySelectorAll('[data-document-id]')).some(
              (e) => !old.includes(e.getAttribute('data-document-id')),
            ),
          listing.items.map((i) => i.id),
          { timeout: 60000 },
        );
        await page.waitForTimeout(1200);
        const fresh = await this.a.list({ folderPath, limit: 10000 }),
          old = new Set(listing.items.map((i) => i.id)),
          added = fresh.items.filter((i) => !old.has(i.id));
        if (added.length !== 1)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Cannot uniquely identify the imported document.',
          );
        const item = added[0];
        if (item.title !== title) {
          await this.a.library.renameCard(page, item.id, title, mark);
        }
        const view = await this.a.openItem({ itemPath: item.itemPath });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await this.a.openDocument(view.url);
        await this.sidebar(page);
        const snapshot = await this.snapshot(page);
        if (snapshot.count !== info.pageCount)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Imported page count differs from the local PDF.',
          );
        await this.a.library.allow(view.url, title);
        return {
          verified: true,
          verification: 'import-title-and-page-count-after-reload',
          url: view.url,
          title,
          itemPath: item.itemPath,
          pageCount: snapshot.count,
          sourceSha256: sha256,
          writesAllowed: true,
        };
      },
      options,
    );
  }

  async copyNative(
    {
      sourceUrl,
      sourcePage,
      expectedSourceOrderHash,
      destinationPath,
      destinationPage,
      placement = 'after',
      expectedPageCount,
      expectedOrderHash,
      operationId,
    },
    options,
  ) {
    const a = this.a;
    return mutate(
      a,
      operationId,
      {
        action: 'copy-native-page',
        sourceUrl: documentUrl(sourceUrl),
        sourcePage,
        expectedSourceOrderHash,
        destinationPath,
        destinationPage,
        placement,
        expectedPageCount,
        expectedOrderHash,
      },
      async (mark) => {
        const destination = await a.openItem({ itemPath: destinationPath });
        requireWritable(a, destination);
        if (destination.url === documentUrl(sourceUrl))
          throw new GoodnotesError('SAME_DOCUMENT', 'Use duplicate within the same document.');
        const before = await this.list({ url: destination.url });
        if (before.count !== expectedPageCount || before.orderHash !== expectedOrderHash)
          throw new GoodnotesError(
            'PAGE_CONFLICT',
            'Destination page identities changed. List pages again.',
          );
        if (
          destinationPage < 1 ||
          destinationPage > before.count ||
          !['before', 'after'].includes(placement)
        )
          throw new GoodnotesError(
            'INVALID_PAGE',
            'Choose an existing destination page and before/after.',
          );
        const source = await this.list({ url: sourceUrl });
        if (
          source.orderHash !== expectedSourceOrderHash ||
          sourcePage < 1 ||
          sourcePage > source.count
        )
          throw new GoodnotesError(
            'PAGE_CONFLICT',
            'Source page identities changed. List pages again.',
          );
        const sourceExport = await a.documents.exportPdf({ url: sourceUrl }, options),
          sourcePdf = await a.documents.get(sourceExport.exportId);
        const page = await a.getPage();
        await this.sidebar(page);
        if ((await this.snapshot(page)).orderHash !== source.orderHash)
          throw new GoodnotesError('PAGE_CONFLICT', 'Source changed before copying.');
        await this.menu(page, sourcePage);
        await page.locator('#copyPage').click();
        await page.locator('#copy-page-succeeded').waitFor({ state: 'visible', timeout: 15000 });
        // The native clipboard belongs to this application session. A full navigation clears it.
        const reached = await a.openItemInApp({ itemPath: destinationPath });
        if (reached.url !== destination.url)
          throw new GoodnotesError('WRONG_DOCUMENT', 'Destination path now points elsewhere.');
        requireWritable(a, reached);
        await this.sidebar(page);
        if ((await this.snapshot(page)).orderHash !== before.orderHash)
          throw new GoodnotesError('PAGE_CONFLICT', 'Destination changed while copying.');
        await this.editMode(page);
        await this.menu(page, destinationPage);
        await page.locator(placement === 'after' ? '#addAfter' : '#addBefore').click();
        await page.locator('#pastePage').waitFor({ state: 'visible', timeout: 10000 });
        mark();
        await page.locator('#pastePage').click();
        await page.waitForTimeout(1500);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await a.openDocument(destination.url);
        await this.sidebar(page);
        const after = await this.snapshot(page),
          oldIds = before.pages.map((p) => p.id),
          newIds = after.pages.map((p) => p.id),
          added = newIds.filter((id) => !oldIds.includes(id));
        const index = destinationPage - (placement === 'before' ? 1 : 0),
          expected = [...oldIds];
        expected.splice(index, 0, added[0]);
        if (added.length !== 1 || JSON.stringify(newIds) !== JSON.stringify(expected))
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Expected exactly one copied page at the requested position.',
          );
        const destinationExport = await a.documents.exportPdf({ url: destination.url }, options),
          destinationPdf = await a.documents.get(destinationExport.exportId);
        const left = sourcePdf.index.pages[sourcePage - 1],
          right = destinationPdf.index.pages[index];
        if (
          left.text !== right.text ||
          Math.abs(left.width - right.width) > 0.1 ||
          Math.abs(left.height - right.height) > 0.1
        )
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Copied page text or dimensions differ from the source export.',
          );
        const l = await renderPdfPage(sourcePdf.record.path, sourcePage, { maxDimension: 1200 }),
          r = await renderPdfPage(destinationPdf.record.path, index + 1, { maxDimension: 1200 });
        const appearance = await compareRegion(l.bytes, r.bytes, {
          x: 0,
          y: 0,
          width: l.width,
          height: l.height,
        });
        if (l.width !== r.width || l.height !== r.height || !appearance.matches)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Copied page appearance differs from the source export.',
          );
        const sourceAfter = await this.list({ url: sourceUrl });
        if (sourceAfter.orderHash !== source.orderHash)
          throw new GoodnotesError(
            'SOURCE_CHANGED',
            'Source page order changed during copy. Destination may already contain the copy.',
          );
        await a.documents.invalidate(destination.url);
        return {
          verified: true,
          verification: 'native-paste-page-identities-text-and-rendered-appearance',
          url: destination.url,
          page: index + 1,
          pageId: added[0],
          count: after.count,
          orderHash: after.orderHash,
          sourceUrl: source.url,
          sourcePage,
          sourceUnchangedOrder: true,
          appearance,
          note: 'Used Goodnotes native Copy Page / Paste Page, preserving native content. No source page was removed.',
        };
      },
      options,
    );
  }
}
