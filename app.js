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
const stagedEl = $('staged');
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
// that changes zone moves rather than flickers.
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
    // What the card says, for a screen reader: the same words the hover
    // panel shows a pointer, which is hidden from the reader. A description
    // rather than more label, so focusing a card says which card and where
    // it is first, and the rules text after, where it can be skipped.
    const desc = document.createElement('div');
    desc.className = 'sr';
    desc.id = `card-desc-${c.uid}`;
    const d = details(c);
    desc.textContent = [d.manaCost, d.typeLine, d.oracleText, d.stats].filter(Boolean).join('. ');
    el.setAttribute('aria-describedby', desc.id);
    el.append(img, layer, desc);
    cardEls.set(c.uid, el);
  }
  renderCounters(el.querySelector('.counters'), c.counters ?? []);
  // Read before the line below changes it: a card leaving the battlefield is
  // untapped on the way out, and the ghost of it should be the card as it
  // was lying, not as it lands.
  const wasTurned = el.classList.contains('tapped');
  el.classList.toggle('tapped', c.tapped);
  el.classList.toggle('permanent', G.isPermanent(c));
  el.classList.toggle('commander', Boolean(c.commander));
  // The zone is on the element because the menu and the click handler both
  // ask the card where it is.
  if (el.dataset.zone !== c.zone) {
    const from = el.dataset.zone;
    // Measured where the card still is: render() puts it in its new zone in
    // the same frame, and the box it lands in is not the one it is leaving.
    const rect = from && el.isConnected ? el.getBoundingClientRect() : null;
    el.dataset.zone = c.zone;
    if (rect?.width) zoneEffect(el, rect, from, c.zone, wasTurned);
  }
  // Said out loud: which card, where it is, and what it is tucked in behind
  // — a reader hears the attachment a pointer can see.
  const host = c.attachedTo ? game.cards.find((x) => x.uid === c.attachedTo) : null;
  el.setAttribute('aria-label', `${c.name}, ${c.zone}${host ? `, on ${host.name}` : ''}`);
  return el;
}

// --- leaving a zone ---------------------------------------------------

// A card sent to the graveyard is torn up; one sent to exile is warped out
// of existence. Decoration, all of it: nothing here is game state, so
// nothing is committed and nothing is saved.
// The times are the ones the animations in style.css run for; they are
// here only to know when a ghost that never ended should be swept up.
const EFFECTS = { graveyard: { effect: 'tear', ms: 620 }, exile: { effect: 'warp', ms: 520 } };
const ARRIVE_MS = 200;
const stillness = matchMedia('(prefers-reduced-motion: reduce)');

function zoneEffect(el, rect, from, to, turned) {
  // A card arriving on the table for the first time was never anywhere to
  // leave: an opponent's instant, cast straight into their graveyard, does
  // not tear. One played from hand that resolves there does.
  if (!from || !EFFECTS[to]) return;
  if (!stillness.matches) ghost(el, rect, EFFECTS[to], turned);
  arrive(el);
}

// The card element itself is never animated: render() is moving it into its
// new zone in this same frame, and animating it would fight the layout.
// What plays is a throwaway copy, fixed over the table where the card was.
function ghost(el, rect, { effect, ms }, turned) {
  const src = el.querySelector('img').src;
  const g = document.createElement('div');
  g.className = 'ghost';
  g.dataset.effect = effect;
  g.ariaHidden = 'true';
  // A card that was lying on its side left a box that is the card's turned
  // over; the ghost is the upright card, turned the same way, so the art is
  // not squashed into a shape it never had.
  const w = turned ? rect.height : rect.width;
  const h = turned ? rect.width : rect.height;
  g.style.left = `${rect.left + (rect.width - w) / 2}px`;
  g.style.top = `${rect.top + (rect.height - h) / 2}px`;
  g.style.width = `${w}px`;
  g.style.height = `${h}px`;
  if (turned) g.style.rotate = '90deg';
  // The card's own src, so the copy is already in the browser's cache and
  // paints in the frame it is added rather than as a blank box.
  const copy = () => Object.assign(document.createElement('img'), { src, alt: '' });
  // The tear is two copies, each clipped to one side of a ragged edge down
  // the middle; the warp is one, stretched out of the plane.
  if (effect === 'tear') {
    for (let i = 0; i < 2; i++) {
      const half = document.createElement('div');
      half.className = 'ghost-half';
      half.append(copy());
      g.append(half);
    }
  } else g.append(copy());
  document.body.append(g);
  // Gone when it ends, and gone anyway a little after: a backgrounded tab
  // never fires animationend, and a ghost left behind would sit over the
  // table for the rest of the game.
  const drop = () => { clearTimeout(timer); g.remove(); };
  const timer = setTimeout(drop, ms + 200);
  g.addEventListener('animationend', drop);
}

