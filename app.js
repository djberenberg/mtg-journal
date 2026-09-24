// The page half of the journal: drawing the table, and turning clicks and
// keys into calls on game.js. It never decides what a move means.
import * as G from './game.js';
import { autocomplete, lookup, NotFound } from './scryfall.js';

const SAVE_KEY = 'mtg-journal.game';
const VIEW_KEY = 'mtg-journal.view';
const UNDO_DEPTH = 100;
const SUGGEST_DELAY_MS = 200;

const $ = (id) => document.getElementById(id);
const q = $('q');
const suggest = $('suggest');
const status = $('status');
const logEl = $('log');
const undoBtn = $('undo');
const journal = $('journal');
const tabs = $('opp-tabs');
const dialog = $('new-dialog');
// The DOM has one opponent side; it shows whichever opponent is in view.
// A battlefield is two rows, so a card there goes to its row, not the zone.
const zones = new Map([...document.querySelectorAll('.zone')].map((z) => [`${z.dataset.owner}:${z.dataset.zone}`, z]));
const tiers = new Map([...document.querySelectorAll('.tier')].map((t) => [`${t.closest('.zone').dataset.owner}:${t.dataset.tier}`, t]));
const placeFor = (side, c) => (c.zone === 'battlefield' ? tiers.get(`${side}:${G.isLand(c) ? 'lands' : 'spells'}`) : zones.get(`${side}:${c.zone}`));

// --- state ------------------------------------------------------------

let game = restore(SAVE_KEY, G.load) ?? G.newGame();
// What the page shows, as opposed to what happened: which opponent's board
// is up, and whether the log is. Saved separately, so it is not undone.
const view = { opp: 'opp1', logCollapsed: false, ...(restore(VIEW_KEY, JSON.parse) ?? {}) };
const history = [];

function restore(key, parse) {
  try { return parse(localStorage.getItem(key)); } catch { return null; }
}

function persist() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(game));
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch { /* private window: play on */ }
}

// Every change goes through here: it keeps the undo stack and the save.
function commit(next) {
  if (next === game) return;
  history.push(game);
  if (history.length > UNDO_DEPTH) history.shift();
  game = next;
  persist();
  render();
}

function undo() {
  if (!history.length) return;
  game = history.pop();
  persist();
  render();
}

function show(opp) {
  view.opp = opp;
  persist();
  render();
}

// --- drawing ----------------------------------------------------------

// Card elements are kept, not rebuilt, so an image loads once and a card
// that changes zone moves rather than flickers. appendChild on an element
// already in the tree moves it, which also puts each zone in state order.
const cardEls = new Map();

const ACTIONS = {
  hand: [['play', 'play'], ['copy', 'copy'], ['move', 'graveyard', 'grave'], ['move', 'exile', 'exile'], ['move', 'command', 'cmd'], ['remove', '×']],
  battlefield: [['counter', 'ctr'], ['copy', 'copy'], ['move', 'graveyard', 'grave'], ['move', 'exile', 'exile'], ['move', 'hand', 'hand'], ['move', 'command', 'cmd'], ['remove', '×']],
  graveyard: [['copy', 'copy'], ['move', 'battlefield', 'field'], ['move', 'hand', 'hand'], ['move', 'exile', 'exile'], ['move', 'command', 'cmd'], ['remove', '×']],
  exile: [['counter', 'ctr'], ['copy', 'copy'], ['move', 'battlefield', 'field'], ['move', 'hand', 'hand'], ['move', 'graveyard', 'grave'], ['move', 'command', 'cmd'], ['remove', '×']],
  command: [['counter', 'ctr'], ['copy', 'copy'], ['move', 'battlefield', 'field'], ['move', 'hand', 'hand'], ['move', 'graveyard', 'grave'], ['remove', '×']],
};
const ACTION_TITLE = { play: 'play', remove: 'remove (a mistake)', counter: 'add a counter', copy: 'another of this card, beside it' };
const ZONE_TITLE = { battlefield: 'to the battlefield', hand: 'to hand', graveyard: 'to the graveyard', exile: 'to exile', command: 'to the command zone' };

