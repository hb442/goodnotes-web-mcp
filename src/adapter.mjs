import crypto from 'node:crypto';
import { HOME_URL, ORIGIN, documentUrl } from './config.mjs';
import { Journal, digest } from './journal.mjs';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { DocumentController } from './documents.mjs';
import { LibraryController } from './library.mjs';
import { TextController, readRichText } from './text.mjs';
import { ObjectController } from './objects.mjs';
import { ObjectMoveController } from './object-move.mjs';
import { CatalogController } from './catalog.mjs';
import { JobController } from './jobs.mjs';
import { PageController } from './pages.mjs';
import { OutlineController } from './outlines.mjs';
import { PageRecoveryController } from './page-recovery.mjs';
import { BoardController } from './board.mjs';
import { WorkflowController } from './workflows.mjs';
import { ImageController } from './images.mjs';
import { ImageCropController } from './image-crop.mjs';
import { ShapeStyleController } from './shape-style.mjs';
import { TextBoxStyleController } from './text-box-style.mjs';
import { StyleController } from './styles.mjs';
import { collectScrollList } from './scroll-list.mjs';
import { BoardScanController } from './board-scan.mjs';
import { RecoveryController } from './recovery.mjs';
import { LayoutController } from './layout.mjs';
import { FolderController } from './folders.mjs';
import { FolderStyleController } from './folder-style.mjs';
import { StudyBoardController } from './study-board.mjs';
import { StudyRevisionController } from './study-revision.mjs';
import { BoardAdoptionController } from './board-adoption.mjs';
import { StudyCollectionController } from './study-collection.mjs';
import { TrashController } from './trash.mjs';
import { readPlainText } from './rich-text.mjs';
import { frameAtPoint } from './page-frame.mjs';
import { captureBoardViewport, restoreBoardViewport } from './viewport.mjs';
export { GoodnotesError } from './errors.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const EDITOR = '.ql-editor[contenteditable="true"]';
const TTL = 10 * 60 * 1000;

export class SerialQueue {
  tail = Promise.resolve();
  run(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
}
export function normalizeText(value) {
  return value.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '');
}
export function validPoint(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0.01 || x > 0.99 || y < 0.04 || y > 0.94)
    throw new GoodnotesError(
      'INVALID_POSITION',
      'Use a point inside the canvas: x 0.01–0.99, y 0.04–0.94.',
    );
}
export const readQuillText = readPlainText;
function sameGeometry(a, b) {
  return ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) < 2);
}