// The card, now in its new zone, fades in where it lands. The animation is
// on its image rather than the figure, which is where the zoom under the
// pointer lives: an animation beats a plain declaration while it runs, so a
// card arriving under the pointer would drop out of its zoom and snap back
// into it at the end.
function arrive(el) {
  el.classList.remove('arriving');
  void el.offsetWidth; // a second change of zone plays again rather than being swallowed
  el.classList.add('arriving');
  const done = () => { clearTimeout(timer); el.removeEventListener('animationend', done); el.classList.remove('arriving'); };
  const timer = setTimeout(done, ARRIVE_MS + 200);
  el.addEventListener('animationend', done);
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

// The row of tickers under a life total: one per commander that could be
// hitting this side — anyone's but their own, mine included on their row.
// The elements are kept and their numbers updated, as the counters are, so
// pressing + does not pull the button out from under the pointer.
function renderCmdDamage(side, recipient) {
  const row = $(`cmd-dmg-${side}`);
  const seen = new Set();
  let i = 0;
  for (const c of G.commanders(game)) {
    if (c.owner === recipient) continue; // it deals none to its own controller
    seen.add(c.uid);
    let t = row.querySelector(`[data-uid="${c.uid}"]`);
    if (!t) {
      t = document.createElement('span');
      t.className = 'ticker';
      t.dataset.uid = c.uid;
      t.role = 'group';
      t.setAttribute('aria-label', c.name);
      t.innerHTML = '<span class="cmd-name"></span><span class="n"></span><button type="button" data-cmd="-1">−</button><button type="button" data-cmd="1">+</button>';
      const name = t.querySelector('.cmd-name');
      name.textContent = c.name;
      name.title = c.name; // the box truncates it
      // Named one by one rather than built into the markup: a card name is
      // Scryfall's text, and some of them carry quotes.
      t.querySelector('[data-cmd="-1"]').setAttribute('aria-label', `One fewer from ${c.name}`);
      t.querySelector('[data-cmd="1"]').setAttribute('aria-label', `One more from ${c.name}`);
    }
    if (row.children[i] !== t) row.insertBefore(t, row.children[i] ?? null);
    i += 1;
    const tally = game.cmdDamage?.[recipient]?.[c.uid] ?? 0;
    t.querySelector('.n').textContent = tally;
    // Twenty-one from one commander is lethal, and says so across the table.
    t.classList.toggle('lethal', tally >= 21);
    t.title = `${tally} commander damage from ${c.name}${tally >= 21 ? ': lethal' : ''}`;
  }
  for (const t of [...row.children]) if (!seen.has(t.dataset.uid)) t.remove();
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
  // Not while its input is open: a typed-but-uncommitted total would be
  // overwritten out from under the player.
  if (lifeEditing !== 'opp') $('life-opp').textContent = game.life[view.opp];
  renderCmdDamage('opp', view.opp);
}

// The order the table draws in: the order of the state, except that an
// equipment attached to a creature gives up its own place and follows its
// host, so it can be tucked in behind it wherever the host has got to. A
// creature with several keeps them in the order the state has them.
function drawOrder(cards) {
  const here = new Set(cards.map((c) => c.uid));
  const worn = new Map();
  for (const c of cards) {
    if (c.attachedTo && here.has(c.attachedTo)) worn.set(c.attachedTo, [...(worn.get(c.attachedTo) ?? []), c]);
  }
  const out = [];
  for (const c of cards) {
    if (c.attachedTo && here.has(c.attachedTo)) continue; // drawn with its host instead
    out.push(c, ...(worn.get(c.uid) ?? []));
  }
  return out;
}

function render() {
  renderOpponents();

  // Moving an element blurs it, and every card that is drawn is moved; the
  // keyboard would lose the card it was on at each commit.
  const hadFocus = document.activeElement?.closest('.card');

  const inGame = new Set(game.cards.map((c) => c.uid));
  const shown = new Set(game.cards.filter((c) => c.owner === 'me' || c.owner === view.opp).map((c) => c.uid));
  // Whatever is not on the table leaves first: a removed card, or one
  // belonging to an opponent whose tab is down (kept, not shown). Taking
  // them out before the rest are placed means the cards that stay are not
  // shuffled along past an element that is on its way out anyway.
  for (const [uid, el] of cardEls) {
    if (shown.has(uid)) continue;
    el.remove();
    if (!inGame.has(uid)) cardEls.delete(uid);
  }

  // Where the next card goes in each place, so a card already standing
  // there is left alone. Inserting an element that is already in the tree
  // moves it, and a moved element starts its CSS over: the zoom under the
  // pointer would snap back, and an arrival would play again at every
  // commit. Only the cards that really changed place are touched.
  const next = new Map();
  const hosts = new Set(game.cards.map((c) => c.attachedTo).filter(Boolean));
  for (const c of drawOrder(game.cards.filter((x) => shown.has(x.uid)))) {
    const el = cardEl(c);
    const place = placeFor(c.owner === 'me' ? 'me' : 'opp', c);
    const i = next.get(place) ?? 0;
    next.set(place, i + 1);
    // Tucked in behind its host only where it has really landed behind it:
    // straight after the host, or after another equipment already tucked in
    // behind the same card. A host in the other row — an equipment on a land
    // creature — leaves it an ordinary card in its own row. The host carries
    // a class of its own because it needs a z-index to be drawn over what is
    // tucked in behind it; what is tucked in says whose it is, so the next
    // one along can find the pile it belongs to and a drag can tell what
    // goes with the card it is carrying.
    const prev = place.children[i - 1];
    const tucked = Boolean(c.attachedTo) && (prev?.dataset.uid === c.attachedTo || prev?.dataset.host === c.attachedTo);
    el.classList.toggle('has-equipment', hosts.has(c.uid));
    el.classList.toggle('attached', tucked);
    if (tucked) el.dataset.host = c.attachedTo;
    else delete el.dataset.host;
    if (place.children[i] !== el) place.insertBefore(el, place.children[i] ?? null);
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

  if (lifeEditing !== 'me') $('life-me').textContent = game.life.me;
  renderCmdDamage('me', 'me');
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
    setStatus(`${card.name} — right-click it to place it`);
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

// The slot, acted on by right-clicking it like a card on the table.
function renderStaged() {
  stagedEl.hidden = !staged;
  if (!staged) return;
  $('staged-img').src = staged.image;
  $('staged-name').textContent = staged.name;
  // Named and flagged as staged, the way a card on the table says its own
  // name and zone: a screen reader hears what it is before reaching the menu.
  stagedEl.setAttribute('aria-label', `${staged.name}, staged`);
}

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

// Whatever the arrow keys have landed on is the card meant, whichever way
// the lookup was asked for: without this, clicking the button would send the
// half-typed text to the fuzzy lookup while enter would have taken the
// suggestion.
$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  if (selected >= 0) { q.value = names[selected]; closeSuggestions(); }
  stage();
});
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
  if (e.key === 'Escape' && waiting) { e.preventDefault(); discard(); return; }
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

// Escape calls off whatever is in hand: the menu that is up, or the card
// being carried, which goes back where it was picked up from.
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (drag?.card) endDrag(false); closeMenu(); } });