function describe(c) {
  const lines = [`${c.name}  ${c.manaCost}`.trim(), c.typeLine];
  if (c.oracleText) lines.push('', c.oracleText);
  if (c.power != null) lines.push('', `${c.power}/${c.toughness}`);
  else if (c.loyalty != null) lines.push('', `loyalty ${c.loyalty}`);
  return lines.join('\n');
}

function cardEl(c) {
  let el = cardEls.get(c.uid);
  if (!el) {
    el = document.createElement('figure');
    el.className = 'card';
    el.dataset.uid = c.uid;
    el.title = describe(c);
    const img = document.createElement('img');
    img.src = c.image;
    img.alt = c.name;
    img.draggable = false;
    img.loading = 'lazy';
    const layer = document.createElement('div');
    layer.className = 'counters';
    const actions = document.createElement('figcaption');
    actions.className = 'actions';
    el.append(img, layer, actions);
    cardEls.set(c.uid, el);
  }
  renderCounters(el.querySelector('.counters'), c.counters ?? []);
  el.classList.toggle('tapped', c.tapped);
  el.classList.toggle('permanent', G.isPermanent(c));
  el.classList.toggle('commander', Boolean(c.commander));
  if (el.dataset.zone !== c.zone) {
    el.dataset.zone = c.zone;
    el.querySelector(':scope > .actions').replaceChildren(...ACTIONS[c.zone].map(([act, a, b]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.act = act;
      if (act === 'move') { btn.dataset.zone = a; btn.textContent = b; btn.title = ZONE_TITLE[a]; }
      else { btn.textContent = a; btn.title = ACTION_TITLE[act]; }
      return btn;
    }));
  }
  return el;
}

// The squares on one card, kept by id like the cards themselves. A square
// being dragged is left alone: its position is the pointer's until it is
// let go and the move is committed.
function renderCounters(layer, counters) {
  const seen = new Set();
  for (const k of counters) {
    seen.add(k.id);
    let sq = layer.querySelector(`[data-cid="${k.id}"]`);
    if (!sq) {
      sq = document.createElement('div');
      sq.className = 'counter';
      sq.dataset.cid = k.id;
      sq.innerHTML = '<span class="n"></span><span class="k"></span><span class="adj"><button type="button" data-ctr="-1" aria-label="One fewer">−</button><button type="button" data-ctr="1" aria-label="One more">+</button></span>';
      layer.appendChild(sq);
    }
    sq.querySelector('.n').textContent = k.count;
    sq.querySelector('.k').textContent = k.kind;
    sq.title = `${k.count} ${k.kind} counter${k.count === 1 ? '' : 's'}: drag to move, hover for + and −`;
    if (drag?.sq !== sq) {
      sq.style.setProperty('--x', k.x);
      sq.style.setProperty('--y', k.y);
      sq.style.left = '';
      sq.style.top = '';
    }
  }
  for (const sq of [...layer.children]) if (!seen.has(sq.dataset.cid)) sq.remove();
}

// The section for the opponent in view: their tabs, name, and life.
function renderOpponents() {
  const seats = G.players(game).slice(1);
  if (!seats.includes(view.opp)) view.opp = seats[0];
  tabs.hidden = seats.length < 2;
  tabs.replaceChildren(...seats.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'tab';
    b.dataset.opp = p;
    b.setAttribute('aria-selected', String(p === view.opp));
    b.classList.toggle('active', game.active === p);
    b.append(G.label(game, p), Object.assign(document.createElement('span'), { className: 'n', textContent: game.life[p] }));
    b.title = `${G.label(game, p)}: ${game.life[p]} life, ${G.cardsIn(game, p, 'battlefield').length} on the battlefield`;
    return b;
  }));
  $('opp-name').textContent = G.label(game, view.opp);
  $('life-opp').textContent = game.life[view.opp];
  $('add-opp').textContent = `${G.label(game, view.opp)} plays`;
}

