# Card menu, navbar, staging, and typed life

Approved in chat on 2026-09-24. The journal is a static-file app: `game.js`
(pure rules, no DOM), `scryfall.js` (API client), `app.js` (the page),
`index.html` + `style.css`. Tests: `node --test tests/*.test.mjs` for the
rules and the client, `node tests/browser.mjs` for the page in headless
Chrome with Scryfall stubbed from `tests/fixtures/`.

## Global Constraints

- **`game.js` stays pure.** No DOM, no fetch, no storage. Every exported
  function takes a state and returns a new one. The state stays plain JSON.
  Anything view-only (what is staged, which menu is open) lives in `app.js`'s
  `view` object or in module-local variables, never in the game state.
- **Every state change goes through `commit()`** in `app.js`, so undo and the
  save keep working. View-only changes call `persist()` + `render()` instead.
- **Card elements are kept, not rebuilt** (`cardEls`). Do not change that:
  an image must load once, and a card that changes zone moves rather than
  flickers.
- **Match the house style.** Lowercase UI labels ("new game", "to my hand"),
  comments that say *why* rather than *what*, CSS custom properties from
  `:root`, no new dependencies, no build step. The whole app is ES modules
  loaded directly by the browser.
- **Tests must pass before a task is committed.** Run the commands from the
  repo root with `export PATH=$HOME/.local/opt/node/bin:$PATH`:
  - `node --test tests/*.test.mjs`
  - `CHROME=$HOME/.local/opt/chrome-headless-shell/chrome-headless-shell node tests/browser.mjs`
  The browser run prints `PASS`/`FAIL` per check and exits non-zero on any
  failure. A task that changes the page MUST leave both green — including
  the existing checks, which means updating any check whose selector or
  interaction the task changed.
- **Accessibility does not regress.** Everything reachable by keyboard today
  stays reachable. Menus get `role="menu"`/`role="menuitem"`, arrow-key
  movement, Escape to close, and focus returned to the opener.

## Task 1 — `setLife` in the rules, and life the dialog can type

**Files:** `game.js`, `tests/game.test.mjs`

Add one exported function to `game.js`, beside `adjustLife`:

```js
export function setLife(state, player, value)
```

- Returns `state` unchanged if `player` is not one of `players(state)`, if
  `value` is not a finite number after `Number(value)`, or if the value
  equals the player's current life.
- Otherwise rounds to an integer, sets `life[player]`, and logs through
  `say`. Log text: `` `${label(state, player, 'possessive')} life is now ${n}` ``
  — e.g. `my life is now 34`, `opponent 2's life is now 12`.
- Life may go negative or to zero. No clamping: the journal records what
  happened, it does not enforce the rules.

Also harden `newGame`'s `life`: it currently trusts the number it is given.
Add a `clampLife` helper (module-local, not exported) used by `newGame`:
`Math.round(Number(life))`, falling back to `20` when that is `NaN`, and
clamped to the range `1`–`999`. `resetGame` already reads `state.startingLife`
and needs no change.

**Tests** in `tests/game.test.mjs`, following the file's existing style:
- `setLife` sets my life and logs `my life is now 34`
- `setLife` sets a named opponent's life with the possessive label
- `setLife` accepts `0` and negative values
- `setLife` returns the same state object for an unknown player, a
  non-numeric value, and a value equal to the current life
- `setLife` rounds a fractional value
- `newGame({ life: 40 })` gives every seat 40, and the log line says 40
- `newGame({ life: 'x' })` falls back to 20; `newGame({ life: 5000 })`
  clamps to 999; `newGame({ life: 0 })` clamps to 1

## Task 2 — the dropdown primitive and the navbar's Game menu

**Files:** `index.html`, `app.js`, `style.css`, `tests/browser.mjs`

One menu mechanism serves the navbar (this task), the Card menu (Task 5),
and the card right-click menu (Task 3). Build it here, general enough for
all three, and no more general than that.

**Markup.** Add a navbar directly above the search form inside `<header class="bar">`,
so it is the first child of the header:

