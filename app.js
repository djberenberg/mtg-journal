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

// What a card says, in parts rather than one blob of text: the panel gives
// each its own row, and leaves out the ones this card has nothing for.
function details(c) {
  return {
    name: c.name,
    manaCost: c.manaCost ?? '',
    typeLine: c.typeLine ?? '',
    oracleText: c.oracleText ?? '',
    stats: c.power != null ? `${c.power}/${c.toughness}` : c.loyalty != null ? `loyalty ${c.loyalty}` : null,
  };
}

function cardEl(c) {
  let el = cardEls.get(c.uid);
  if (!el) {
    el = document.createElement('figure');
    el.className = 'card';
    el.dataset.uid = c.uid;
    // The card is its own control now that the strip of buttons is gone: it
    // takes the focus, so what a mouse reaches by right-clicking a key
    // reaches by pressing enter. Not a button, though it acts like one: a
    // button's children are presentational, which would take the working +
    // and − on its counters away from a screen reader.
    el.tabIndex = 0;
    el.role = 'group';
    // Enter opens a menu, and nothing else on the card says so.
    el.ariaHasPopup = 'menu';
    const img = document.createElement('img');
    img.src = c.image;
    img.alt = c.name;
    img.draggable = false;
    img.loading = 'lazy';
    const layer = document.createElement('div');
    layer.className = 'counters';
    el.append(img, layer);
    cardEls.set(c.uid, el);
  }
  renderCounters(el.querySelector('.counters'), c.counters ?? []);
  el.classList.toggle('tapped', c.tapped);
  el.classList.toggle('permanent', G.isPermanent(c));
  el.classList.toggle('commander', Boolean(c.commander));
  // The zone is on the element because the menu and the click handler both
  // ask the card where it is; the label says it out loud for the same reason.
  if (el.dataset.zone !== c.zone) {
    el.dataset.zone = c.zone;
    el.setAttribute('aria-label', `${c.name}, ${c.zone}`);
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
}

function render() {
  renderOpponents();

  // Moving an element blurs it, and every card that is drawn is moved; the
  // keyboard would lose the card it was on at each commit.
  const hadFocus = document.activeElement?.closest('.card');

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
  // A card that has gone — removed, or another opponent's — leaves the
  // panel about it beside nothing.
  if (peekCard && !peekCard.isConnected) hidePeek();
  if (hadFocus?.isConnected && document.activeElement === document.body) hadFocus.focus({ preventScroll: true });

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
// The card the search found, waiting for a destination. Not game state: it
// is nowhere on the table yet, so it is neither saved nor undone, and one
// card is staged at a time.
let staged = null;

// The search box finds the card; where it goes is chosen afterwards, from
// the card menu or with a second enter.
async function stage() {
  const name = q.value.trim();
  if (!name || pending) return;
  closeSuggestions();
  setStatus(`looking up ${name}…`);
  pending = lookup(name);
  try {
    const card = await pending;
    staged = card;
    q.value = '';
    renderStaged();
    setStatus(`${card.name} — choose from card ▾`);
  } catch (e) {
    setStatus(e instanceof NotFound ? e.message : `Scryfall: ${e.message}`, true);
  } finally {
    pending = null;
    q.focus();
  }
}

// dest is 'me:hand', 'opp:play', 'me:command' or 'opp:command'. addCard
// works out where an opponent's play lands and that a card put in the
// command zone is the commander, so only the owner and the zone are said
// here.
function place(dest) {
  if (!staged) return;
  const [side, where] = dest.split(':');
  commit(G.addCard(game, staged, side === 'me' ? 'me' : view.opp, where === 'command' ? 'command' : undefined));
  clearStaged();
  // The log has just said what happened, in the game's own words; the
  // status line need not say it differently.
  setStatus(game.log.at(-1).text);
  q.focus();
}

function discard() {
  if (!staged) return;
  const { name } = staged;
  clearStaged();
  setStatus(`discarded ${name}`);
  q.focus();
}

function clearStaged() {
  staged = null;
  renderStaged();
}

// The slot, and the menu button that acts on it: there is nothing for the
// menu to offer while the slot is empty.
function renderStaged() {
  $('staged').hidden = !staged;
  $('menu-card').disabled = !staged;
  if (!staged) return;
  $('staged-img').src = staged.image;
  $('staged-name').textContent = staged.name;
}

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

$('search').addEventListener('submit', (e) => { e.preventDefault(); stage(); });
$('staged-clear').addEventListener('click', discard);

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
  // With a card staged and nothing typed, the keys are its destination:
  // enter to my hand, shift+enter the opponent playing it. So a card still
  // takes two keystrokes, as it did when enter added one outright.
  const waiting = staged && q.value.trim() === '';
  if (e.key === 'Enter' && waiting) { e.preventDefault(); place(e.shiftKey ? 'opp:play' : 'me:hand'); return; }
  if (e.key === 'Escape' && waiting) { discard(); return; }
  // With something typed, either enter stages it; the destination comes after.
  if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); stage(); return; }
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
  // Asking the same opener again puts its menu away, rather than closing and
  // opening it behind the click that was meant to dismiss it — but a menu
  // asked for at a pointer moves to the new one, as a context menu does.
  if (opener === menuOpener && !at) { closeMenu(); return; }
  closeMenu();
  hidePeek(); // whatever the menu is about, it is not the card's text
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
  // the menu has already put it somewhere of its own. Without preventScroll
  // a card far down the page would drag the viewport to it.
  if (held || document.activeElement === document.body) opener.focus({ preventScroll: true });
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