// Any click outside closes it. The opener's own click is its toggle, which
// is handled where the menu is opened; this runs after that.
document.addEventListener('click', (e) => {
  if (menuOpen() && !menu.contains(e.target) && !menuOpener.contains(e.target)) closeMenu();
});

// And any right-click outside, which sends no click at all: without this the
// browser's own menu would come up over ours and the two would sit there
// together. A right-click that opens a menu of its own runs first — the
// handlers that do are on the table and on the slot, below this one in the
// tree — so by the time this fires the new opener is the card under the
// pointer, and its own menu is left alone.
document.addEventListener('contextmenu', (e) => {
  if (!menuOpen()) return;
  // Landing on the menu itself: there is nothing to choose with the right
  // button, so ours stays up — and the browser's is turned away here too,
  // or it would sit on top of the very menu it was aimed at.
  if (menu.contains(e.target)) { e.preventDefault(); return; }
  if (!menuOpener.contains(e.target)) closeMenu();
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

// The cards beside this one in its row: its owner's half of one battlefield
// row, which is as far as a card can be moved along. The same run
// reorderCard works within, in the same order the row is drawn in — an
// attached equipment left out of it, since it is drawn behind its host and
// goes wherever the host goes. A card that is itself attached is in no run,
// so it is offered no move, which is what reorderCard would say too.
const runFor = (c) => G.cardsIn(game, c.owner, 'battlefield').filter((x) => G.isLand(x) === G.isLand(c) && !x.attachedTo);

// Stepping along the row a place at a time, for the keyboard and for a
// finger: dragging is a mouse and a pen only, and a card's place on the
// table should not be theirs alone. Offered only where there is a
// neighbour to step over — at the end of a run there is nowhere to go.
function moveItems(uid, zone) {
  const c = zone === 'battlefield' ? game.cards.find((x) => x.uid === uid) : null;
  if (!c) return [];
  const run = runFor(c);
  const i = run.findIndex((x) => x.uid === uid);
  const items = [];
  // Left is in front of the neighbour on the left; right is in front of
  // whatever follows the one on the right, and nothing following it means
  // the end of the row.
  if (i > 0) items.push({ label: 'move left', title: 'one place earlier in its row', run: () => commit(G.reorderCard(game, uid, run[i - 1].uid)) });
  if (i >= 0 && i < run.length - 1) items.push({ label: 'move right', title: 'one place later in its row', run: () => commit(G.reorderCard(game, uid, run[i + 2]?.uid ?? null)) });
  return items;
}

// What an equipment on the battlefield can be put on: one item per creature
// its owner has out, named, in the order they sit on the table. A target
// picked from the menu rather than by pointing at a card afterwards — the
// menu has no submenus, and a mode where the next click means something
// else would be a second way of working the table for one feature's sake.
function equipItems(uid, zone) {
  const c = zone === 'battlefield' ? game.cards.find((x) => x.uid === uid) : null;
  if (!c || !G.isEquipment(c)) return [];
  const creatures = G.cardsIn(game, c.owner, 'battlefield').filter((x) => G.isCreature(x) && x.uid !== uid);
  // Said rather than left out: with nothing to equip, the reason is the
  // answer to why the items are missing.
  if (!creatures.length) return [{ label: 'no creature to equip', title: 'its owner has none on the battlefield to put it on', disabled: true }];
  const items = creatures.map((h) => ({
    label: `equip ${h.name}`,
    title: `tucked in behind ${h.name}`,
    disabled: h.uid === c.attachedTo,
    run: () => commit(G.equip(game, uid, h.uid)),
  }));
  if (c.attachedTo) items.push({ label: 'unequip', title: 'off again, and back in the row', run: () => commit(G.unequip(game, uid)) });
  return items;
}

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
  items.push(...moveItems(uid, zone), ...equipItems(uid, zone));
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
  // A hand is on the card already: a menu over what is being carried would
  // be asking about a card that is halfway somewhere else.
  if (drag) { e.preventDefault(); return; }
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
  // belongs to, is in the way. So is one about a card being carried, which
  // would follow it over every card it passes.
  if (e.pointerType === 'touch' || menuOpen() || drag?.card) return;
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

// --- dragging ---------------------------------------------------------

// Two things on the table are dragged: a counter square about its card, and
// a card into a new place in its row. One press starts either, and both wait
// for the pointer to travel a little before anything moves, so a press that
// stays put is still the click it looks like.
//
// A square's position is set in pixels while the pointer is down and
// committed, when it is let go, as a fraction of the room it has to move in;
// so it keeps its place on the card when the card changes size or turns on
// its side, and never pokes out.
let drag = null;
// The click the browser sends after a drag is the drag's own, not a tap.
// Cleared at the next press, so it can never eat a later click.
let dragged = false;

const CARD_DRAG_PX = 4; // a card is a bigger thing to nudge than a square, whose threshold is 3

// Any press at all, anywhere: the flag belongs to the gesture just ended,
// and a press that starts a new one — on the table or off it — ends its
// claim on the next click.
window.addEventListener('pointerdown', () => { dragged = false; }, true);

table.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button') || e.target.closest('.ctr-pick')) return;
  const sq = e.target.closest('.counter');
  if (sq) {
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
    return;
  }
  // A card on the battlefield is picked up and put down elsewhere in its own
  // row; a tier is the row, and only the battlefield has them. Mouse and pen
  // only: claiming a touch would need touch-action: none on every card,
  // which would stop a phone scrolling the page. Tap-to-tap still works.
  if (e.pointerType === 'touch') return;
  const card = e.target.closest('.card');
  const tier = card?.closest('.tier');
  if (!tier) return;
  // An attached equipment sits where its host sits and has no place of its
  // own in the row, so there is nowhere to carry it to. Asked of the game
  // rather than of the class: an equipment on a land creature is attached
  // without being drawn tucked in — its host is in the other row — and
  // reorderCard would refuse the drop it was carried to all the same.
  if (game.cards.find((x) => x.uid === card.dataset.uid)?.attachedTo) return;
  // Where it came from, to put it back if the drag comes to nothing.
  drag = { card, tier, home: card.nextElementSibling, startX: e.clientX, startY: e.clientY, moved: false };
});