function render() {
  renderOpponents();

  const seen = new Set();
  for (const c of game.cards) {
    seen.add(c.uid);
    const el = cardEl(c);
    if (c.owner === 'me') placeFor('me', c).appendChild(el);
    else if (c.owner === view.opp) placeFor('opp', c).appendChild(el);
    else el.remove(); // another opponent's: kept, not shown
  }
  for (const [uid, el] of cardEls) {
    if (!seen.has(uid)) { el.remove(); cardEls.delete(uid); }
  }

  for (const el of document.querySelectorAll('[data-count]')) {
    const [side, zone] = el.dataset.count.split(':');
    el.textContent = G.cardsIn(game, side === 'me' ? 'me' : view.opp, zone).length;
  }
  // The opponent's hand is hidden information; show the pile only if we
  // have put something there.
  document.querySelector('[data-pile="opp:hand"]').hidden = G.cardsIn(game, view.opp, 'hand').length === 0;

  $('life-me').textContent = game.life.me;
  $('turn').textContent = `turn ${game.turn} · ${G.label(game, game.active, 'possessive')} turn`;
  undoBtn.disabled = history.length === 0;

  journal.classList.toggle('log-collapsed', view.logCollapsed);
  $('log-toggle').setAttribute('aria-expanded', String(!view.logCollapsed));

  logEl.replaceChildren(...[...game.log].reverse().map((l) => {
    const li = document.createElement('li');
    if (/^turn \d+:/.test(l.text)) li.className = 'turn-line';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = `${l.turn} `;
    li.append(t, l.text);
    return li;
  }));
}

// --- adding cards -----------------------------------------------------

let pending = null; // the lookup in flight, so a second enter does not double up

async function add(owner) {
  const name = q.value.trim();
  if (!name || pending) return;
  closeSuggestions();
  setStatus(`looking up ${name}…`);
  pending = lookup(name);
  try {
    const card = await pending;
    commit(G.addCard(game, card, owner));
    q.value = '';
    setStatus(`${owner === 'me' ? 'to my hand' : `${G.label(game, owner)} plays`}: ${card.name}`);
  } catch (e) {
    setStatus(e instanceof NotFound ? e.message : `Scryfall: ${e.message}`, true);
  } finally {
    pending = null;
    q.focus();
  }
}

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

$('search').addEventListener('submit', (e) => { e.preventDefault(); add('me'); });
$('add-opp').addEventListener('click', () => add(view.opp));

// --- suggestions ------------------------------------------------------

let timer = null;
let selected = -1;
let names = [];
let fetchController = null;

function closeSuggestions() {
  suggest.hidden = true;
  suggest.replaceChildren();
  names = [];
  selected = -1;
  q.removeAttribute('aria-activedescendant');
}

function showSuggestions(list) {
  names = list;
  selected = -1;
  suggest.replaceChildren(...list.map((n, i) => {
    const li = document.createElement('li');
    li.role = 'option';
    li.id = `s${i}`;
    li.textContent = n;
    return li;
  }));
  suggest.hidden = list.length === 0;
}

function select(i) {
  selected = i;
  [...suggest.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
  if (i >= 0) {
    q.setAttribute('aria-activedescendant', `s${i}`);
    suggest.children[i].scrollIntoView({ block: 'nearest' });
  }
}

q.addEventListener('input', () => {
  clearTimeout(timer);
  fetchController?.abort();
  const text = q.value;
  if (text.trim().length < 2) { closeSuggestions(); return; }
  timer = setTimeout(async () => {
    fetchController = new AbortController();
    try {
      const list = await autocomplete(text, { signal: fetchController.signal });
      if (q.value === text) showSuggestions(list);
    } catch (e) {
      if (e.name !== 'AbortError') setStatus(`Scryfall: ${e.message}`, true);
    }
  }, SUGGEST_DELAY_MS);
});

q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); add(view.opp); return; }
  if (suggest.hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); select((selected + 1) % names.length); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); select((selected - 1 + names.length) % names.length); }
  else if (e.key === 'Escape') { closeSuggestions(); }
  else if (e.key === 'Enter' && selected >= 0) {
    // Take the suggestion; a second enter adds it. So a typo never gets
    // sent to the fuzzy lookup and comes back as the wrong card.
    e.preventDefault();
    q.value = names[selected];
    closeSuggestions();
  }
});