```html
<nav class="navbar" id="navbar" aria-label="Actions">
  <button type="button" class="menu-btn" id="menu-game" aria-haspopup="menu" aria-expanded="false">game</button>
  <button type="button" class="menu-btn" id="menu-card" aria-haspopup="menu" aria-expanded="false" disabled>card</button>
</nav>
```

The `card` button is created disabled and stays that way until Task 5 gives
it a staged card. Do not wire it in this task beyond existing in the markup.

Add one popup element for the page, a sibling of the dialog near the end of
`<main>`:

```html
<div class="menu" id="menu" role="menu" hidden></div>
```

**The primitive** in `app.js`. A small section with these three functions:

```js
function openMenu(opener, items, at)   // at: {x, y} for a pointer menu, or omitted to hang under `opener`
function closeMenu()
function menuOpen()                     // boolean
```

- `items` is an array of `{ label, title?, disabled?, run() }`, plus the
  literal string `'-'` for a separator rule. `openMenu` fills `#menu` with a
  `<button type="button" role="menuitem">` per item and `<hr role="separator">`
  per separator.
- Position: `position: fixed`. Given `at`, the menu's top-left goes to the
  pointer; otherwise it goes to the opener's bottom-left. Either way it is
  clamped to the viewport with an 8px margin, flipping above/left when there
  is not room below/right. Measure after filling and unhiding.
- The opener's `aria-expanded` becomes `"true"` while open and `"false"` when
  closed; `closeMenu` returns focus to the opener.
- Opening a menu closes any menu already open. `closeMenu` on an already
  closed menu is a no-op.
- Closes on: Escape, a click anywhere outside `#menu`, the window scrolling
  or resizing, and choosing an item (close first, then `run()`, so a
  `run()` that opens a dialog keeps focus).
- Keyboard: ArrowDown/ArrowUp move between enabled items and wrap,
  Home/End jump to first/last, Enter or Space activates. Focus lands on the
  first enabled item when the menu is opened from a keypress on the opener,
  and on the menu container otherwise so the pointer user's mouse is not
  fighting a focus ring. Disabled items are skipped by the arrows and are
  not clickable.

**The Game menu.** Wire `#menu-game` to open a menu with two items:
- `new game` — title "start over; asks for opponents and life", runs exactly
  what the current `$('new')` click handler runs (set `#new-warn` hidden
  state, then `dialog.showModal()`).
- `reset game` — title "clear the table, same opponents and life", runs
  exactly what the current `$('reset')` click handler runs.

Then **remove the `#new` and `#reset` buttons** from the turnbar in
`index.html` and their now-dangling listeners in `app.js`. The turn label,
`next turn`, `undo`, and `log` stay exactly where they are.

**Style.** The navbar is a thin row of text-like buttons above the search,
in the muted colour, going full-strength on hover and while their menu is
open. The popup uses `--raised`, `--border`, `radius 8px`, and the same
`box-shadow` as `.suggest`, with `z-index` above `.suggest` (which is 3).
Menu items are full-width, left-aligned, `0.85rem`, transparent until
hovered or focused, then `--accent` on `--accent-ink` like `.suggest li`.
A disabled item is `--muted` and shows no hover. The separator is a 1px
`--border` rule with small vertical margins.

**Tests.** In `tests/browser.mjs`: the old checks that click `#new`,
`#reset`, or `#new-cancel` must now go through the menu. Add checks that
- the navbar's `game` button opens a menu with the two items, and
  `aria-expanded` flips
- Escape closes it and focus returns to the button
- choosing `reset game` clears the table, exactly as the old `#reset` check did
- choosing `new game` opens the dialog
- the `card` button starts disabled
- clicking outside closes an open menu

## Task 3 — the card right-click menu

**Files:** `app.js`, `index.html`, `style.css`, `tests/browser.mjs`

**Remove the hover action strip entirely.** Delete the `figcaption.actions`
element from `cardEl`, the block that rebuilds it when `dataset.zone`
changes, and the `.card .actions` rules in `style.css`. The `ACTIONS`,
`ACTION_TITLE`, and `ZONE_TITLE` tables stay — they become the menu's
contents — but their labels get spelled out (see below). Keep
`el.dataset.zone = c.zone` up to date: the menu reads it.