// Where the card lies when it is not being carried: the inline transform is
// the carrying, and while it is off the hover zoom is off with it, so what
// comes back is the box the row has laid out for it.
function restingBox(el) {
  const held = el.style.transform;
  el.style.transform = 'none';
  const box = el.getBoundingClientRect();
  el.style.transform = held;
  return box;
}

// Whether the pointer is over the row the card came from. A drag reorders
// one row: taken outside it the card is on its way nowhere, so the row is
// left as it is until the pointer comes back.
function overTier(x, y) {
  const r = drag.tier.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// Live reordering rather than a marker: as the pointer passes the middle of
// a neighbour, the card takes its place there and then, so the row shows the
// order it will be left in. render() draws in state order, so the commit
// that follows finds every card already where it belongs and moves nothing.
function reorderUnder(x, y) {
  let next = [...drag.tier.children].find((el) => {
    // A creature and what is tucked in behind it are one thing to drop in
    // front of or behind: the equipment is no place of its own to stop at,
    // and stopping there would put the card somewhere render() would not.
    if (el === drag.card || el.classList.contains('attached')) return false;
    const r = el.getBoundingClientRect();
    return y < r.top || (y < r.bottom && x < r.left + r.width / 2); // an earlier row, or this one's near half
  }) ?? null;
  // Back over whatever is tucked in behind the card being carried, which
  // goes where it goes: without this a creature picked up and put down
  // where it was would land after its own equipment, which draws the same
  // and would still cost an undo step and a save.
  let back = next ? next.previousElementSibling : drag.tier.lastElementChild;
  while (back?.dataset.host === drag.card.dataset.uid) {
    next = back;
    back = back.previousElementSibling;
  }
  if (next !== drag.card.nextElementSibling) drag.tier.insertBefore(drag.card, next);
}

// The card follows the pointer from wherever the row has just put it, so the
// same spot on it stays under the pointer as its neighbours shuffle about.
function carry(x, y) {
  const r = restingBox(drag.card);
  drag.card.style.transform = `translate(${x - r.left - drag.grabX}px, ${y - r.top - drag.grabY}px)`;
}

function onPointerMove(e) {
  if (!drag) return;
  if (drag.sq) {
    const dx = (e.clientX - drag.startX) / drag.scale;
    const dy = (e.clientY - drag.startY) / drag.scale;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    drag.sq.classList.add('dragging');
    const maxX = drag.layer.clientWidth - drag.sq.offsetWidth;
    const maxY = drag.layer.clientHeight - drag.sq.offsetHeight;
    drag.sq.style.left = `${Math.max(0, Math.min(maxX, drag.left + dx))}px`;
    drag.sq.style.top = `${Math.max(0, Math.min(maxY, drag.top + dy))}px`;
    return;
  }
  if (!drag.moved && Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) < CARD_DRAG_PX) return;
  if (!drag.moved) {
    drag.moved = true;
    drag.card.classList.add('dragging');
    // Measured before the first step, so the card is picked up by the point
    // it was pressed on rather than jumping to its middle.
    const r = restingBox(drag.card);
    drag.grabX = drag.startX - r.left;
    drag.grabY = drag.startY - r.top;
    hidePeek(); // a panel about the card in hand, following it over the others
    closeMenu();
  }
  if (overTier(e.clientX, e.clientY)) reorderUnder(e.clientX, e.clientY);
  carry(e.clientX, e.clientY);
}

