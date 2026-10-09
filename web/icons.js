// Ícones em traço (24×24), herdam a cor do texto.
const PATHS = {
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  home: '<circle cx="12" cy="12" r="6"/>',
  recents: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>',
  volup: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M18 9v6M15 12h6"/>',
  voldown: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M15 12h6"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4l2-2z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  folderplus: '<path d="M3 6h6l2 2h10v11H3z"/><path d="M12 11v5M9.5 13.5h5"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  erase: '<path d="M5 5l14 14M19 5L5 19"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = svg(name);
  return span;
}

export function svg(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ''}</svg>`;
}

/** Preenche todos os <span class="icon" data-icon="..."> do documento. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) el.innerHTML = svg(el.dataset.icon);
}