suggest.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault(); // keep focus in the input
  q.value = li.textContent;
  closeSuggestions();
});

q.addEventListener('blur', () => setTimeout(closeSuggestions, 100));

// --- menus ------------------------------------------------------------

// One popup for the page, filled and placed wherever it was asked for: a
// navbar button hangs it underneath, a right-click drops it at the pointer.
const menu = $('menu');
const MENU_EDGE = 8; // how far the popup keeps clear of the viewport's edges

// The container takes the focus when a menu is opened with the mouse, so
// the arrow keys have somewhere to start from without a focus ring landing
// on an item the pointer is not over.
menu.tabIndex = -1;

// Whether the last thing the user did was press a key. A menu opened from
// the keyboard puts the focus on its first item; one opened with the mouse
// leaves it on the container.
let byKey = false;
window.addEventListener('keydown', () => { byKey = true; }, true);
window.addEventListener('pointerdown', () => { byKey = false; }, true);

// What opened the menu that is up, and null when none is: view-only, so
// neither committed nor persisted.
let menuOpener = null;

function menuOpen() {
  return menuOpener !== null;
}

const enabledItems = () => [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];

// items: { label, title?, disabled?, run() }, or '-' for a separator.
function openMenu(opener, items, at) {
  closeMenu();
  menuOpener = opener;
  menu.replaceChildren(...items.map((it) => {
    if (it === '-') {
      const rule = document.createElement('hr');
      rule.role = 'separator';
      return rule;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'menuitem';
    b.textContent = it.label;
    if (it.title) b.title = it.title;
    b.disabled = Boolean(it.disabled);
    // Close first, then run, so a run() that opens a dialog keeps the focus.
    b.addEventListener('click', () => { closeMenu(); it.run(); });
    return b;
  }));
  menu.hidden = false;
  placeMenu(at); // measured filled and shown, or it has no size yet
  // Only something that declares itself a menu button carries the state; a
  // card that was right-clicked is not one.
  if (opener.hasAttribute('aria-expanded')) opener.setAttribute('aria-expanded', 'true');
  (byKey ? (enabledItems()[0] ?? menu) : menu).focus();
}

function closeMenu() {
  if (!menuOpener) return;
  const opener = menuOpener;
  const held = menu.contains(document.activeElement); // asked before it is emptied
  menuOpener = null;
  menu.hidden = true;
  menu.replaceChildren();
  if (opener.hasAttribute('aria-expanded')) opener.setAttribute('aria-expanded', 'false');
  // The focus goes back where the menu came from, unless whatever closed
  // the menu has already put it somewhere of its own.
  if (held || document.activeElement === document.body) opener.focus();
}

// At the pointer, or under the opener; flipped to the other side of it when
// the viewport has no room below or to the right, and clamped either way.
function placeMenu(at) {
  // Measured in the top corner, where nothing squeezes it narrower than it
  // wants to be; the place it ends up is worked out from that size.
  menu.style.left = `${MENU_EDGE}px`;
  menu.style.top = `${MENU_EDGE}px`;
  const box = menu.getBoundingClientRect();
  const r = menuOpener.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const near = { x: at ? at.x : r.left, y: at ? at.y : r.bottom };
  const far = { x: at ? at.x : r.right, y: at ? at.y : r.top };
  const x = near.x + box.width > vw - MENU_EDGE ? far.x - box.width : near.x;
  const y = near.y + box.height > vh - MENU_EDGE ? far.y - box.height : near.y;
  menu.style.left = `${Math.max(MENU_EDGE, Math.min(x, vw - MENU_EDGE - box.width))}px`;
  menu.style.top = `${Math.max(MENU_EDGE, Math.min(y, vh - MENU_EDGE - box.height))}px`;
}

// Enter and space are the button's own; the rest is the menu's. The arrows
// wrap, and step over a disabled item.
menu.addEventListener('keydown', (e) => {
  const items = enabledItems();
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') (i < 0 ? items[0] : items[(i + 1) % items.length]).focus();
  else if (e.key === 'ArrowUp') (i < 0 ? items.at(-1) : items[(i - 1 + items.length) % items.length]).focus();
  else if (e.key === 'Home') items[0].focus();
  else if (e.key === 'End') items.at(-1).focus();
  else return;
  e.preventDefault();
});

window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// Any click outside closes it. The opener's own click is its toggle, which
// is handled where the menu is opened; this runs after that.
document.addEventListener('click', (e) => {
  if (menuOpen() && !menu.contains(e.target) && !menuOpener.contains(e.target)) closeMenu();
});

// The popup is fixed where it was put, so it would be left behind.
window.addEventListener('scroll', () => closeMenu(), true);
window.addEventListener('resize', () => closeMenu());

// --- the table --------------------------------------------------------

// --- counters ---------------------------------------------------------

const pick = $('ctr-pick');
const pickKind = $('ctr-kind');

// The picker moves onto the card that asked for it, so it is placed by
// the card's own box and goes with it.
function openPicker(card) {
  card.appendChild(pick);
  pick.dataset.uid = card.dataset.uid;
  pick.hidden = false;
  pickKind.value = '+1/+1';
  pickKind.focus();
  pickKind.select();
}

// Closed, the picker goes back where it lives, so no card is left holding
// it: a card's children are its own, and its action strip is found by
// class, not position.
function closePicker() {
  pick.hidden = true;
  delete pick.dataset.uid;
  journal.appendChild(pick);
}

pick.addEventListener('submit', (e) => {
  e.preventDefault();
  const uid = pick.dataset.uid;
  const c = game.cards.find((x) => x.uid === uid);
  if (!c) return closePicker();
  // A new kind's square goes below the last, down the left edge.
  const n = (c.counters ?? []).filter((k) => k.kind !== G.parseCounterKind(pickKind.value)).length;
  commit(G.addCounter(game, uid, pickKind.value, { x: 0.06, y: Math.min(0.72, 0.06 + 0.22 * n) }));
  closePicker();
});

pickKind.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });
pickKind.addEventListener('blur', () => setTimeout(() => { if (!pick.contains(document.activeElement)) closePicker(); }, 120));

