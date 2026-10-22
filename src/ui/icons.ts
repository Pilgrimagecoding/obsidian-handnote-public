/**
 * Inline SVG icons (24 × 24, stroke = currentColor). Drawn for HandNote so the toolbar looks the
 * same inside Obsidian and in the standalone lab, independent of the host's icon set.
 */
const P: Record<string, string> = {
  pen: '<path d="M4 20l1.2-4.6L15.6 5a2.1 2.1 0 013 3L8.2 18.4z"/><path d="M13.6 7l3.4 3.4"/>',
  fountain:
    '<path d="M12 2.8c2.6 2.9 4.6 5.9 4.6 8.8L12 21.2l-4.6-9.6c0-2.9 2-5.9 4.6-8.8z"/><path d="M12 12.2v5"/><circle cx="12" cy="10.6" r="1.3"/>',
  pencil: '<path d="M4.5 19.5l1.6-5.2L15.8 4.6l3.6 3.6-9.7 9.7z"/><path d="M13.8 6.6l3.6 3.6"/><path d="M6.1 14.3l3.6 3.6" />',
  highlighter: '<path d="M8.5 14.5l-3 5.5h6.2l1.3-2.6"/><path d="M8 14.2l7.6-10.7 5 3.6-7.6 10.7z"/>',
  shapepen: '<path d="M3.5 20.5l1-3.8 8.6-8.6 2.8 2.8-8.6 8.6z"/><rect x="14.5" y="3" width="6.5" height="6.5" rx="1"/>',
  eraser: '<path d="M8.5 20h11"/><path d="M4.8 15.6l9.4-9.4a2 2 0 012.8 0l2.9 2.9a2 2 0 010 2.8L12.4 19.4a2 2 0 01-1.4.6H9.2a2 2 0 01-1.4-.6z"/><path d="M9.3 11.1l5.6 5.6"/>',
  text: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M8 8.5h8M12 8.5v8"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="15.5" cy="9.5" r="1.6"/><path d="M4 17l4.8-4.8 3.7 3.7 2.7-2.7 4.6 4.6"/>',
  shapes: '<circle cx="9" cy="9" r="5.2"/><rect x="11.5" y="11.5" width="9" height="9" rx="1.5"/>',
  undo: '<path d="M9 14.5L4 9.5l5-5"/><path d="M4.5 9.5H14a6 6 0 010 12h-3"/>',
  redo: '<path d="M15 14.5l5-5-5-5"/><path d="M19.5 9.5H10a6 6 0 000 12h3"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  'chevron-up': '<path d="M6 15l6-6 6 6"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'page-before': '<path d="M9 5.5h7l3 3v12H9z"/><path d="M16 5.5v3h3"/><path d="M5 9v6M2 12h6"/>',
  'page-after': '<path d="M5 5.5h7l3 3v12H5z"/><path d="M12 5.5v3h3"/><path d="M19 9v6M16 12h6"/>',
  rotate: '<path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 4.5V11h-6.5"/>',
  'move-to': '<path d="M5 4.5h9v15H5z"/><path d="M12 12h9M18 9l3 3-3 3"/>',
  'page-clear': '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M9.5 12.5l5 5M14.5 12.5l-5 5"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5a1.5 1.5 0 00-1.5-1.5h-9A1.5 1.5 0 004 5.5v9A1.5 1.5 0 005.5 16H8"/><path d="M14 11v6M11 14h6"/>',
  'page-add': '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M12 11v6M9 14h6"/>',
  'page-remove': '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M9 14h6"/>',
  template: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M4 8.5h16M9 8.5v12"/>',
  'fit-width': '<path d="M4 12h16"/><path d="M7.5 8.5L4 12l3.5 3.5M16.5 8.5L20 12l-3.5 3.5"/>',
  'fit-page': '<rect x="6" y="4" width="12" height="16" rx="1.5"/><path d="M3 9V4h5M21 9V4h-5M3 15v5h5M21 15v5h-5"/>',
  export: '<path d="M12 3.5v11"/><path d="M8 7.5l4-4 4 4"/><path d="M5 13.5v6h14v-6"/>',
  trash: '<path d="M4.5 6.5h15"/><path d="M9 6.5V4.5h6v2"/><path d="M6.5 6.5l1 13h9l1-13"/>',
  cut: '<circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/><path d="M8.3 15.7L18 4M15.7 15.7L6 4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 00-1.5-1.5H6A1.5 1.5 0 004.5 6v8A1.5 1.5 0 006 15.5h2.5"/>',
  paste: '<rect x="5.5" y="5" width="13" height="16" rx="2"/><path d="M9 5V3.5h6V5"/>',
  crop: '<path d="M6.5 2.5v14a1 1 0 001 1h14"/><path d="M2.5 6.5h14a1 1 0 011 1v14"/>',
  share: '<path d="M12 3.5v11"/><path d="M8 7.5l4-4 4 4"/><path d="M7.5 10.5H6a1.5 1.5 0 00-1.5 1.5v7A1.5 1.5 0 006 20.5h12a1.5 1.5 0 001.5-1.5v-7a1.5 1.5 0 00-1.5-1.5h-1.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  line: '<path d="M5 19L19 5"/>',
  arrow: '<path d="M5 19L19 5"/><path d="M10 5h9v9"/>',
  elbow: '<path d="M4 18.5h8v-12h7"/><path d="M16 3.5l3.5 3-3.5 3"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="0.5"/>',
  roundrect: '<rect x="4" y="6" width="16" height="12" rx="3.5"/>',
  ellipse: '<circle cx="12" cy="12" r="8"/>',
  triangle: '<path d="M12 4.5l8.5 15h-17z"/>',
  diamond: '<path d="M12 3l9 9-9 9-9-9z"/>',
  fill: '<path d="M12 3.5c3.2 4 6 7 6 10.5a6 6 0 01-12 0c0-3.5 2.8-6.5 6-10.5z"/>',
  bold: '<path d="M7 4.5h6a3.6 3.6 0 010 7.2H7z"/><path d="M7 11.7h7a3.9 3.9 0 010 7.8H7z"/>',
  italic: '<path d="M10.5 4.5h7M6.5 19.5h7M14 4.5l-4 15"/>',
  'align-left': '<path d="M4 6h16M4 10.5h10M4 15h16M4 19.5h10"/>',
  'align-center': '<path d="M4 6h16M7 10.5h10M4 15h16M7 19.5h10"/>',
  'align-right': '<path d="M4 6h16M10 10.5h10M4 15h16M10 19.5h10"/>',
  sliders: '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  finger: '<path d="M9 11.5V5a1.5 1.5 0 013 0v6M12 10.5V8.5a1.5 1.5 0 013 0V11M15 11a1.5 1.5 0 013 0v4.5a6 6 0 01-6 6h-.8a6 6 0 01-5-2.7L4 15.2a1.5 1.5 0 012.6-1.5L9 15.5"/>',
  tablet: '<rect x="4.5" y="3" width="15" height="18" rx="2.5"/><path d="M10.5 17.5h3"/>',
  pulse: '<path d="M3 12h4l3-7.5 4 15 3-7.5h4"/>',
  grain: '<circle cx="6" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="18" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="6" cy="19" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="18" r="1" fill="currentColor" stroke="none"/><circle cx="18.5" cy="17" r="1" fill="currentColor" stroke="none"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/>',
  tap: '<circle cx="12" cy="12" r="3"/><path d="M12 4.5a7.5 7.5 0 017.5 7.5M4.5 12A7.5 7.5 0 0112 4.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
  sizes: '<circle cx="6" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/><circle cx="19" cy="12" r="3.6" fill="currentColor"/>',
  stroke: '<path d="M4 12h16" stroke-width="3"/>',
  pages: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  lasso: '<path d="M7 16.5c-2.6-1.2-4-3-4-5.2C3 7.3 7 4 12 4s9 3.3 9 7.3-4 7.2-9 7.2c-1 0-2-.1-2.9-.4" stroke-dasharray="2.6 2.4"/><path d="M8.6 15.4c1.4.4 2 1.6 1.2 2.7-.8 1.2-2.6 1.4-3.6.6"/><path d="M7.2 18.7l-.6 2.3"/>',
  'lasso-rect': '<rect x="3.5" y="4.5" width="17" height="13" rx="1" stroke-dasharray="2.6 2.4"/><path d="M14 15.5l5 5M14 15.5v4M14 15.5h4"/>',
  laser: '<circle cx="16.5" cy="7.5" r="3" fill="currentColor" stroke="none" opacity="0.9"/><circle cx="16.5" cy="7.5" r="5" opacity="0.35"/><path d="M3.5 20.5l8-8"/><path d="M5.5 16.5l2 2"/>',
  'laser-dot': '<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="6.5" opacity="0.4"/>',
  'laser-trail': '<path d="M3.5 17c3-6 6-8 9-5s5.5 1 8-5" opacity="0.55"/><circle cx="20.2" cy="6.6" r="2.2" fill="currentColor" stroke="none"/>',
  'stroke-solid': '<path d="M3.5 12h17" stroke-width="2.4"/>',
  'stroke-dash': '<path d="M3.5 12h17" stroke-width="2.4" stroke-dasharray="4.2 3"/>',
  'stroke-dot': '<path d="M4 12h16.5" stroke-width="2.8" stroke-dasharray="0.1 4.4"/>',
  curve: '<path d="M4.5 19.5C6 9 13 5 19.5 5.5"/><path d="M14.6 3.7l4.9 1.8-2.6 4.4"/>',
  polyline: '<path d="M4 18l5-9 5 6 6-10"/>',
  group: '<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="2.5 2.5"/><rect x="7" y="7" width="5" height="5" rx="1"/><circle cx="15" cy="15" r="2.6"/>',
  ungroup: '<rect x="3.5" y="3.5" width="8" height="8" rx="1.5" stroke-dasharray="2.2 2"/><rect x="12.5" y="12.5" width="8" height="8" rx="1.5" stroke-dasharray="2.2 2"/>',
  sparkles: '<path d="M10 3.5l1.6 4.4 4.4 1.6-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6z"/><path d="M17.5 13.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  'to-text': '<path d="M4 6.5h9M8.5 6.5v11"/><path d="M15.5 11.5l1 2.7 2.7 1-2.7 1-1 2.8-1-2.8-2.7-1 2.7-1z"/>',
  'to-shape': '<path d="M4 8.5c2-3 5-3 6 0s4 3 6 0"/><rect x="11.5" y="12" width="9" height="8" rx="1"/><path d="M5 20.5l3-6 3 6z"/>',
  'align-h': '<path d="M12 3.5v17"/><rect x="5" y="6" width="14" height="4.5" rx="1"/><rect x="7.5" y="13.5" width="9" height="4.5" rx="1"/>',
  'align-v': '<path d="M3.5 12h17"/><rect x="6" y="5" width="4.5" height="14" rx="1"/><rect x="13.5" y="7.5" width="4.5" height="9" rx="1"/>',
  'align-left-objs': '<path d="M4 3.5v17"/><rect x="6.5" y="6" width="12" height="4.5" rx="1"/><rect x="6.5" y="13.5" width="7" height="4.5" rx="1"/>',
  'distribute-v': '<path d="M3.5 4h17M3.5 20h17"/><rect x="7" y="9.5" width="10" height="5" rx="1"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 9.5h1M9.5 9.5h1M13 9.5h1M16.5 9.5h1M6 12.5h1M9.5 12.5h1M13 12.5h1M16.5 12.5h1M8 15.5h8"/>',
  'mind-map': '<rect x="9" y="9.5" width="6" height="5" rx="1.2"/><rect x="2.5" y="3.5" width="5" height="4" rx="1"/><rect x="16.5" y="3.5" width="5" height="4" rx="1"/><rect x="16.5" y="16.5" width="5" height="4" rx="1"/><path d="M9 11L7.5 7.5M15 11l1.5-3.5M15 13.5l1.5 3"/>',
  formula: '<path d="M17.5 5H7l5.5 7L7 19h10.5"/>',
  folder: '<path d="M3.5 7a1.5 1.5 0 011.5-1.5h4.2l2 2.2H19a1.5 1.5 0 011.5 1.5v8.8A1.5 1.5 0 0119 19.5H5A1.5 1.5 0 013.5 18z"/>',
};