**Open the menu** on `contextmenu` on any `.card` inside `.table`:
`preventDefault()`, then `openMenu(card, itemsFor(card), { x: e.clientX, y: e.clientY })`.
Right-clicking a different card moves the menu to it. A right-click on a
counter square opens the card's menu too — the square is part of the card.

**The items**, built from the card's zone, in this order, skipping any
that do not apply:

| item | shown when | runs |
| --- | --- | --- |
| `play` | zone is `hand` | `G.play(game, uid)` |
| `copy` | always | `G.copyCard(game, uid)` |
| `add counter…` | zone is not `hand` (matches today's `ACTIONS`) | `openPicker(cardEl)` |
| `-` | before the first move item | |
| `to the battlefield` | not already there | `G.moveTo(game, uid, 'battlefield')` |
| `to hand` | not already there | `G.moveTo(game, uid, 'hand')` |
| `to the graveyard` | not already there | `G.moveTo(game, uid, 'graveyard')` |
| `to exile` | not already there | `G.moveTo(game, uid, 'exile')` |
| `to the command zone` | not already there | `G.moveTo(game, uid, 'command')` |
| `-` | before remove | |
| `remove` | always | `G.remove(game, uid)` |

This is a superset of today's per-zone lists, and deliberately so: the old
lists omitted destinations for no reason a player could predict (a card in
hand could not go to the battlefield). Every zone but the card's own is now
offered. `play` stays hand-only because that is what `G.play` accepts.
`add counter…` stays off cards in hand, as today.

Give `remove` the title "the card was never there (a mistake)" and `copy`
the title "another of this card, beside it".

**Keyboard access.** The action strip was the cards' only keyboard path and
it is going away. Give each card `tabindex="0"` and a `role="button"` with
an `aria-label` of the card's name and zone (e.g. `Llanowar Elves, battlefield`).
On `keydown`: Enter or Space opens the menu hanging under the card (no `at`),
and so does the ContextMenu key. On a battlefield permanent, Enter also
needs to be able to tap — resolve this by making Space the tap on the
battlefield and Enter always the menu; say so in the README (Task 7).

**Left-click keeps working unchanged**: clicking a permanent's image on the
battlefield taps it, via the existing `.table` click handler. Make sure the
handler no longer looks for `button[data-act]`, which no longer exists.

**Style.** Reuse `.menu` from Task 2. Cards get `cursor: context-menu` off
the battlefield so there is a hint that a right-click does something, and
keep `cursor: pointer` on battlefield permanents where a click taps.

**Tests.** Rewrite every browser check that clicks `button[data-act="…"]`
— they are the bulk of the file — to right-click the card and choose the
menu item by its text. Add a helper near the other helpers:

```js
const menuPick = async (sel, label) => { /* dispatch a right-click at the element's centre, then click the menu item whose text is `label` */ };
```

Right-click via `Input.dispatchMouseEvent` with `button: 'right'`,
`buttons: 2`, `clickCount: 1`, both `mousePressed` and `mouseReleased`.
Add checks that:
- right-clicking a card in hand offers `play`, `copy`, and every zone but
  hand, and does not offer `add counter…`
- right-clicking a battlefield card offers `add counter…` and `to hand`
- choosing `copy` puts a second card of the same name beside the first
- choosing `to the command zone` moves it there and the card wears `cmd`
- Escape closes the menu without acting
- a card is focusable and Enter opens its menu

## Task 4 — hover: a bigger card and a styled panel

**Files:** `app.js`, `index.html`, `style.css`, `tests/browser.mjs`

**Drop the native tooltip.** `cardEl` no longer sets `el.title`. Keep
`describe(c)` — the panel uses the same content — but return the parts
rather than a string: rename it to `details(c)` returning
`{ name, manaCost, typeLine, oracleText, stats }` where `stats` is
`"3/4"`, `"loyalty 4"`, or `null`. Keep `img.alt = c.name`.

**The panel.** One element for the page, beside `#menu`:

```html
<div class="peek" id="peek" hidden aria-hidden="true"></div>
```

It is decorative: screen readers get the card's `aria-label` from Task 3,
so the panel stays `aria-hidden` and out of the tab order.

On `pointerover` of a `.card` within `.table` (delegated, and ignoring
`pointerType === 'touch'`), fill `#peek` with the card's details and place
it `position: fixed` beside the card: to the right of the card's box with
an 8px gap, flipped to the left when it would cross the viewport's right
edge, and vertically clamped to the viewport with an 8px margin. Hide it on
`pointerout` that leaves the card, on scroll, on any menu opening, and
whenever the card it describes leaves the DOM. Width about 17rem.

Fill it with real elements, not `innerHTML` of card text: a `.peek-name`
row holding the name and the mana cost, a `.peek-type` row, a
`.peek-text` block whose newlines survive (`white-space: pre-wrap`), and a
`.peek-stats` row when `stats` is not null. Leave out any row whose content
is empty.

**The zoom.** `.card:hover` scales `1.06` from the centre and raises
`z-index` to sit above its neighbours, with a `0.12s ease` transition,
reusing the transition already on `.card`. A tapped card keeps its rotation:
scale the `.card` box, not the image, so `transform: rotate(90deg)` on the
image is untouched. Cards in a `.pile` scale too. Nothing may change the
layout — the zone must not reflow when a card grows, so the scale is a
`transform`, never a width change.

**Tests.** In `tests/browser.mjs`:
- the existing check that reads `.card.title` for "{U}" and the type line
  must move to the panel: hover the card, read `#peek`'s text
- hovering shows the panel with name, cost, type line, and oracle text
- moving off the card hides it
- no `.card` element has a `title` attribute any more
- a hovered card's rendered box is wider than an unhovered sibling's while
  the zone's own width is unchanged

Hover via `Input.dispatchMouseEvent` `mouseMoved` at the card's centre.

## Task 5 — the staging slot and the Card menu

**Files:** `index.html`, `app.js`, `style.css`, `tests/browser.mjs`

Today the search box adds straight to the table. It now stages instead.

**Markup**, between the search form and the status line in the header:

```html
<div class="staged" id="staged" hidden>
  <img id="staged-img" alt="">
  <span class="staged-name" id="staged-name"></span>
  <button type="button" id="staged-clear" aria-label="Discard the staged card" title="discard">×</button>
</div>
```

**State.** A module-local `let staged = null` in `app.js` holding the parsed
card from `lookup()`. It is not game state: not saved, not undone. One card
at a time; staging another replaces it.

**Staging.** Replace `add(owner)` with:

- `stage()` — reads `q.value`, looks the name up exactly as `add` does now
  (same `pending` guard, same status messages and error handling), puts the
  result in `staged`, clears `q`, renders the slot, enables `#menu-card`,
  and sets the status to `` `${card.name} — choose from card ▾` ``.
- `place(dest)` where `dest` is one of `'me:hand'`, `'opp:play'`,
  `'me:command'`, `'opp:command'` — commits the matching call and clears
  the staging slot:
  - `me:hand` → `G.addCard(game, staged, 'me')`
  - `opp:play` → `G.addCard(game, staged, view.opp)`
  - `me:command` → `G.addCard(game, staged, 'me', 'command')`
  - `opp:command` → `G.addCard(game, staged, view.opp, 'command')`
  `addCard` already routes an opponent's play to the battlefield or the
  graveyard, and already marks a card put in the command zone as the
  commander. Do not duplicate that logic here.

**The Card menu.** Wire `#menu-card` with four items, disabled-with-title
when nothing is staged (the button itself is `disabled` then, so the items
only need to exist when it opens):
- `send to my hand` → `place('me:hand')`
- `<opponent label> plays` → `place('opp:play')`, label rebuilt on each open
  from `G.label(game, view.opp)` so it tracks the opponent in view
- `send to my command zone` → `place('me:command')`
- `send to <opponent label>'s command zone` → `place('opp:command')`

**Remove** the `to my hand` and `opponent plays` buttons from the search
form and their listeners. `renderOpponents` no longer sets `$('add-opp')`;
delete that line.

**Keys.** The search form's submit (Enter) now stages. With a card already
staged and the box empty, Enter is `place('me:hand')` and shift+Enter is
`place('opp:play')` — the fast path stays two keystrokes per card, as it is
today. With text in the box, Enter always stages, shift+Enter stages too
(the destination is chosen after). The suggestion list's own Enter handling
is unchanged: the first Enter takes the suggestion into the box.

`#staged-clear` and Escape (when the box is empty and a card is staged)
discard the staged card and disable `#menu-card` again.

**Style.** A compact row: the card image at about `2.6rem` wide with the
same radius as `.card img`, the name beside it, and the × at the end. The
whole slot uses `--surface` with a `--border` and the `--radius`, and is
outlined in `--accent` so it reads as selected.

**Tests.** The browser file types a name and presses Enter constantly.
Every one of those flows now needs the extra step. Update the existing
checks, and add:
- typing a name and pressing Enter stages it: the slot shows the name and
  the image, the table is untouched, `#menu-card` is enabled
- Enter again sends it to my hand and clears the slot
- shift+Enter on a staged card is the opponent playing it
- `card ▾` → `send to my command zone` puts it in my command zone wearing `cmd`
- `card ▾` → the opponent's command zone item names the opponent in view and
  puts it in their command zone
- the × discards without touching the table and disables `#menu-card`
- the opponent-plays item's label follows the opponent tab in view

## Task 6 — typed life

**Files:** `index.html`, `app.js`, `style.css`, `tests/browser.mjs`

**The new-game dialog.** Replace the 20/40 radio fieldset with a number
field and two presets:

```html
<fieldset>
  <legend>starting life</legend>
  <input type="number" id="new-life" name="life" value="20" min="1" max="999" step="1" inputmode="numeric" required>
  <button type="button" class="preset" data-life-preset="20">20</button>
  <button type="button" class="preset" data-life-preset="40">40</button>
</fieldset>
```

A preset button fills the field, it does not submit. The form's submit
already reads `f.get('life')` and passes it to `G.newGame`, whose
`clampLife` (Task 1) handles anything odd. The dialog reopens with the
current game's `startingLife` in the field, not always 20.

**The life totals on the table.** Each `<output id="life-me">` /
`#life-opp` becomes clickable: click it (or focus it and press Enter) and
it turns into a small number input holding the current value, selected.
Enter or blur commits through `commit(G.setLife(game, player, value))`;
Escape cancels. An empty or non-numeric value cancels. Keep the `-5 -1 +1 +5`
buttons exactly as they are.

Implement the swap without replacing the `<output>` element: put a
`<input type="number" class="life-edit" hidden>` inside each `.life` group
in the markup, and toggle which of the two is hidden. The element identity
matters — `render()` writes to `#life-me` and `#life-opp` by id every frame.
While an input is open, `render()` must not clobber what is being typed:
skip writing to a life output whose sibling input is open.

The player the input edits is `me` for the `me` group and `view.opp` for the
opponent group, matching how the `-5/+5` buttons already resolve their
target.

**Style.** The output gets a hover background and `cursor: text` so it
reads as editable; the input is the same size and font as the output so the
row does not jump.

**Tests.**
- the dialog's life field takes a typed number, and a new game with 34
  starts everyone at 34 and logs it
- the 20 and 40 presets fill the field without submitting
- the dialog reopens showing the current starting life
- clicking my life total opens an input; typing 31 and pressing Enter sets
  it and logs `my life is now 31`
- Escape cancels without changing the total
- the opponent's life total edits the opponent in view
- undo brings a typed life back

## Task 7 — zone-change animations: the tear and the warp

**Files:** `app.js`, `style.css`, `tests/browser.mjs`

A card that leaves for the graveyard is torn up; one that leaves for exile
is warped out of existence. Both are the same mechanism with two effects,
and both are pure decoration: no game state, no `commit`, nothing saved.

**The hook.** `cardEl` already knows when a card changes zone — it compares
`el.dataset.zone` with `c.zone`. Before updating that dataset, and only when
the element is already in the document with a non-zero box, capture
`el.getBoundingClientRect()` and call:

```js
function zoneEffect(el, rect, from, to)
```

- `to === 'graveyard'` → the tear. `to === 'exile'` → the warp. Any other
  destination → nothing.
- A card arriving on the table for the first time has no `from` and gets no
  effect: it was never anywhere to leave. This means an opponent's cast
  instant, which `addCard` puts straight into the graveyard, does not tear.
  A card played from hand that resolves to the graveyard does.
- `@media (prefers-reduced-motion: reduce)` skips the ghost entirely and
  leaves only the destination fade-in, which is a plain opacity transition.

**The ghost.** The effect never animates the card element itself — that
element is being moved into its new zone by `render()` in the same frame,
and animating it would fight the layout. Instead build a throwaway
`div.ghost` appended to `<body>`, `position: fixed` at the captured rect,
`pointer-events: none`, `z-index` above everything, holding a copy of the
card's `<img>` (same `src`, so it is already in the browser's cache and
paints immediately). Remove it on `animationend`, and also on a `setTimeout`
fallback of the animation's duration plus 200ms, so a ghost can never be
orphaned if the tab is backgrounded mid-animation. Give every ghost a
`data-effect` attribute (`tear` or `warp`) so the tests can see one.

