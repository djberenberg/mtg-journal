// The page half of the journal: drawing the table, and turning clicks and
// keys into calls on game.js. It never decides what a move means.
import * as G from './game.js';
import { autocomplete, lookup, NotFound } from './scryfall.js';

const SAVE_KEY = 'mtg-journal.game';
const UNDO_DEPTH = 100;
const SUGGEST_DELAY_MS = 200;

const $ = (id) => document.getElementById(id);
const q = $('q');
const suggest = $('suggest');
const status = $('status');
const logEl = $('log');
const undoBtn = $('undo');
const zones = new Map([...document.querySelectorAll('.zone')].map((z) => [`${z.dataset.owner}:${z.dataset.zone}`, z]));

// --- state ------------------------------------------------------------

let game = restore() ?? G.newGame();
const history = [];

function restore() {
  try { return G.load(localStorage.getItem(SAVE_KEY)); } catch { return null; }
}

function persist() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(game)); } catch { /* private window: play on */ }
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

// --- drawing ----------------------------------------------------------

// Card elements are kept, not rebuilt, so an image loads once and a card
// that changes zone moves rather than flickers. appendChild on an element
// already in the tree moves it, which also puts each zone in state order.
const cardEls = new Map();

const ACTIONS = {
  hand: [['play', 'play'], ['move', 'graveyard', 'grave'], ['move', 'exile', 'exile'], ['remove', '×']],
  battlefield: [['move', 'graveyard', 'grave'], ['move', 'exile', 'exile'], ['move', 'hand', 'hand'], ['remove', '×']],
  graveyard: [['move', 'battlefield', 'field'], ['move', 'hand', 'hand'], ['move', 'exile', 'exile'], ['remove', '×']],
  exile: [['move', 'battlefield', 'field'], ['move', 'hand', 'hand'], ['move', 'graveyard', 'grave'], ['remove', '×']],
};

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
    el.append(img, document.createElement('figcaption'));
    el.lastChild.className = 'actions';
    cardEls.set(c.uid, el);
  }
  el.classList.toggle('tapped', c.tapped);
  el.classList.toggle('permanent', G.isPermanent(c));
  if (el.dataset.zone !== c.zone) {
    el.dataset.zone = c.zone;
    el.lastChild.replaceChildren(...ACTIONS[c.zone].map(([act, a, b]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.act = act;
      if (act === 'move') { btn.dataset.zone = a; btn.textContent = b; } else btn.textContent = a;
      btn.title = act === 'move' ? `to ${a}` : act === 'remove' ? 'remove (a mistake)' : 'play';
      return btn;
    }));
  }
  return el;
}

function render() {
  const seen = new Set();
  for (const c of game.cards) {
    seen.add(c.uid);
    zones.get(`${c.owner}:${c.zone}`).appendChild(cardEl(c));
  }
  for (const [uid, el] of cardEls) {
    if (!seen.has(uid)) { el.remove(); cardEls.delete(uid); }
  }

  for (const el of document.querySelectorAll('[data-count]')) {
    const [owner, zone] = el.dataset.count.split(':');
    el.textContent = G.cardsIn(game, owner, zone).length;
  }
  // The opponent's hand is hidden information; show the pile only if we
  // have put something there.
  document.querySelector('[data-pile="opp:hand"]').hidden = G.cardsIn(game, 'opp', 'hand').length === 0;

  $('life-me').textContent = game.life.me;
  $('life-opp').textContent = game.life.opp;
  $('turn').textContent = `turn ${game.turn} · ${game.active === 'me' ? 'my' : "opponent's"} turn`;
  undoBtn.disabled = history.length === 0;

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
    setStatus(`${owner === 'me' ? 'to my hand' : 'opponent plays'}: ${card.name}`);
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
$('add-opp').addEventListener('click', () => add('opp'));

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
  if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); add('opp'); return; }
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

// --- the table --------------------------------------------------------

document.querySelector('.table').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn?.dataset.life) { commit(G.adjustLife(game, btn.dataset.life, Number(btn.dataset.by))); return; }
  const card = e.target.closest('.card');
  if (!card) return;
  const uid = card.dataset.uid;
  if (btn?.dataset.act === 'play') commit(G.play(game, uid));
  else if (btn?.dataset.act === 'move') commit(G.moveTo(game, uid, btn.dataset.zone));
  else if (btn?.dataset.act === 'remove') commit(G.remove(game, uid));
  else if (e.target.tagName === 'IMG' && card.dataset.zone === 'battlefield') commit(G.toggleTap(game, uid));
});

$('next').addEventListener('click', () => commit(G.nextTurn(game)));
undoBtn.addEventListener('click', undo);
$('new').addEventListener('click', () => {
  if (game.cards.length && !confirm('Start a new game? The current one is cleared.')) return;
  commit(G.newGame());
});

// "/" goes to the search box from anywhere, as on most sites.
window.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && document.activeElement !== q) { e.preventDefault(); undo(); }
});

render();
q.focus();