// v0.5 convert / mind map
Object.assign(P, {
  flowchart: '<rect x="8" y="2.5" width="8" height="5" rx="1"/><path d="M12 7.5v3.5"/><path d="M12 11l4 3-4 3-4-3z"/><path d="M8 14H5v4.5M5 18.5h3"/><path d="M16 14h3v5"/><rect x="15" y="19" width="6" height="3" rx="0.8"/>',
  'text-lines': '<path d="M4 6h16M4 10.5h12M4 15h16M4 19.5h9"/>',
  'add-child': '<rect x="2.5" y="9" width="8" height="6" rx="1.5"/><path d="M10.5 12h4"/><path d="M18 8.5v7M14.5 12h7"/>',
  'add-sibling': '<rect x="6" y="3" width="12" height="6" rx="1.5"/><path d="M12 9v3"/><path d="M12 14.5v7M8.5 18h7"/>',
  collapse: '<circle cx="12" cy="12" r="8"/><path d="M8 12h8"/>',
  expand: '<circle cx="12" cy="12" r="8"/><path d="M8 12h8M12 8v8"/>',
  palette: '<path d="M12 3a9 9 0 100 18c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.5-1-2.6 0-1 .8-1.7 1.8-1.7H17a4 4 0 004-4C21 6.5 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="14.5" cy="7" r="1.2"/>',
  'layout-balanced': '<rect x="9" y="10" width="6" height="4" rx="1"/><path d="M9 12H6M15 12h3M6 7v10M18 7v10M6 7h-2M6 17h-2M18 7h2M18 17h2"/>',
  'layout-right': '<rect x="3" y="10" width="6" height="4" rx="1"/><path d="M9 12h4M13 6v12M13 6h7M13 12h7M13 18h7"/>',
  markdown: '<rect x="2.5" y="5.5" width="19" height="13" rx="2"/><path d="M6 15V9l2.5 3L11 9v6M15.5 9v6M13.5 13l2 2 2-2"/>',
  retry: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4.5v3.8h3.8"/>',
  font: '<path d="M5 19L11 5h2l6 14M7.5 14h9"/>',
});

const NS = 'http://www.w3.org/2000/svg';

export function iconNames(): string[] {
  return Object.keys(P);
}

/** Replace the element's content with the named icon. Unknown names fall back to the text. */
export function setHnIcon(el: HTMLElement, name: string): void {
  const body = P[name];
  el.textContent = '';
  if (!body) {
    el.textContent = name;
    return;
  }
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('hn-icon');
  // static markup defined above (no user input), parsed without innerHTML
  const doc = new DOMParser().parseFromString(`<svg xmlns="${NS}">${body}</svg>`, 'image/svg+xml');
  for (const child of Array.from(doc.documentElement.childNodes)) svg.appendChild(document.importNode(child, true));
  el.appendChild(svg);
}