// Dragging a square about its card. Position is set in pixels while the
// pointer is down and committed, when it is let go, as a fraction of the
// room the square has to move in; so it keeps its place on the card when
// the card changes size or turns on its side, and never pokes out.
let drag = null;

document.querySelector('.table').addEventListener('pointerdown', (e) => {
  const sq = e.target.closest('.counter');
  if (!sq || e.target.closest('button') || e.button !== 0) return;
  const layer = sq.parentElement;
  drag = { sq, layer, uid: sq.closest('.card').dataset.uid, startX: e.clientX, startY: e.clientY, left: sq.offsetLeft, top: sq.offsetTop, moved: false };
  sq.setPointerCapture?.(e.pointerId);
  e.preventDefault();
});

document.querySelector('.table').addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
  drag.moved = true;
  drag.sq.classList.add('dragging');
  const maxX = drag.layer.clientWidth - drag.sq.offsetWidth;
  const maxY = drag.layer.clientHeight - drag.sq.offsetHeight;
  drag.sq.style.left = `${Math.max(0, Math.min(maxX, drag.left + dx))}px`;
  drag.sq.style.top = `${Math.max(0, Math.min(maxY, drag.top + dy))}px`;
});

function endDrag() {
  if (!drag) return;
  const { sq, layer, uid, moved } = drag;
  drag = null;
  sq.classList.remove('dragging');
  if (!moved) return;
  const roomX = layer.clientWidth - sq.offsetWidth;
  const roomY = layer.clientHeight - sq.offsetHeight;
  commit(G.moveCounter(game, uid, sq.dataset.cid, roomX > 0 ? sq.offsetLeft / roomX : 0, roomY > 0 ? sq.offsetTop / roomY : 0));
  render(); // the commit may be a no-op (same place); put the fractions back either way
}

