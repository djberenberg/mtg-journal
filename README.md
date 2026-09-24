# Game journal

A board for a game of Magic you are following but cannot see: a game on the
radio, a commentary stream, a friend's match over the phone. Type a card,
it comes up from Scryfall, and you say where on the table it went.

Static files: no build step, no dependencies, no server of its own. All it
needs is a browser and something to serve the directory.

## Install

```sh
git clone git@github.com:djberenberg/mtg-journal.git
cd mtg-journal
python3 -m http.server 8000        # then open http://localhost:8000/
```

Any static server will do; the page uses ES modules, so opening
`index.html` straight from the disk (`file://`) will not. Two others:

```sh
npx serve .                        # Node
caddy file-server --listen :8000   # Caddy
```

Card data and images come from [Scryfall](https://scryfall.com/docs/api)
at the moment you type a name, so it needs the internet while in use; the
game itself is kept in the browser's local storage, nothing leaves the
machine.

### Running the tests

The tests need Node 22 or later (for `node --test`, `fetch`, and
`WebSocket`); nothing to install.

```sh
node --test tests/*.test.mjs       # the rules and the Scryfall client
CHROME=/path/to/chrome node tests/browser.mjs
```

The browser run falls back to Google Chrome's usual macOS path, so anywhere
else `CHROME` has to say where it is. A `chrome-headless-shell` binary does
as well as the browser — the run is headless either way and never shows a
window. It stubs Scryfall from saved responses, so it runs offline;
screenshots land in `.scratch/`.

## Using it

- **game** in the navbar, above the search box, holds the two that start a
  game over. **new game** asks how many opponents (one to three, as in
  commander) and the starting life: type the number, or take 20 or 40 from
  the buttons beside the field. **reset game** clears the table and starts
  again with the same seats and the same life, in one click; undo brings the
  game back if either was a slip. With more than one opponent, tabs above
  the opponent's board switch between them, and each tab shows that
  opponent's life. Everything on the opponent's side of the table refers to
  the opponent in view.
- Type a card name. Suggestions come from Scryfall as you type; arrow keys
  and enter pick one. Enter, or **look up**, fetches the card and stands it
  in a slot under the box — found, but not yet anywhere. Which card it was
  and where it went are two questions, and the slot is the pause between
  them. With a card standing there and the box empty, enter sends it **to my
  hand** and shift+enter means **the opponent in view plays it**, straight
  onto their battlefield, or their graveyard if it is an instant or sorcery.
  So a card still costs two keystrokes. Right-click the slot for all four
  places it can go: either of those, or into my command zone or theirs.
  **×** throws it away again.
- Hover a card and it grows a little, with a panel beside it: what it costs,
  what it is, what it says, and its power and toughness or its loyalty. The
  browser's own tooltip said the same thing, a second late and in the
  system's font, and is gone.
- Right-click a card for everything that can be done with it: **play** it
  out of hand, **copy** it, **add counter…**, send it to any zone it is not
  already in, step it **left** or **right** along its row, or **remove** it.
  `copy` puts another of the same card beside it, for tokens, clones, and a
  second Forest; `remove` takes the card off outright, for a mistake. From
  the keyboard: tab to a card and press enter, or the context-menu key.
  Space taps a permanent on the battlefield and opens the menu everywhere
  else.
- **add counter…** takes `+1/+1` by default, any `+N/+M`, or a name such as
  `lore` or `time`. Each kind is a small square on the card showing how
  many; hover it for + and −, and drag it anywhere on the card. Counters
  come off when the card changes zone.
- Each player has a **command zone**. A card that has been there wears a
  `cmd` mark wherever it goes, so the commander can be told from the rest
  on the battlefield.
- Click a permanent on the battlefield to tap or untap it. It turns on its
  side. Lands have a row of their own on each battlefield, the row nearer
  their owner: above for the opponent, below for me. Cards can be dragged
  into a new order within their own row — lands among lands, the rest among
  the rest — with a mouse or a pen, since claiming a finger too would stop a
  phone scrolling the page. **move left** and **move right** in the card
  menu do the same thing, for the keyboard and for a touch.
- An Equipment on the battlefield lists the creatures its owner has out, one
  **equip** item each; choosing one tucks the Equipment in behind that
  creature, where it stays until **unequip** takes it off. The attachment
  ends on its own when either card leaves the battlefield, so nothing is
  ever left tucked in behind a card that has gone.
- Life totals have −5 / −1 / +1 / +5 beside them, and the number itself can
  be clicked and typed over, for a total that got away while you were not
  looking.
- **Commander damage** is counted under each life total: one ticker per
  commander that can hit that player, named, with + and − and the tally so
  far. A tick takes that much life with it, in the one action — that is what
  happens at the table, and a journal that made you enter the same hit twice
  would be worse than the paper it replaces. At 21 the ticker turns red and
  the log says the player is dead to it.
- A card sent to the graveyard is torn in two on the way; one sent to exile
  warps out of the plane. Decoration, and neither plays for anyone who has
  asked their system for less motion.
- **next turn** passes the turn round the table, me then each opponent in
  order, and untaps the new active player's permanents. An opponent's turn
  brings their board up.
- Everything is logged on the right, newest first, with its turn number.
  **log** in the header collapses the panel; the table takes the room.
  **undo** steps back (also ⌘Z / ctrl+Z outside the search box). The game
  is saved in the browser as you go, so a reload picks it up.
- `/` jumps to the search box.

## Layout

| file | what |
| --- | --- |
| `game.js` | the rules: zones, tapping, turns, life, commander damage, counters, equipment, the order of a row, the log. Pure functions over plain JSON, no DOM |
| `scryfall.js` | the Scryfall client: autocomplete, fuzzy lookup, and `parseCard`, which keeps only what the table needs |
| `app.js` | the page: drawing the table and turning clicks, keys, and drags into calls on `game.js` |
| `index.html`, `style.css` | the markup and the look: a dark theme |
| `tests/*.test.mjs` | `node --test tests/*.test.mjs`: the rules and the client, against saved Scryfall responses in `tests/fixtures/` |
| `tests/browser.mjs` | `CHROME=… node tests/browser.mjs`: drives the page in headless Chrome with Scryfall stubbed from the fixtures; screenshots land in `.scratch/` |

Card images are hotlinked from Scryfall's CDN, which allows it. The API
asks for an `Accept` header and no more than about ten requests a second;
autocomplete is debounced to 200ms for that reason.

## Not yet

Phases and the stack, attacking and blocking, naming the opponents,
flipping a double-faced card (the back image is already kept), and the
opponent's library and hand sizes. Tokens are half here: `copy` makes
another of a card already on the table, which covers most of them, but a
token that is a copy of nothing has no name to look up. The rules module is
where each of those would go.