// Both popups are fixed where they were put, so they would be left behind.
window.addEventListener('scroll', () => { closeMenu(); hidePeek(); }, true);
window.addEventListener('resize', () => { closeMenu(); hidePeek(); });

// --- the card menu ----------------------------------------------------

// Every zone but the card's own, in the order they sit on the table. The
// old hover strip left destinations out per zone, which a player could not
// predict; the menu offers all of them.
const MOVES = [
  ['battlefield', 'to the battlefield'],
  ['hand', 'to hand'],
  ['graveyard', 'to the graveyard'],
  ['exile', 'to exile'],
  ['command', 'to the command zone'],
];

// What can be done with the card, read off the element: it knows its uid
// and the zone it is in, which is all any of these need.
function itemsFor(el) {
  const uid = el.dataset.uid;
  const zone = el.dataset.zone;
  const items = [];
  // play takes a card out of hand and works out where it lands, so it is
  // only offered where G.play accepts it.
  if (zone === 'hand') items.push({ label: 'play', title: 'to the battlefield, or the graveyard if it is a spell', run: () => commit(G.play(game, uid)) });
  items.push({ label: 'copy', title: 'another of this card, beside it', run: () => commit(G.copyCard(game, uid)) });
  // Nothing in hand is on the table yet, so nothing there can be counted.
  if (zone !== 'hand') items.push({ label: 'add counter…', title: 'a +1/+1, or a kind of your own', run: () => openPicker(el) });
  items.push('-');
  for (const [z, label] of MOVES) if (z !== zone) items.push({ label, run: () => commit(G.moveTo(game, uid, z)) });
  items.push('-', { label: 'remove', title: 'the card was never there (a mistake)', run: () => commit(G.remove(game, uid)) });
  return items;
}

const table = document.querySelector('.table');

// A right-click anywhere on the card — its image, its counters — is the
// card's own menu, dropped at the pointer. The picker keeps the browser's
// menu, so its text can still be cut and pasted.
table.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.ctr-pick')) return;
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  openMenu(card, itemsFor(card), { x: e.clientX, y: e.clientY });
});

// Enter is the menu wherever the card is; space is the tap, which only a
// permanent on the battlefield has, and the menu everywhere else. Keys
// pressed inside the card — on a counter's + or − — are that button's.
table.addEventListener('keydown', (e) => {
  if (e.target !== e.target.closest('.card')) return;
  const card = e.target;
  const taps = card.dataset.zone === 'battlefield' && card.classList.contains('permanent');
  if (e.key === ' ' && taps) commit(G.toggleTap(game, card.dataset.uid));
  else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ContextMenu') openMenu(card, itemsFor(card));
  else return;
  e.preventDefault(); // space scrolls the page, enter would not, but both are ours
});

// --- the hover panel --------------------------------------------------

// What the card under the pointer says, beside it. The browser's own
// tooltip said the same thing, a second late and in the system's font.
// View only: never committed, and not worth saving either.
const peek = $('peek');
const PEEK_EDGE = 8; // the gap from the card, and from the viewport's edges
const CARD_ZOOM = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-zoom')) || 1;
let peekCard = null; // the card element it describes, and null when it is away

function showPeek(card) {
  const c = game.cards.find((x) => x.uid === card.dataset.uid);
  if (!c) return;
  const d = details(c);
  const name = document.createElement('div');
  name.className = 'peek-name';
  name.append(Object.assign(document.createElement('span'), { textContent: d.name }));
  if (d.manaCost) name.append(Object.assign(document.createElement('span'), { className: 'cost', textContent: d.manaCost }));
  const rows = [name];
  for (const [cls, text] of [['peek-type', d.typeLine], ['peek-text', d.oracleText], ['peek-stats', d.stats]]) {
    if (text) rows.push(Object.assign(document.createElement('div'), { className: cls, textContent: text }));
  }
  peek.replaceChildren(...rows);
  peekCard = card;
  peek.hidden = false;
  placePeek(); // measured filled and shown, or it has no size yet
}