document.querySelector('.table').addEventListener('pointerup', endDrag);
document.querySelector('.table').addEventListener('pointercancel', endDrag);

// --- the table --------------------------------------------------------

document.querySelector('.table').addEventListener('click', (e) => {
  if (e.target.closest('.ctr-pick')) return;
  const btn = e.target.closest('button');
  if (btn?.dataset.ctr) {
    const sq = btn.closest('.counter');
    commit(G.adjustCounter(game, sq.closest('.card').dataset.uid, sq.dataset.cid, Number(btn.dataset.ctr)));
    return;
  }
  if (btn?.dataset.opp) { show(btn.dataset.opp); return; }
  if (btn?.dataset.life) {
    commit(G.adjustLife(game, btn.dataset.life === 'me' ? 'me' : view.opp, Number(btn.dataset.by)));
    return;
  }
  const card = e.target.closest('.card');
  if (!card) return;
  const uid = card.dataset.uid;
  if (btn?.dataset.act === 'counter') openPicker(card);
  else if (btn?.dataset.act === 'play') commit(G.play(game, uid));
  else if (btn?.dataset.act === 'copy') commit(G.copyCard(game, uid));
  else if (btn?.dataset.act === 'move') commit(G.moveTo(game, uid, btn.dataset.zone));
  else if (btn?.dataset.act === 'remove') commit(G.remove(game, uid));
  else if (e.target.tagName === 'IMG' && card.dataset.zone === 'battlefield') commit(G.toggleTap(game, uid));
});

// --- turns, log, new game ---------------------------------------------

$('next').addEventListener('click', () => {
  commit(G.nextTurn(game));
  // Follow the turn round the table: an opponent's turn brings their board up.
  if (game.active !== 'me') show(game.active);
});

undoBtn.addEventListener('click', undo);

$('log-toggle').addEventListener('click', () => {
  view.logCollapsed = !view.logCollapsed;
  persist();
  render();
});

// Reset keeps the seats and the starting life; new game asks for them
// again. Neither needs a confirmation on top: undo brings the game back.
const GAME_MENU = [
  {
    label: 'new game',
    title: 'start over; asks for opponents and life',
    run: () => {
      $('new-warn').hidden = game.cards.length === 0 && game.log.length <= 1;
      dialog.showModal();
    },
  },
  {
    label: 'reset game',
    title: 'clear the table, same opponents and life',
    run: () => {
      commit(G.resetGame(game));
      show('opp1');
      setStatus('game reset (undo brings it back)');
      q.focus();
    },
  },
];

$('menu-game').addEventListener('click', (e) => {
  // A second click on the button puts its own menu away again.
  if (menuOpener === e.currentTarget) closeMenu();
  else openMenu(e.currentTarget, GAME_MENU);
});

$('new-cancel').addEventListener('click', () => dialog.close());

$('new-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  commit(G.newGame({ opponents: Number(f.get('opponents')), life: Number(f.get('life')) }));
  dialog.close();
  show('opp1');
  q.focus();
});

// "/" goes to the search box from anywhere, as on most sites.
window.addEventListener('keydown', (e) => {
  if (dialog.open || menuOpen()) return;
  if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && document.activeElement !== q) { e.preventDefault(); undo(); }
});

render();
q.focus();