export class GoodnotesAdapter {
  constructor({ config, getPage, journal = new Journal(config.directory) }) {
    this.config = config;
    this.getPage = getPage;
    this.journal = journal;
    this.views = new Map();
    this.targets = new Map();
    this.nativeStickyEditors = new WeakSet();
    this.nativeShapeEditors = new WeakSet();
    this.readyDocuments = new WeakMap();
    this.documents = new DocumentController(this);
    this.library = new LibraryController(this);
    this.text = new TextController(this);
    this.objects = new ObjectController(this);
    this.objectMove = new ObjectMoveController(this);
    this.catalog = new CatalogController(this);
    this.jobs = new JobController(this);
    this.pages = new PageController(this);
    this.outlines = new OutlineController(this);
    this.pageRecovery = new PageRecoveryController(this);
    this.board = new BoardController(this);
    this.workflows = new WorkflowController(this);
    this.images = new ImageController(this);
    this.imageCrop = new ImageCropController(this);
    this.textBoxStyle = new TextBoxStyleController(this);
    this.shapeStyle = new ShapeStyleController(this);
    this.styles = new StyleController(this);
    this.scans = new BoardScanController(this);
    this.recovery = new RecoveryController(this);
    this.layout = new LayoutController(this);
    this.folders = new FolderController(this);
    this.folderStyle = new FolderStyleController(this);
    this.trash = new TrashController(this);
    this.study = new StudyBoardController(this);
    this.studyRevision = new StudyRevisionController(this);
    this.boardAdoption = new BoardAdoptionController(this);
    this.studyCollection = new StudyCollectionController(this);
  }
  async status() {
    const page = await this.getPage();
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
    await this.readyHome(page);
    this.invalidate();
    return {
      signedIn: true,
      mode: 'isolated-browser',
      desktopCapture: false,
      writeAllowlist: this.config.documents,
      capabilities: [
        'library-management',
        'authorized-folder-organization-and-style',
        'typed-text-and-formatting',
        'pdf-export',
        'document-text-search',
        'page-images',
        'local-ocr',
        'native-handwriting-conversion',
        'board-objects',
        'ink-drawing',
        'page-zoom-pan',
        'resumable-library-and-board-scans',
        'chained-batches-with-typed-references',
        'native-page-and-text-object-copy',
        'native-snapshots-and-restore-to-new-copy',
        'board-backgrounds-and-page-templates',
        'guarded-document-trash-and-restore',
        'sticky-layer-collapse-and-lock-controls',
      ],
      limitations: [
        'coordinates are relative to the current canvas',
        'PDF text recognition may omit handwriting or scans',
        'no remote iPad sync acknowledgement',
      ],
    };
  }
  invalidate() {
    this.views.clear();
    this.targets.clear();
    this.objects?.selections.clear();
    this.objects?.handwriting.clear();
    this.styles?.unlocks.clear();
    this.imageCrop?.preparations.clear();
    this.textBoxStyle?.preparations.clear();
  }
  async readyHome(page) {
    try {
      await page
        .locator('#homeSidebarDocumentsOptionId')
        .waitFor({ state: 'visible', timeout: 30000 });
    } catch {
      throw new GoodnotesError(
        'LOGIN_REQUIRED',
        'Sign in once using npm run login, then close the login window.',
      );
    }
    if (new URL(page.url()).origin !== ORIGIN)
      throw new GoodnotesError('WRONG_ORIGIN', 'Unexpected browser location.');
    // Goodnotes can keep telemetry requests open; network idle is only a settling hint.
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await this.dismissKnownPopups(page);
  }
  async dismissKnownPopups(page) {
    // Only harmless, explicitly recognized UI help overlays. Never accept permissions or terms.
    for (const label of ['Continue in browser', 'Im Browser fortfahren', 'Got it', 'Verstanden']) {
      const button = page.getByRole('button', { name: label, exact: true });
      if ((await button.count()) !== 1 || !(await button.isVisible())) continue;
      const bounds = await button.boundingBox({ timeout: 500 }).catch(() => null),
        viewport = page.viewportSize();
      // The dismissed app-launch banner remains mounted and is animated off-screen.
      if (
        !bounds ||
        bounds.x + bounds.width / 2 < 0 ||
        bounds.x + bounds.width / 2 >= viewport.width ||
        bounds.y + bounds.height / 2 < 0 ||
        bounds.y + bounds.height / 2 >= viewport.height
      )
        continue;
      await button.click({ timeout: 2000 }).catch(async (error) => {
        if ((await button.count()) === 0 || !(await button.isVisible())) return;
        const after = await button.boundingBox({ timeout: 500 }).catch(() => null);
        if (!after || after.y >= viewport.height || after.x >= viewport.width) return;
        throw error;
      });
    }
  }
  async list(args = {}) {
    try {
      return await this.listOnce(args);
    } catch (error) {
      if (error.code !== 'ITEM_NOT_FOUND') throw error;
      // Library cards can briefly lag behind the sidebar after a fresh login.
      // Restart only the read/navigation sequence; no cloud write is retried.
      const page = await this.getPage();
      await page.reload({ waitUntil: 'domcontentloaded' });
      return this.listOnce(args);
    }
  }
  async listOnce({ folderPath = [], limit = 30, offset = 0 } = {}) {
    const page = await this.getPage();
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
    await this.readyHome(page);
    await this.libraryRoot(page);
    this.invalidate();
    for (const id of folderPath) await this.enterItem(page, id, true);
    const scan = await collectScrollList(page, {
      selector: '[data-document-id]',
      read: () => this.readLibraryCards(page),
    });
    const items = scan.items;
    return {
      folderPath,
      items: items
        .slice(offset, offset + limit)
        .map((i) => ({ ...i, itemPath: [...folderPath, i.id] })),
      truncated: !scan.complete || items.length > offset + limit,
      scanComplete: scan.complete,
      scanReason: scan.reason,
      nextOffset: items.length > offset + limit ? offset + limit : null,
      totalVisible: items.length,
    };
  }
  async readLibraryCards(page) {
    return page.locator('[data-document-id]').evaluateAll((elements) =>
      elements.map((e) => {
        const title = e.querySelector(
          '[id^="libraryFolderTitle-"],[id^="libraryDocumentWhiteboardNameId-"],[id^="libraryDocumentNameId-"]',
        );
        const favoriteId = e.querySelector(
          '[id^="libraryDocumentNotebookFavorited_"],[id^="libraryDocumentFolderFavorited_"]',
        )?.id;
        return {
          id: e.getAttribute('data-document-id'),
          kind: e.getAttribute('data-document-type'),
          title: title?.textContent?.trim() || e.textContent.trim(),
          favorite: favoriteId?.endsWith('_true')
            ? true
            : favoriteId?.endsWith('_false')
              ? false
              : null,
          revisionHint:
            Array.from(e.querySelectorAll('time'))
              .map((t) => t.getAttribute('datetime') || t.textContent)
              .join('|') ||
            Array.from(e.querySelectorAll('p'))
              .filter(
                (p) =>
                  !p.children.length && p !== title && /\d{4}|\d{1,2}:\d{2}/.test(p.textContent),
              )
              .map((p) => p.textContent.trim())
              .join('|') ||
            null,
        };
      }),
    );
  }
  async enterItem(page, id, folder = false) {
    if (!UUID.test(id))
      throw new GoodnotesError('INVALID_ID', 'Use an item ID returned by goodnotes_list.');
    const item = page.locator(`[data-document-id="${id}"]`);
    // A fresh folder can briefly expose no rows, or a previous virtualized window.
    // Wait for a real list, then repeat only its read/scroll discovery if needed.
    await page
      .locator('[data-document-id],#library-no-documents-view-new-button')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });
    for (let attempt = 0; attempt < 3 && (await item.count()) === 0; attempt++) {
      await collectScrollList(page, {
        selector: '[data-document-id]',
        read: () => this.readLibraryCards(page),
        stopId: id,
        restore: false,
      });
      if (!(await item.count())) await page.waitForTimeout(500);
    }
    try {
      await item.waitFor({ state: 'attached', timeout: 15000 });
    } catch {
      throw new GoodnotesError('ITEM_NOT_FOUND', 'This item is not in the selected folder.', {
        itemId: id,
      });
    }
    // Virtualized rows can detach immediately after waitFor resolves. Zero is
    // transient: the strict getAttribute/dblclick locators below wait for it to
    // reattach. Multiple matching rows remain an immediate ambiguity error.
    if ((await item.count()) > 1)
      throw new GoodnotesError(
        'ITEM_NOT_FOUND',
        'This item is not uniquely visible in the selected folder.',
        { itemId: id, matches: await item.count() },
      );
    const kind = await item.getAttribute('data-document-type');
    if (folder && kind !== 'folder')
      throw new GoodnotesError(
        'NOT_A_FOLDER',
        'The path contains a document where a folder was expected.',
      );
    const previousIds = folder
      ? await page
          .locator('[data-document-id]')
          .evaluateAll((es) => es.map((e) => e.getAttribute('data-document-id')))
      : [];
    await item.dblclick();
    if (folder) {
      await item.waitFor({ state: 'detached', timeout: 15000 });
      await page.waitForFunction(
        (ids) =>
          Array.from(document.querySelectorAll('[data-document-id]')).every(
            (e) => !ids.includes(e.getAttribute('data-document-id')),
          ),
        previousIds,
        { timeout: 15000 },
      );
      await page
        .locator('[data-document-id],#library-no-documents-view-new-button')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
  }
  async libraryRoot(page) {
    const wasInside = await page
      .locator('#libraryBreadcrumbsBackButton')
      .isVisible()
      .catch(() => false);
    const old = wasInside
      ? await page
          .locator('[data-document-id]')
          .evaluateAll((es) => es.map((e) => e.getAttribute('data-document-id')))
      : [];
    await page.locator('#homeSidebarDocumentsOptionId').click();
    const back = page.locator('#libraryBreadcrumbsBackButton');
    await back.waitFor({ state: 'hidden', timeout: 10000 });
    if (old.length)
      await page.waitForFunction(
        (ids) =>
          Array.from(document.querySelectorAll('[data-document-id]')).every(
            (e) => !ids.includes(e.getAttribute('data-document-id')),
          ),
        old,
        { timeout: 15000 },
      );
    await page
      .locator('[data-document-id],#library-no-documents-view-new-button')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(200);
  }
  async openItem({ itemPath }) {
    if (!itemPath?.length)
      throw new GoodnotesError('INVALID_PATH', 'Provide the itemPath from goodnotes_list.');
    const page = await this.getPage();
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
    await this.readyHome(page);
    await this.libraryRoot(page);
    for (let i = 0; i < itemPath.length; i++)
      await this.enterItem(page, itemPath[i], i < itemPath.length - 1);
    await page.locator('#infoButton').waitFor({ state: 'visible', timeout: 30000 });
    await this.settledDocumentUrl(page);
    return this.inspect({ url: page.url() });
  }
  async openItemInApp({ itemPath }) {
    if (!itemPath?.length) throw new GoodnotesError('INVALID_PATH', 'Provide a library item path.');
    const page = await this.getPage();
    if (
      await page
        .locator('#editorBackButton')
        .isVisible()
        .catch(() => false)
    )
      await page.locator('#editorBackButton').click();
    await this.readyHome(page);
    await this.libraryRoot(page);
    for (let i = 0; i < itemPath.length; i++)
      await this.enterItem(page, itemPath[i], i < itemPath.length - 1);
    await page.locator('#infoButton').waitFor({ state: 'visible', timeout: 30000 });
    await this.settledDocumentUrl(page);
    return this.inspect({ url: page.url() });
  }
  async settledDocumentUrl(page) {
    // Newly opened/created documents first use a temporary UUID route, then a stable share ID.
    if (UUID.test(new URL(page.url()).pathname.split('/').at(-1))) {
      await page.waitForURL(
        (u) =>
          u.origin === ORIGIN &&
          u.pathname.startsWith('/s/') &&
          !UUID.test(u.pathname.split('/').at(-1)),
        { timeout: 30000 },
      );
    }
    return documentUrl(page.url());
  }
  async openDocument(url) {
    const canonical = documentUrl(url),
      page = await this.getPage();
    let current;
    try {
      current = documentUrl(page.url());
    } catch {}
    const requestedHash = new URL(url).hash;
    if (current !== canonical || (requestedHash && new URL(page.url()).hash !== requestedHash))
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    try {
      await page.locator('#infoButton').waitFor({ state: 'visible', timeout: 45000 });
    } catch {
      throw new GoodnotesError(
        'DOCUMENT_UNAVAILABLE',
        'The document editor did not load. Check login, access and the document URL.',
      );
    }
    if (documentUrl(page.url()) !== canonical)
      throw new GoodnotesError('WRONG_DOCUMENT', 'Goodnotes opened a different document.');
    if (requestedHash && new URL(page.url()).hash !== requestedHash)
      throw new GoodnotesError('WRONG_PAGE', 'Goodnotes did not open the requested page.');
    await this.dismissKnownPopups(page);
    // A reload has a new native time origin even when its URL is unchanged.
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    const ready = this.readyDocuments.get(page);
    const freshLoad = !ready || ready.timeOrigin !== timeOrigin || ready.url !== page.url();
    // The toolbar becomes visible before document data and the WebGL renderer are ready.
    // Wait for the initial resource burst, then allow the renderer to present its frame.
    try {
      if (freshLoad) await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      await page.locator('#paging-view-content').waitFor({ state: 'visible', timeout: 15000 });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      if (freshLoad) await page.waitForTimeout(500);
    } catch {
      throw new GoodnotesError(
        'DOCUMENT_NOT_READY',
        'The document did not finish loading. Inspect it again before editing.',
      );
    }
    this.readyDocuments.set(page, { url: page.url(), timeOrigin });
    await this.dismissKnownPopups(page);
    return page;
  }
  async closePanels(page) {
    for (const [panel, button] of [
      ['#searchDesktopSideBar', '#searchClose'],
      ['#sidebarContainer', '#sidebarButton'],
    ]) {
      const locator = page.locator(panel);
      if (await locator.count()) {
        const bounds = await locator.boundingBox();
        if (bounds && bounds.x + bounds.width > 1 && bounds.x < page.viewportSize().width) {
          await page.locator(button).click();
          await page.waitForFunction(
            (selector) => {
              const e = document.querySelector(selector);
              if (!e) return true;
              const r = e.getBoundingClientRect();
              return r.right <= 0 || r.width === 0;
            },
            panel,
            { timeout: 5000 },
          );
        }
      }
    }
  }
  async resetOuterScroll(page) {
    // Native focus/thumbnail clicks can scroll overflow:hidden BODY by a few pixels,
    // independently of window.scrollX and Goodnotes' internal board/page navigation.
    await page.evaluate(() => {
      for (const e of [document.body, document.documentElement])
        if (e && /hidden|clip/.test(getComputedStyle(e).overflow) && (e.scrollLeft || e.scrollTop))
          e.scrollTo(0, 0);
    });
  }
  async geometry(page) {
    const canvas = page.locator('#paging-view-content');
    await canvas.waitFor({ state: 'visible', timeout: 15000 });
    const bounds = await canvas.boundingBox();
    if (!bounds || bounds.width < 200 || bounds.height < 200)
      throw new GoodnotesError('CANVAS_UNAVAILABLE', 'The document canvas is not ready.');
    return {
      canvas: bounds,
      viewport: page.viewportSize(),
      zoom: await page
        .locator('#zoomLevelContainer')
        .innerText()
        .catch(() => null),
    };
  }
  async inspect({ url }) {
    const page = await this.openDocument(url);
    await this.closePanels(page);
    await this.resetOuterScroll(page);
    // Closing the sidebar can trigger a delayed fit-to-width zoom in notebooks.
    // Capture handles only after that native layout has settled.
    await page.waitForTimeout(350);
    const title = (await page.locator('#infoButton').innerText()).trim();
    let geometry = await this.geometry(page);
    for (let i = 0, stable = 0; i < 8 && stable < 2; i++) {
      await page.waitForTimeout(120);
      const next = await this.geometry(page);
      stable =
        next.zoom === geometry.zoom && sameGeometry(next.canvas, geometry.canvas) ? stable + 1 : 0;
      geometry = next;
      if (i === 7 && stable < 2)
        throw new GoodnotesError(
          'VIEW_UNSTABLE',
          'The native viewport is still changing. Inspect again before editing.',
        );
    }
    const viewId = crypto.randomUUID();
    this.invalidate();
    const view = {
      viewId,
      url: documentUrl(page.url()),
      pageUrl: page.url(),
      title,
      ...geometry,
      created: Date.now(),
    };
    this.views.set(viewId, view);
    return {
      viewId,
      url: view.url,
      title,
      page: Number(new URL(view.pageUrl).hash.replace('#page-', '')) || 1,
      viewport: view.viewport,
      canvas: view.canvas,
      zoom: view.zoom,
      writesAllowed: this.config.documents.some((d) => d.url === view.url && d.title === title),
      next: 'Use goodnotes_preview to choose a point, then goodnotes_read_text to prepare an exact text change.',
    };
  }
  getView(id) {
    const view = this.views.get(id);
    if (!view || Date.now() - view.created > TTL)
      throw new GoodnotesError(
        'STALE_VIEW',
        'Inspect the document again; the view expired or navigation changed.',
      );
    return view;
  }
  async assertView(view) {
    const page = await this.getPage();
    await this.resetOuterScroll(page);
    if (page.url() !== view.pageUrl)
      throw new GoodnotesError('STALE_VIEW', 'The page or document changed. Inspect it again.');
    const title = (await page.locator('#infoButton').innerText()).trim();
    const geometry = await this.geometry(page);
    if (
      title !== view.title ||
      geometry.zoom !== view.zoom ||
      !sameGeometry(geometry.canvas, view.canvas) ||
      JSON.stringify(geometry.viewport) !== JSON.stringify(view.viewport)
    )
      throw new GoodnotesError(
        'STALE_VIEW',
        'The document title, zoom or viewport changed. Inspect it again.',
        {
          expected: { zoom: view.zoom, canvas: view.canvas, viewport: view.viewport },
          actual: geometry,
        },
      );
    return page;
  }
  async preview({ viewId }) {
    const view = this.getView(viewId),
      page = await this.assertView(view);
    const bytes = await page.screenshot({ type: 'jpeg', quality: 70, animations: 'disabled' });
    return {
      bytes,
      description: {
        viewId,
        title: view.title,
        canvas: view.canvas,
        viewport: view.viewport,
        zoom: view.zoom,
      },
    };
  }
  async navigate({ viewId, page: pageNumber, zoomSteps = 0, panX = 0, panY = 0 }) {
    const view = this.getView(viewId),
      page = await this.assertView(view);
    if (pageNumber !== undefined) {
      await this.openDocument(view.url + '#page-' + pageNumber);
    }
    // Goodnotes hides the interactive zoom overlay behind its editing canvas.
    if (zoomSteps || panX || panY) await this.objects.readingMode(page);
    for (let i = 0; i < Math.abs(zoomSteps); i++) {
      const control = page.locator(zoomSteps > 0 ? '#increaseZoomButton' : '#decreaseZoomButton');
      const bounds = await control.boundingBox();
      if (!bounds) throw new GoodnotesError('ZOOM_UNAVAILABLE', 'The zoom control is not visible.');
      const before = await page.locator('#zoomLevelContainer').innerText();
      // The WASM canvas overlays the zoom controls in some editor states.
      // Activate the existing UI button's normal click handler; no private app API.
      if (!(await control.isEnabled()))
        throw new GoodnotesError('ZOOM_UNAVAILABLE', 'Goodnotes disabled this zoom direction.');
      await control.evaluate((button) => button.click());
      await page
        .waitForFunction(
          (value) => document.getElementById('zoomLevelContainer')?.innerText !== value,
          before,
          { timeout: 3000 },
        )
        .catch(() => {
          throw new GoodnotesError(
            'ZOOM_UNVERIFIED',
            'Goodnotes did not change the zoom level; it may be at its limit.',
          );
        });
    }
    if (panX || panY) {
      const canvas = await page.locator('#paging-view-content').boundingBox();
      await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
      await page.mouse.wheel(panX, panY);
    }
    await page.waitForTimeout(300);
    return this.inspect({ url: page.url() });
  }
  async syncStatus({ url } = {}) {
    const page = url ? await this.openDocument(url) : await this.getPage();
    if (!url) {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
      await this.readyHome(page);
    }
    this.invalidate();
    const text = await page.locator('body').innerText();
    const patterns = [
      /Your files are being moved from your iOS device to Goodnotes Cloud/g,
      /[^\n]*(?:offline|sync failed|syncing|couldn.t sync|unsynced|all changes saved)[^\n]*/gi,
    ];
    return {
      checkedAt: new Date().toISOString(),
      browserOnline: await page.evaluate(() => navigator.onLine),
      webLoaded: true,
      observedMessages: [...new Set(patterns.flatMap((p) => text.match(p) || []))].slice(0, 15),
      iPadDeliveryConfirmed: false,
      explanation:
        'This reports the Web app only. Reload verification does not prove delivery to an iPad; offline-download icons are not remote sync acknowledgements.',
    };
  }
  async openStickyEditor(page, view, x, y) {
    return this.openNativeTextEditor(page, view, x, y, 'sticky');
  }
  async openNativeTextEditor(page, view, x, y, kind) {
    await this.objects.commitSelection(page);
    await this.objects.tool(page, '#lassoToolButton');
    const px = view.canvas.x + x * view.canvas.width,
      py = view.canvas.y + y * view.canvas.height;
    const nativeControl = page.locator(
      kind === 'shape' ? '#shared_menu_options_edit_shape' : '#shared_menu_options_collapse',
    );
    let selected = false;
    // A notebook surface can mount before its objects arrive. These are only
    // bounded selection attempts; never repeat text or other document input.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) {
        await page.waitForTimeout(1500);
        await this.objects.commitSelection(page);
        await this.objects.tool(page, '#lassoToolButton');
      }
      await this.objects.clickCanvas(page, px, py);
      if (await nativeControl.isVisible().catch(() => false)) {
        selected = true;
        break;
      }
    }
    if (!selected)
      throw new GoodnotesError(
        'TEXT_CONFLICT',
        `The expected native ${kind} is no longer at this position. For an unfilled shape, select its border.`,
      );
    await page.locator('#object_menu_context_menu_option').click();
    await page.locator('#object_menu_context_shared_menu_options_edit_text').click();
    const editor = page.locator(EDITOR);
    await editor.waitFor({ state: 'visible', timeout: 5000 });
    if ((await editor.count()) !== 1)
      throw new GoodnotesError('AMBIGUOUS_EDITOR', 'Expected one native text editor.');
    if (kind === 'shape') this.nativeShapeEditors.add(page);
    else this.nativeStickyEditors.add(page);
    return editor;
  }
  async openTextBounds(page, view, bounds) {
    await this.objects.commitSelection(page);
    await this.objects.lasso(page, view, {
      x: (bounds.x - 10 - view.canvas.x) / view.canvas.width,
      y: (bounds.y - 10 - view.canvas.y) / view.canvas.height,
      width: (bounds.width + 20) / view.canvas.width,
      height: (bounds.height + 20) / view.canvas.height,
    });
    const sticky = await page
      .locator('#shared_menu_options_collapse')
      .isVisible()
      .catch(() => false);
    await page.locator('#object_menu_context_menu_option').click();
    await page.locator('#object_menu_context_shared_menu_options_edit_text').click();
    const editor = page.locator(EDITOR);
    await editor.waitFor({ state: 'visible', timeout: 5000 });
    if ((await editor.count()) !== 1)
      throw new GoodnotesError('AMBIGUOUS_EDITOR', 'Expected one editable text field.');
    if (sticky) this.nativeStickyEditors.add(page);
    return editor;
  }
  async selectEditor(
    page,
    view,
    x,
    y,
    allowStickyFallback = true,
    preferSticky = false,
    bounds,
    preferredKind,
  ) {
    validPoint(x, y);
    if (preferredKind === 'shape') return this.openNativeTextEditor(page, view, x, y, 'shape');
    if (bounds) return this.openTextBounds(page, view, bounds);
    if (preferSticky) return this.openStickyEditor(page, view, x, y);
    const button = page.locator('#textToolButton');
    const toolbar = page.locator('#editorTopbarTools');
    await toolbar.waitFor({ state: 'attached', timeout: 10000 });
    if (!(await toolbar.isVisible())) {
      const editMode = page.locator('#changeEditMode');
      if ((await editMode.count()) === 1 && (await editMode.isVisible())) {
        await editMode.click();
      }
    }
    await button.waitFor({ state: 'visible', timeout: 10000 });
    if ((await button.count()) !== 1)
      throw new GoodnotesError(
        'UNSUPPORTED_DOCUMENT',
        'This document does not expose the supported text tool.',
      );
    if ((await button.getAttribute('data-is-selected')) !== 'true') {
      await button.click();
      await page.waitForFunction(
        () =>
          document.getElementById('textToolButton')?.getAttribute('data-is-selected') === 'true',
        null,
        { timeout: 5000 },
      );
    }
    const px = view.canvas.x + x * view.canvas.width,
      py = view.canvas.y + y * view.canvas.height;
    await page.mouse.click(px, py);
    await this.dismissKnownPopups(page);
    let editor = page.locator(EDITOR);
    try {
      await editor.waitFor({ state: 'visible', timeout: 1200 });
    } catch {
      // A linked word opens Goodnotes' confirmation even with the text tool.
      // Never follow it. Locate the visible line and use the native Edit Text command.
      if (
        await page
          .getByText('External link', { exact: true })
          .isVisible()
          .catch(() => false)
      ) {
        await page.getByRole('button', { name: 'No', exact: true }).click();
        const found = await this.board.find({ viewId: view.viewId, minConfidence: 0 });
        const candidates = found.matches.filter(
          (m) =>
            px >= m.bounds.x - 10 &&
            px <= m.bounds.x + m.bounds.width + 10 &&
            py >= m.bounds.y - 10 &&
            py <= m.bounds.y + m.bounds.height + 10,
        );
        if (candidates.length !== 1)
          throw new GoodnotesError(
            'LINK_TEXT_UNLOCATED',
            'Cannot uniquely locate this linked text. Use a different point or a preview.',
          );
        const b = candidates[0].bounds;
        await this.objects.lasso(page, view, {
          x: (b.x - 10 - view.canvas.x) / view.canvas.width,
          y: (b.y - 10 - view.canvas.y) / view.canvas.height,
          width: (b.width + 20) / view.canvas.width,
          height: (b.height + 20) / view.canvas.height,
        });
        const sticky = await page
          .locator('#shared_menu_options_collapse')
          .isVisible()
          .catch(() => false);
        await page.locator('#object_menu_context_menu_option').click();
        await page.locator('#object_menu_context_shared_menu_options_edit_text').click();
        await editor.waitFor({ state: 'visible', timeout: 5000 });
        if (sticky) this.nativeStickyEditors.add(page);
        return editor;
      }
      await page.mouse.dblclick(px, py);
      await this.dismissKnownPopups(page);
      await editor.waitFor({ state: 'visible', timeout: 5000 });
    }
    if ((await editor.count()) !== 1)
      throw new GoodnotesError('AMBIGUOUS_EDITOR', 'Expected exactly one editable text box.');
    // The text tool creates an empty box over a native sticky instead of
    // entering its text. Use the sticky's explicit Edit Text command.
    if (allowStickyFallback && (await editor.evaluate(readQuillText)) === '') {
      await this.leaveEditor(page, editor);
      await this.objects.tool(page, '#lassoToolButton');
      await this.objects.clickCanvas(page, px, py);
      if (
        await page
          .locator('#shared_menu_options_collapse')
          .isVisible()
          .catch(() => false)
      ) {
        return this.openStickyEditor(page, view, x, y);
      } else return this.selectEditor(page, view, x, y, false);
    }
    return editor;
  }
  async leaveEditor(page, editor) {
    if (this.nativeStickyEditors.has(page) || this.nativeShapeEditors?.has(page)) {
      // First finish the text editor by clicking outside it, then commit the
      // still-selected native object. Escape alone can discard the edited text.
      if (await editor.isVisible()) {
        const box = await editor.boundingBox(),
          vp = page.viewportSize(),
          frame = await frameAtPoint(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }),
          left = Math.max(40, frame.x + 20),
          right = Math.min(vp.width - 140, frame.x + frame.width - 20),
          top = Math.max(160, frame.y + 20),
          bottom = Math.min(vp.height - 80, frame.y + frame.height - 20);
        const point = [
          { x: right, y: bottom },
          { x: left, y: bottom },
          { x: right, y: top },
          { x: left, y: top },
        ].find(
          (p) =>
            left < right &&
            top < bottom &&
            (p.x < box.x - 30 ||
              p.x > box.x + box.width + 30 ||
              p.y < box.y - 30 ||
              p.y > box.y + box.height + 30),
        );
        if (!point)
          throw new GoodnotesError(
            'EDITOR_COVERS_CANVAS',
            'Zoom out before editing this large native text object.',
          );
        await this.objects.clickCanvas(page, point.x, point.y);
      }
      await editor.waitFor({ state: 'hidden', timeout: 5000 });
      await this.objects.commitSelection(page);
      await page.waitForTimeout(500);
      this.nativeStickyEditors.delete(page);
      this.nativeShapeEditors?.delete(page);
      return;
    }
    // Escape commits the field and may switch Goodnotes into reading mode.
    // selectEditor restores editing through the visible mode control when needed.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await editor.isVisible().catch(() => false))) break;
      await editor.press('Escape');
      if (
        await page
          .locator(EDITOR)
          .waitFor({ state: 'hidden', timeout: 500 })
          .then(
            () => true,
            () => false,
          )
      )
        return;
    }
    await page.locator(EDITOR).waitFor({ state: 'hidden', timeout: 5000 });
  }
  async readText({ viewId, x, y, expectedKind }) {
    const view = this.getView(viewId),
      page = await this.assertView(view);
    const editor = await this.selectEditor(
      page,
      view,
      x,
      y,
      true,
      expectedKind === 'sticky',
      undefined,
      expectedKind,
    );
    const text = normalizeText(await editor.evaluate(readQuillText));
    const formatting = await editor.evaluate(readRichText);
    const editorBounds = await editor.boundingBox();
    const kind = this.nativeShapeEditors.has(page)
      ? 'shape'
      : this.nativeStickyEditors.has(page)
        ? 'sticky'
        : 'text-box';
    await this.leaveEditor(page, editor);
    if (expectedKind && expectedKind !== kind)
      throw new GoodnotesError(
        'OBJECT_KIND_CHANGED',
        'The native text object kind does not match the expected kind.',
      );
    const targetId = crypto.randomUUID();
    this.targets.set(targetId, {
      viewId,
      x,
      y,
      text,
      styleHash: digest(formatting),
      editorBounds,
      linked: formatting.some((r) => r.link),
      kind,
      created: Date.now(),
    });
    return {
      targetId,
      text,
      formatting,
      kind,
      characters: text.length,
      title: view.title,
      writable: this.config.documents.some((d) => d.url === view.url && d.title === view.title),
      expiresInSeconds: 600,
    };
  }
  editorKind(page) {
    return this.nativeShapeEditors.has(page)
      ? 'shape'
      : this.nativeStickyEditors.has(page)
        ? 'sticky'
        : 'text-box';
  }
  async checkEditorKind(page, editor, expectedKind) {
    if (expectedKind && this.editorKind(page) !== expectedKind) {
      await this.leaveEditor(page, editor);
      throw new GoodnotesError(
        'OBJECT_KIND_CHANGED',
        'The native text object kind changed since it was read.',
      );
    }
  }
  async writeText({ targetId, text, operationId }, { signal } = {}) {
    checkCancellation(signal);
    const target = this.targets.get(targetId);
    if (!target || Date.now() - target.created > TTL)
      throw new GoodnotesError('STALE_TARGET', 'Read the text field again before writing.');
    const view = this.getView(target.viewId);
    const allowed = this.config.documents.some((d) => d.url === view.url && d.title === view.title);
    if (!allowed)
      throw new GoodnotesError(
        'WRITE_NOT_ALLOWED',
        'This document is not on the local write allowlist. Add its URL and exact title with the allow command.',
      );
    const replacement = normalizeText(text);
    if (
      (!replacement.trim() && !(target.kind === 'shape' && replacement === '')) ||
      replacement.length > 8000
    )
      throw new GoodnotesError(
        'INVALID_TEXT',
        'Provide 1–8000 characters. Only an explicitly read native shape label may be cleared with an empty string; this does not delete text boxes or stickies.',
      );
    const input = {
      url: view.url,
      page: view.pageUrl,
      x: target.x,
      y: target.y,
      oldHash: digest(target.text),
      newHash: digest(replacement),
    };
    const existing = await this.journal.begin(operationId, input);
    if (!existing.fresh) return { ...existing.record.result, replayed: true };
    let mayHaveWritten = false;
    try {
      const page = await this.assertView(view);
      const editor = await this.selectEditor(
        page,
        view,
        target.x,
        target.y,
        true,
        target.kind === 'sticky',
        target.linked ? target.editorBounds : undefined,
        target.kind,
      );
      const checkpoint = await captureBoardViewport(page);
      const current = normalizeText(await editor.evaluate(readQuillText));
      await this.checkEditorKind(page, editor, target.kind);
      if (current !== target.text) {
        await this.leaveEditor(page, editor);
        throw new GoodnotesError(
          'TEXT_CONFLICT',
          'The text changed since it was read. No replacement was sent.',
        );
      }
      if (current === replacement) {
        await this.leaveEditor(page, editor);
        const result = {
          operationId,
          changed: false,
          verified: true,
          verification: 'fresh-read',
          characters: current.length,
          textHash: digest(current),
        };
        await this.journal.finish(operationId, 'verified', result);
        return result;
      }
      checkCancellation(signal);
      mayHaveWritten = true;
      await editor.press('ControlOrMeta+A');
      if (replacement === '') await editor.press('Backspace');
      const lines = replacement.split('\n');
      for (let i = 0; i < lines.length; i++) {
        checkCancellation(signal);
        if (i) await editor.press('Enter');
        // Bound how much input can be sent after a client cancellation.
        const points = Array.from(lines[i]);
        for (let offset = 0; offset < points.length; offset += 128) {
          checkCancellation(signal);
          await editor.pressSequentially(points.slice(offset, offset + 128).join(''));
        }
      }
      const entered = normalizeText(await editor.evaluate(readQuillText));
      if (entered !== replacement)
        throw new GoodnotesError(
          'INPUT_MISMATCH',
          'Goodnotes did not accept the exact text. Inspect the test document before continuing.',
        );
      await this.leaveEditor(page, editor);
      // Let the app settle, then verify through a fresh load and a fresh editor read.
      await page.waitForTimeout(1500);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await this.openDocument(view.pageUrl);
      await this.closePanels(page);
      await restoreBoardViewport(this, page, view, checkpoint, { signal });
      await this.assertView(view);
      const reopened = await this.selectEditor(
        page,
        view,
        target.x,
        target.y,
        true,
        target.kind === 'sticky',
        target.linked ? target.editorBounds : undefined,
        target.kind,
      );
      const saved = normalizeText(await reopened.evaluate(readQuillText));
      await this.checkEditorKind(page, reopened, target.kind);
      await this.leaveEditor(page, reopened);
      if (saved !== replacement)
        throw new GoodnotesError(
          'SAVE_UNVERIFIED',
          'The exact text could not be confirmed after reloading. Do not repeat this write blindly.',
        );
      const result = {
        operationId,
        changed: true,
        verified: true,
        verification: 'reload-and-read',
        characters: saved.length,
        textHash: digest(saved),
      };
      await this.journal.finish(operationId, 'verified', result);
      await this.documents.invalidate(view.url);
      return result;
    } catch (error) {
      if (mayHaveWritten) {
        const page = await this.getPage().catch(() => null);
        if (page && new URL(page.url()).origin === ORIGIN) {
          const editor = page.locator(EDITOR);
          if ((await editor.count()) === 1) await this.leaveEditor(page, editor).catch(() => {});
        }
      }
      await this.journal
        .finish(operationId, mayHaveWritten ? 'uncertain' : 'rejected', {
          code: error.code || 'ACTION_FAILED',
          mayHaveWritten,
        })
        .catch(() => {});
      if (mayHaveWritten)
        throw new GoodnotesError(error.code || 'WRITE_UNCERTAIN', error.message, {
          mayHaveWritten: true,
          operationId,
        });
      throw error;
    }
  }
}
