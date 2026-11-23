// Boot + tiny hash router.
//   (no hash)          gallery
//   #stickers          sticker playground
//   #<view>/<id>       that view, with the fullscreen viewer open on <id>
//
// Navigation is animated with the View Transitions API where available:
// photos morph into stickers (and back), and into / out of the viewer.

import { Gallery } from './gallery.js';
import { Viewer } from './viewer.js';
import { Stickers } from './stickers.js';
import { reducedMotion } from './util.js';

const $ = (s) => document.querySelector(s);

// A mini is one model; it can have several photos but only one sticker.
// The gallery and viewer list every photo; the playground lists every mini.
const minis = [];
const photos = [];
for (const m of (await fetch('minis/manifest.json').then((r) => r.json())).minis) {
  const mini = { ...m, base: m.sticker ? `minis/${m.sticker.photo}/` : null };
  minis.push(mini);
  for (const p of m.photos) {
    photos.push({ id: p.id, photo: p, base: `minis/${p.id}/`, name: m.name, description: m.description, mini });
  }
}
const photoById = new Map(photos.map((p) => [p.id, p]));

const sections = { gallery: $('#gallery'), stickers: $('#stickers') };
const gallery = new Gallery(sections.gallery, photos, { open: (id) => go('gallery', id) });
const viewer = new Viewer($('#viewer'), photos, {
  close: closeViewer,
  change: (id) => {
    state.id = id;
    history.replaceState(history.state, '', `#${state.view}/${id}`);
  },
});
let stickers = null;
const getStickers = () =>
  (stickers ??= new Stickers(sections.stickers, minis, { open: (id) => go('stickers', id) }));

let current = null; // the view whose DOM is showing
let state = { view: null, id: null }; // where we are (or are animating to)
let seq = 0;

function parse() {
  const [view = '', id = ''] = decodeURIComponent(location.hash.slice(1)).split('/');
  return {
    view: view === 'stickers' ? 'stickers' : 'gallery',
    id: photoById.has(id) ? id : null,
  };
}

function url(view, id) {
  if (id) return `#${view}/${id}`;
  return view === 'stickers' ? '#stickers' : location.pathname + location.search;
}

function go(view, id = null) {
  history.pushState({ app: true, viewer: !!id }, '', url(view, id));
  route();
}

function closeViewer() {
  if (history.state?.viewer) history.back();
  else {
    history.replaceState(null, '', url(state.view));
    route();
  }
}

async function route() {
  const next = parse();
  const prev = state;
  if (prev.view === next.view && prev.id === next.id) return;
  state = next;
  const token = ++seq;

  const morph = prev.view && document.startViewTransition && !reducedMotion();
  const update = (instant) => {
    if (next.view !== current) show(next.view, instant);
    if (next.id) viewer.open(next.id, { instant });
    else viewer.close({ instant });
  };
  if (!morph) return update(false);

  // Pair up the elements that should morph into each other. A photo's
  // counterpart in the playground is its mini's sticker.
  const base = (view, id) =>
    view === 'gallery' ? gallery.tileFor(id) : getStickers().face(photoById.get(id)?.mini.id);
  const heroes = minis.filter((m) => m.sticker).map((m) => m.sticker.photo);
  let before = [];
  let after = () => [];
  let wait = Promise.resolve();
  if (prev.view !== next.view && !prev.id && !next.id) {
    before = heroes.map((id) => [base(prev.view, id), id]);
    after = () => heroes.map((id) => [base(next.view, id), id]);
    if (next.view === 'stickers') wait = getStickers().ready();
  } else if (prev.view === next.view && !prev.id && next.id) {
    before = [[base(prev.view, next.id), next.id]];
    const img = viewer.img(next.id);
    after = () => [[img.parentElement, next.id]];
    wait = img.decode();
  } else if (prev.view === next.view && prev.id && !next.id) {
    before = [[viewer.img(prev.id)?.parentElement, prev.id]];
    after = () => {
      const el = base(next.view, prev.id);
      if (next.view === 'gallery') keepInView(el);
      return [[el, prev.id]];
    };
  }

  // Don't hold navigation hostage to a slow image.
  await Promise.race([wait.catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
  if (token !== seq) return;

  const named = [];
  const name = (pairs) => {
    for (const [el, id] of pairs) {
      if (!el) continue;
      el.style.viewTransitionName = `mini-${id}`;
      named.push(el);
    }
  };
  const clear = () => named.splice(0).forEach((el) => (el.style.viewTransitionName = ''));

  name(before);
  const t = document.startViewTransition(() => {
    clear();
    update(true);
    name(after());
  });
  t.finished.finally(clear);
}

function keepInView(el) {
  const tile = el?.closest('.tile');
  if (!tile) return;
  const r = tile.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) tile.scrollIntoView({ block: 'center' });
}

function show(view, morph = false) {
  const first = current === null;
  current = view;
  document.body.dataset.view = view;
  for (const [k, s] of Object.entries(sections)) s.hidden = k !== view;
  if (view === 'stickers') getStickers().show({ morph });
  else {
    stickers?.hide();
    gallery.show();
  }
  for (const a of document.querySelectorAll('.switch a')) {
    if (a.dataset.nav === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  pill();
  if (!first && view === 'stickers') scrollTo(0, 0);
}

// Slide the little highlight behind the active tab.
function pill() {
  const a = document.querySelector('.switch a[aria-current]');
  const p = $('.switch-pill');
  if (!a || !p) return;
  p.style.width = `${a.offsetWidth}px`;
  p.style.transform = `translateX(${a.offsetLeft}px)`;
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-nav]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  e.preventDefault();
  if (a.dataset.nav !== state.view || state.id) go(a.dataset.nav);
});
addEventListener('popstate', route);
addEventListener('hashchange', route);
addEventListener('resize', pill);
document.fonts?.ready.then(pill);

route();
