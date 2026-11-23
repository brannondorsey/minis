// Justified ("bin-packed") grid of the untouched photos. Every row is
// filled edge to edge at a shared height, so aspect ratios are never cropped.

import { el, srcset } from './util.js';

export class Gallery {
  constructor(root, minis, { open }) {
    this.root = root;
    this.minis = minis;
    this.grid = el('div', 'grid');
    this.tiles = minis.map((m, i) => this.tile(m, i, open));
    this.grid.append(...this.tiles);
    root.append(this.grid);
    this.width = 0;
    new ResizeObserver(() => this.layout()).observe(root);
  }

  tile(m, i, open) {
    const a = el('a', 'tile');
    a.href = `#gallery/${m.id}`;
    a.dataset.id = m.id;
    a.style.backgroundImage = `url("${m.photo.lqip}")`;
    a.style.setProperty('--delay', `${Math.min(i, 12) * 70}ms`);
    a.setAttribute('aria-label', m.name || 'Open photo');
    // Play the entrance once; never again when the gallery is re-shown.
    a.addEventListener('animationend', () => (a.style.animation = 'none'), { once: true });

    const img = el('img');
    img.alt = m.name || 'Hand-painted miniature';
    img.decoding = 'async';
    img.loading = i < 6 ? 'eager' : 'lazy';
    img.width = m.photo.w;
    img.height = m.photo.h;
    img.srcset = srcset(m);
    img.sizes = '33vw';
    const done = () => img.classList.add('loaded');
    if (img.complete && img.naturalWidth) done();
    else img.addEventListener('load', done, { once: true });
    a.append(img);

    if (m.name) a.append(el('span', 'tile-name', m.name));

    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
      e.preventDefault();
      open(m.id);
    });
    return a;
  }

  show() {
    this.layout(true);
  }

  tileFor(id) {
    return this.tiles.find((t) => t.dataset.id === id);
  }

  layout(force = false) {
    const W = this.grid.clientWidth;
    if (!W || (!force && W === this.width)) return;
    this.width = W;

    const gap = parseFloat(getComputedStyle(this.grid).columnGap) || 8;
    const target = Math.round(Math.min(innerHeight * 0.62, W < 700 ? W * 0.62 : 560));
    const rows = justify(this.minis.map((m) => m.photo.w / m.photo.h), W, target, gap);

    let y = 0;
    let k = 0;
    for (const row of rows) {
      const used = row.ars.reduce((s, ar) => s + ar * row.h, 0) + gap * (row.ars.length - 1);
      let x = row.last ? (W - used) / 2 : 0;
      for (const ar of row.ars) {
        const w = ar * row.h;
        const t = this.tiles[k++];
        Object.assign(t.style, {
          left: `${x}px`,
          top: `${y}px`,
          width: `${w}px`,
          height: `${row.h}px`,
        });
        t.querySelector('img').sizes = `${Math.ceil(w)}px`;
        x += w + gap;
      }
      y += row.h + gap;
    }
    this.grid.style.height = `${Math.max(0, y - gap)}px`;
  }
}

// Greedy justified layout: keep adding photos to a row until it would be
// shorter than `target`, then pick whichever of (with / without the last
// photo) lands closer to the target height.
function justify(ars, W, target, gap) {
  const rows = [];
  let row = [];
  for (let i = 0; i < ars.length; i++) {
    row.push(ars[i]);
    const h = rowHeight(row, W, gap);
    if (h > target) continue;
    if (row.length > 1) {
      const prev = row.slice(0, -1);
      const hPrev = rowHeight(prev, W, gap);
      if (Math.abs(hPrev - target) < Math.abs(h - target)) {
        rows.push({ ars: prev, h: hPrev });
        row = [];
        i--;
        continue;
      }
    }
    rows.push({ ars: row, h });
    row = [];
  }
  // Last row: fill the width too, unless that would blow it up (e.g. a lone
  // portrait on a wide screen); then keep it at the target height, centered.
  if (row.length) {
    const h = rowHeight(row, W, gap);
    rows.push(h <= target * 1.5 ? { ars: row, h } : { ars: row, h: target, last: true });
  }
  return rows;
}

function rowHeight(ars, W, gap) {
  return (W - gap * (ars.length - 1)) / ars.reduce((s, a) => s + a, 0);
}