// keep tells a drop from a drag that came to nothing: a card released
// outside its row, cancelled, or called off with Escape goes back where it
// was picked up from and commits nothing. A square is let go where it lies
// either way: it never left the card it belongs to.
function endDrag(keep = true) {
  if (!drag) return;
  const { sq, layer, uid, card, tier, home, moved } = drag;
  drag = null;
  if (sq) {
    sq.classList.remove('dragging');
    if (!moved) return;
    const roomX = layer.clientWidth - sq.offsetWidth;
    const roomY = layer.clientHeight - sq.offsetHeight;
    commit(G.moveCounter(game, uid, sq.dataset.cid, roomX > 0 ? sq.offsetLeft / roomX : 0, roomY > 0 ? sq.offsetTop / roomY : 0));
    render(); // the commit may be a no-op (same place); put the fractions back either way
    return;
  }
  card.classList.remove('dragging');
  card.style.transform = '';
  if (!moved) return;
  dragged = true; // the click that follows is this drag's, not a tap
  // Back where it came from — unless what it stood in front of has gone in
  // the meantime, in which case the end of the row is as near as it gets.
  if (!keep) { tier.insertBefore(card, home?.isConnected ? home : null); return; }
  // The element is already where it was dropped: the card in front of it is
  // the one to go in front of, and nothing after it means the end of the row.
  commit(G.reorderCard(game, card.dataset.uid, card.nextElementSibling?.dataset.uid ?? null));
  render(); // the commit may be a no-op (the order it already had); draw the row back either way
}