**The tear** (about 620ms). The ghost holds two copies of the image, each
in a `.ghost-half`, clipped by a `clip-path: polygon(...)` describing a
ragged vertical edge down the middle — a handful of points zig-zagging a
few percent either side of 50%, the two halves using complementary
polygons so they fit together exactly at rest. The halves then fall apart:
the left one translates left and down and rotates a few degrees
anticlockwise, the right one right and down and clockwise, both fading to
zero and blurring slightly as they go, with an `ease-in` so they accelerate
away. Hold both halves still for the first ~12% of the animation so the
tear reads as a snap before the fall.

**The warp** (about 520ms). One copy of the image. It stretches
horizontally while collapsing vertically toward its centre line — a
`scaleX` well past 1 as `scaleY` goes to nearly 0 — with a growing blur, a
rising brightness, and a `--accent`-coloured glow, then fades out at a
width of nothing. The effect wanted is a thing being pulled out of the
plane, not a thing shrinking.

**The arrival.** In both cases the real card, now in its new zone, fades and
scales in from `0.92` over ~200ms. Do this with a class added in `render()`
and removed on `animationend`, not with a transition on `.card`, so it
cannot interfere with the hover scale from Task 4 or the tapped-card width
transition.

**Tests.** Animations are awkward to assert on; assert the mechanism, not
the pixels.
- sending a battlefield creature to the graveyard through the card menu
  creates a `.ghost[data-effect="tear"]` with two `.ghost-half` children
