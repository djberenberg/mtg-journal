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

- **new game** asks how many opponents (one to three, as in commander) and
  the starting life (20 or 40). **reset game** clears the table and starts
  over with the same seats and life, in one click; undo brings the game
  back if it was a slip. With more than one opponent, tabs above the
  opponent's board switch between them; each tab shows that opponent's
  life. Everything on the opponent's side of the table, and the
  **opponent plays** button, refers to the opponent in view.
- Type a card name. Suggestions come from Scryfall as you type; arrow keys
  and enter pick one. Enter adds the card **to my hand**; shift+enter, or
  the button, means **the opponent in view plays it**, straight onto their
  battlefield, or their graveyard if it is an instant or sorcery.
- Hover a card for its cost, type, and text. Hover also shows what can be
  done with it: play (from hand), or send it to the graveyard, exile, hand,
  battlefield, or command zone. `×` removes it outright, for a mistake.
- **ctr** on a card's hover strip adds a counter: `+1/+1` by default, any
  `+N/+M`, or a name such as `lore` or `time`. Each kind is a small square
  on the card showing how many; hover it for + and −, and drag it anywhere
  on the card. Counters come off when the card changes zone.
- Each player has a **command zone**. A card that has been there wears a
  `cmd` mark wherever it goes, so the commander can be told from the rest
  on the battlefield.
- Click a permanent on the battlefield to tap or untap it. It turns on its
  side.
- **next turn** passes the turn round the table, me then each opponent in
  order, and untaps the new active player's permanents. An opponent's turn
  brings their board up. Life totals have −5 / −1 / +1 / +5 beside them.
- Everything is logged on the right, newest first, with its turn number.
  **log** in the header collapses the panel; the table takes the room.
  **undo** steps back (also ⌘Z / ctrl+Z outside the search box). The game
  is saved in the browser as you go, so a reload picks it up.
- `/` jumps to the search box.

## Layout

| file | what |
| --- | --- |
| `game.js` | the rules: zones, tapping, turns, life, the log. Pure functions over plain JSON, no DOM |
| `scryfall.js` | the Scryfall client: autocomplete, fuzzy lookup, and `parseCard`, which keeps only what the table needs |
| `app.js` | the page: drawing the table and turning clicks into calls on `game.js` |
| `index.html`, `style.css` | the markup and the look: a dark theme |
| `tests/*.test.mjs` | `node --test tests/*.test.mjs`: the rules and the client, against saved Scryfall responses in `tests/fixtures/` |
| `tests/browser.mjs` | `node tests/browser.mjs`: drives the page in headless Chrome with Scryfall stubbed from the fixtures; screenshots land in `.scratch/` |

Card images are hotlinked from Scryfall's CDN, which allows it. The API
asks for an `Accept` header and no more than about ten requests a second;
autocomplete is debounced to 200ms for that reason.

## Not yet

Phases and the stack, tokens, attacking and blocking, commander
damage, naming the opponents, flipping a double-faced card (the back image
is already kept), and the opponent's library and hand sizes. The rules
module is where each of those would go.