function onPointerUp(e) {
  // A card let go anywhere but the row it came from was never going there:
  // a drag reorders one row, and does not move a card out of it.
  endDrag(!drag?.card || overTier(e.clientX, e.clientY));
}

// On the window, not the table: a card is let go wherever the pointer has
// got to, and one released over the log or off the page would otherwise
// still be stuck to it.
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', () => endDrag(false));

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
  // A tick of commander damage is a hit: game.js takes the life with it.
  if (btn?.dataset.cmd) {
    const row = btn.closest('.cmd-dmg');
    commit(G.adjustCommanderDamage(game, row.dataset.side === 'me' ? 'me' : view.opp, btn.closest('.ticker').dataset.uid, Number(btn.dataset.cmd)));
    return;
  }
  // A press that travelled was a drag, and the click it ends with is the
  // drag's: the card was carried, not pointed at.
  if (dragged) { dragged = false; return; }
  // Everything else a card can do is in its menu; a left click on one is
  // the tap, and only on the battlefield.
  const card = e.target.closest('.card');
  if (card && e.target.tagName === 'IMG' && card.dataset.zone === 'battlefield') commit(G.toggleTap(game, card.dataset.uid));
});

// --- life, typed --------------------------------------------------------

// Which life total has its input open: 'me', 'opp', or null for neither.
// render() reads this too, so it never overwrites what is being typed.
let lifeEditing = null;