- sending a permanent to exile creates a `.ghost[data-effect="warp"]`
- both ghosts are gone from the DOM within a second
- the card itself is in its new zone immediately, not waiting on the
  animation, and the zone counts are right while the ghost is still on
  screen
- a card put straight into the graveyard by `addCard` (the opponent casting
  an instant) makes no ghost
- moving a card to the hand or the battlefield makes no ghost

## Task 8 — the README, and a full sweep

**Files:** `README.md`, plus any test or code fix the sweep turns up

Rewrite the parts of `README.md` that describe what changed:
- the "Using it" bullets: **new game** and **reset game** now live under
  `game ▾` in the navbar; a searched card lands in the staging slot and
  `card ▾` sends it to my hand, the opponent's board, or either command
  zone; Enter and shift+Enter still work as the fast path
- hovering a card now enlarges it and shows a panel of its cost, type, and
  text; **right-click a card for what can be done with it** — play, copy,
  a counter, any zone, or remove. The keyboard path: tab to a card, Enter
  for the menu, Space to tap a permanent
- starting life is typed, and a life total on the table can be clicked and
  typed over
- drop the sentence describing the hover action strip and the `ctr` button
  on it; `add counter…` is a menu item now
- the "Running the tests" section: note that `CHROME` may point at a
  `chrome-headless-shell` binary, since the default path is macOS-only

Then run both suites, read the whole diff of the branch against `main`, and
fix anything inconsistent: dead CSS for elements that no longer exist, dead
handlers, stale comments describing the old behaviour, and any `README`
claim that no longer matches the code.
