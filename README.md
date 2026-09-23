# Game journal

A board for a game of Magic you are following but cannot see: a game on the
radio, a commentary stream, a friend's match over the phone. Type a card,
it comes up from Scryfall, and it sits on the table in front of you.

Static files, no build, no server of its own. Open `index.html` over any
static server (it uses ES modules, so `file://` will not do):

```sh
python3 -m http.server -d . 8000    # http://localhost:8000/
```

## Using it

- Type a card name. Suggestions come from Scryfall as you type; arrow keys
  and enter pick one. Enter adds the card **to my hand**; shift+enter, or
  the button, means **the opponent plays it**, straight onto their
  battlefield, or their graveyard if it is an instant or sorcery.
- Hover a card for its cost, type, and text. Hover also shows what can be
  done with it: play (from hand), or send it to the graveyard, exile, hand,
  or battlefield. `×` removes it outright, for a mistake.
- Click a permanent on the battlefield to tap or untap it. It turns on its
  side.
- **next turn** passes the turn and untaps the new active player's
  permanents. Life totals have −5 / −1 / +1 / +5 beside them.
- Everything is logged on the right, newest first, with its turn number.
  **undo** steps back (also ⌘Z / ctrl+Z outside the search box). The game
  is saved in the browser as you go, so a reload picks it up; **new game**
  clears it.
- `/` jumps to the search box.

## Layout

| file | what |
| --- | --- |
| `game.js` | the rules: zones, tapping, turns, life, the log. Pure functions over plain JSON, no DOM |
| `scryfall.js` | the Scryfall client: autocomplete, fuzzy lookup, and `parseCard`, which keeps only what the table needs |
| `app.js` | the page: drawing the table and turning clicks into calls on `game.js` |
| `index.html`, `style.css` | the markup and the look, on the same palette as dabkiel.com |
| `tests/*.test.mjs` | `node --test tests/*.test.mjs`: the rules and the client, against saved Scryfall responses in `tests/fixtures/` |
| `tests/browser.mjs` | `node tests/browser.mjs`: drives the page in headless Chrome with Scryfall stubbed from the fixtures; screenshots land in `.scratch/` |

Card images are hotlinked from Scryfall's CDN, which allows it. The API
asks for an `Accept` header and no more than about ten requests a second;
autocomplete is debounced to 200ms for that reason.

## Not yet

Phases and the stack, counters, tokens, attacking and blocking, flipping a
double-faced card (the back image is already kept), and the opponent's
library and hand sizes. The rules module is where each of those would go.
