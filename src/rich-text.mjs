// DOM-only readers are serialized into the isolated page by Playwright.
export function readPlainText(element) {
  const blocks = Array.from(element.children).flatMap((e) =>
    ['OL', 'UL'].includes(e.tagName) ? Array.from(e.children) : [e],
  );
  return blocks
    .map((p) => (p.textContent.replace(/\uFEFF/g, '') === '' ? '' : p.innerText))
    .join('\n')
    .replace(/\r\n?/g, '\n')
    .replace(/\uFEFF/g, '');
}
