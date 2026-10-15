export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
/** Element.replaceChildren arrived after webOS 6's Chromium 79. */
export function replace(node: HTMLElement, ...children: HTMLElement[]): void {
  while (node.firstChild) node.removeChild(node.firstChild);
  node.append(...children);
}
const paths: Record<string, string> = {
  play: 'M8 5v14l11-7z', back: 'M19 12H5m7-7-7 7 7 7', episodes: 'M4 5h16v14H4z M8 2h8 M8 22h8 M10 9l5 3-5 3z',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z',
  info: 'M12 17v-5m0-4v.1 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  check: 'm5 12 4 4L19 6', chevron: 'm9 5 7 7-7 7',
  chevronLeft: 'm15 19-7-7 7-7', chevronRight: 'm9 5 7 7-7 7',
  live: 'M8 8a6 6 0 0 0 0 8m8-8a6 6 0 0 1 0 8 M4 4a11 11 0 0 0 0 16m16-16a11 11 0 0 1 0 16 M12 11v2',
  clock: 'M12 7v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  trailer: 'M3 8h18v12H3z M3 8V4h18v4 M7 4l3 4 M14 4l3 4 M10 11l5 3-5 3z',
  close: 'm6 6 12 12M6 18 18 6', plus: 'M12 5v14M5 12h14'
};
export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', name === 'play' ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name] || paths.info);
  svg.append(path);
  return svg;
}
export function button(label: string, glyph: string, className: string, action: () => void): HTMLButtonElement {
  const node = el('button', `tvl-button ${className}`);
  node.type = 'button';
  if (glyph) node.append(icon(glyph));
  node.append(el('span', '', label));
  node.addEventListener('click', action);
  return node;
}
export function picture(url: string | null, className: string, label = ''): HTMLElement {
  const wrap = el('div', className);
  if (url) {
    const image = el('img');
    image.src = url;
    image.alt = label;
    image.addEventListener('error', () => {image.remove(); wrap.classList.add('tvl-no-art');}, {once: true});
    wrap.append(image);
  } else wrap.classList.add('tvl-no-art');
  return wrap;
}

/**
 * Determines whether a click target inside a card is an action control
 * (e.g., play, favorite, mark played, 3-dots context menu, admin action, selection checkbox)
 * rather than clicking the card itself to open details.
 */
export function isCardAction(target: HTMLElement | null, card: HTMLElement): boolean {
  if (!target || target === card) return false;
  const innerButton = target.closest<HTMLElement>('button, [role="button"]');
  if (innerButton && innerButton !== card && card.contains(innerButton)) return true;
  const overlay = target.closest<HTMLElement>(
    '.cardOverlayButton, .cardOverlayFab, .cardOverlayContainer, ' +
    '.itemAction:not(.card), [data-action]:not([data-action="link"]), ' +
    '.btnPlay, .btnUserData, .btnUserRating, .btnCardOptions, .btnPlaystate, .btnMoreCommands, ' +
    '.itemSelectionPanel, .chkItemSelect, .checkboxContainer, .multiSelectCheckboxOutline, ' +
    '.tvl-admin-item, [data-admin-item]'
  );
  if (overlay && overlay !== card && card.contains(overlay)) return true;
  return false;
}