function hidePeek() {
  if (!peekCard) return;
  peekCard = null;
  peek.hidden = true;
  peek.replaceChildren();
}

// The card grows under the pointer, and is still growing when the pointer
// arrives; so the panel is placed beside the box the card ends at, whose
// centre is where its box is now and whose size is the laid-out one zoomed.
function grownBox(el) {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  const w = parseFloat(s.width) * CARD_ZOOM;
  const h = parseFloat(s.height) * CARD_ZOOM;
  const left = r.left + (r.width - w) / 2;
  const top = r.top + (r.height - h) / 2;
  return { left, top, right: left + w };
}

// To the right of the card, or its left when the viewport has no room
// there; kept on screen either way.
function placePeek() {
  // Measured in the top corner, where nothing squeezes it; the place it
  // ends up is worked out from that size.
  peek.style.left = `${PEEK_EDGE}px`;
  peek.style.top = `${PEEK_EDGE}px`;
  const box = peek.getBoundingClientRect();
  const r = grownBox(peekCard);
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const right = r.right + PEEK_EDGE;
  const x = right + box.width > vw - PEEK_EDGE ? r.left - PEEK_EDGE - box.width : right;
  peek.style.left = `${Math.max(PEEK_EDGE, x)}px`;
  peek.style.top = `${Math.max(PEEK_EDGE, Math.min(r.top, vh - PEEK_EDGE - box.height))}px`;
}

// A finger has no hover: on a touch the panel would appear under the tap
// and stay there with nothing to move away.
table.addEventListener('pointerover', (e) => {
  // A menu is up to be chosen from; a panel over it, or over the card it
  // belongs to, is in the way.
  if (e.pointerType === 'touch' || menuOpen()) return;
  const card = e.target.closest('.card');
  // Crossing from the image onto a counter is not arriving at a new card.
  if (card && card !== peekCard) showPeek(card);
});

table.addEventListener('pointerout', (e) => {
  if (e.relatedTarget?.closest('.card') !== peekCard) hidePeek();
});

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
// it: a card's children are its own.
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

table.addEventListener('pointerdown', (e) => {
  const sq = e.target.closest('.counter');
  if (!sq || e.target.closest('button') || e.button !== 0) return;
  const layer = sq.parentElement;
  const card = sq.closest('.card');
  // The card the square is on is scaled up under the pointer, so a pixel of
  // pointer travel is less than a pixel of the square's own box; without
  // this the square would run ahead of the pointer dragging it. The size it
  // is heading for, not the one it has: the growing may still be under way.
  const scale = card.matches(':hover') ? CARD_ZOOM : 1;
  drag = { sq, layer, uid: card.dataset.uid, scale, startX: e.clientX, startY: e.clientY, left: sq.offsetLeft, top: sq.offsetTop, moved: false };
  sq.setPointerCapture?.(e.pointerId);
  e.preventDefault();
});

table.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = (e.clientX - drag.startX) / drag.scale;
  const dy = (e.clientY - drag.startY) / drag.scale;
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

table.addEventListener('pointerup', endDrag);
table.addEventListener('pointercancel', endDrag);

// --- the table --------------------------------------------------------

table.addEventListener('click', (e) => {
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
  // Everything else a card can do is in its menu; a left click on one is
  // the tap, and only on the battlefield.
  const card = e.target.closest('.card');
  if (card && e.target.tagName === 'IMG' && card.dataset.zone === 'battlefield') commit(G.toggleTap(game, card.dataset.uid));
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

// A second click on the button puts its own menu away again: openMenu's own
// doing, so every opener behaves the same way.
$('menu-game').addEventListener('click', (e) => openMenu(e.currentTarget, GAME_MENU));

// Where the staged card can go. Built afresh on each open, so the opponent
// it names is the one whose tab is up, not the one who was when the page
// loaded.
const cardMenu = () => [
  { label: 'send to my hand', run: () => place('me:hand') },
  { label: `${G.label(game, view.opp)} plays`, title: 'to their battlefield, or their graveyard if it is a spell', run: () => place('opp:play') },
  { label: 'send to my command zone', title: 'as my commander', run: () => place('me:command') },
  { label: `send to ${G.label(game, view.opp, 'possessive')} command zone`, title: 'as their commander', run: () => place('opp:command') },
];

// The button is disabled until the search stages something, so the menu is
// only ever opened with a card to act on.
$('menu-card').addEventListener('click', (e) => openMenu(e.currentTarget, cardMenu()));

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