const lifeEls = (group) => { const out = $(`life-${group}`); return { out, input: out.nextElementSibling }; };

function openLifeEdit(group) {
  const { out, input } = lifeEls(group);
  lifeEditing = group;
  input.value = out.textContent;
  out.hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

// Shared by both Enter (via the input's own blur) and Escape: the input
// goes away and the total comes back either way, so a stray blur after
// Escape has already closed it never fires a second commit.
function closeLifeEdit(group) {
  const { out, input } = lifeEls(group);
  lifeEditing = null;
  input.hidden = true;
  out.hidden = false;
}

for (const group of ['me', 'opp']) {
  const { out, input } = lifeEls(group);
  out.addEventListener('click', () => openLifeEdit(group));
  out.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); openLifeEdit(group); } });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); } // blur does the committing
    else if (e.key === 'Escape') { e.preventDefault(); closeLifeEdit(group); out.focus(); }
  });
  input.addEventListener('blur', () => {
    if (lifeEditing !== group) return; // already closed, by Escape
    const raw = input.value.trim();
    closeLifeEdit(group);
    if (raw !== '' && Number.isFinite(Number(raw))) commit(G.setLife(game, group === 'me' ? 'me' : view.opp, Number(raw)));
  });
}

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
      $('new-life').value = game.startingLife;
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

// The slot is acted on exactly like a card on the table: a right-click drops
// its menu at the pointer, and — since the slot is hidden while empty — this
// can only fire on a card actually staged there.
stagedEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // As on the table: a hand is on a card already, so a menu about the staged
  // one would be asking about neither card the player is holding.
  if (drag) return;
  openMenu(stagedEl, cardMenu(), { x: e.clientX, y: e.clientY });
});

// Enter opens the same menu hanging under the slot, the same contract a card
// on the table has. Guarded to the slot itself so enter on the × discards
// rather than opening a menu behind it.
stagedEl.addEventListener('keydown', (e) => {
  if (e.target !== stagedEl) return;
  if (e.key === 'Enter' || e.key === 'ContextMenu') { e.preventDefault(); openMenu(stagedEl, cardMenu()); }
});

$('new-cancel').addEventListener('click', () => dialog.close());

// A preset fills the field for editing, same as typing it; it does not
// start the game itself, so an accidental click costs nothing.
for (const btn of dialog.querySelectorAll('.preset')) {
  btn.addEventListener('click', () => { $('new-life').value = btn.dataset.lifePreset; });
}

$('new-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  commit(G.newGame({ opponents: Number(f.get('opponents')), life: Number(f.get('life')) }));
  dialog.close();
  show('opp1');
  q.focus();
});

// "/" goes to the search box from anywhere, as on most sites, and ctrl+Z
// undoes from anywhere. Neither reaches a field being typed in: not only the
// search box but a life total being edited, whose blur would commit the half
// typed number, and the counter kind, where "/" is most of what is typed —
// "+1/+1" and "-1/-1" are the kinds the picker is there for.
window.addEventListener('keydown', (e) => {
  if (dialog.open || menuOpen()) return;
  const typing = document.activeElement?.matches?.('input, textarea');
  if (e.key === '/' && !typing) { e.preventDefault(); q.focus(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !typing) { e.preventDefault(); undo(); }
});

render();
q.focus();
