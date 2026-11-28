# Quiz

A television-style quiz for a living room at **https://randyliang.net/quiz/**:
one host, up to three contestants on their phones (configurable to six), the
board on a TV. It's an unofficial, independent fan project with its own name
and look. It has no affiliation with any television program and bundles no
broadcast logos, recordings or music. The built-in clues are original.

Code: `tools/serve/src/quiz/`. Data: `private/quiz/` (git-ignored). That
holds `quiz.db` (SQLite: the clue library, live rooms, results), plus
optional `media/` and `themes/`. The Astro build knows nothing of it, the
same as the chats.

## Running a game, start to finish

1. **Host:** open `/quiz/`, then **Host a game**. Pick a random board, a game
   from the library, or one of your own, and press **Create the game**. You
   land on the host console, `/quiz/host/<CODE>`. Keep that tab: its link
   carries your host credential.
2. **TV:** open `/quiz/display/<CODE>` on the television's browser (the host
   console links to it). Click once for full screen and sound.
3. **Contestants:** scan the QR code on the TV, or go to `/quiz/join` and
   type the code. They enter a name and get the buzzer. They don't need an
   account or an app.
4. **Buzzer test:** press `T` on the host console. Every press flashes the
   podium on the TV and shows on the console with each phone's round-trip
   time, jitter and lost pings. Press `T` again to end it.
5. **Start:** press `Space`. Each press introduces the next category on the
   TV, and a final `Space` opens the board.
6. **Each clue:** the player in control taps a value on their phone (or you
   choose it with the arrows and `Enter`). Read the clue aloud, then press
   `Space` to open the buzzers. The TV's side lights come on. The first
   press to reach the server wins. Rule with `Y` (correct) or `N`
   (incorrect). After an incorrect response, buzzing reopens for whoever
   hasn't answered. `R` shows the correct response and `Space` returns to
   the board.
7. **Wager clue:** the TV reveals it before anything about the clue. The
   player wagers on their phone (or you type it with `W`), then you read the
   clue and press `Space` to start their time.
8. **Final round:** positive scores only. The category comes first, then the
   wagers (private, on phones), then the clue. `Space` starts the thinking
   time and the phones take written responses. The reveal goes from the
   lowest score up, one contestant at a time: `Space` shows the response,
   `Y`/`N` rules on it, `Space` shows the wager and moves the score.
9. **Winner:** a tie for first goes to a sudden-death clue if the game has
   one. The console then shows the statistics, and `pnpm quiz results`
   keeps them.

## Host controls

| Key           | Does                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| Space / Enter | The next step: start, next category, open buzzers, show response, next…   |
| Arrows, Enter | Move on the board and choose a clue                                       |
| Y / N         | Correct / incorrect (also in the final reveal)                            |
| M             | Ask for more specific (their response time restarts)                      |
| Q             | Question-form reminder (lenient rounds only; strict rounds rule it wrong) |
| R             | Show the correct response                                                 |
| S             | Skip the clue (no penalty, nobody scores)                                 |
| W             | Type the wager for the player                                             |
| 1–6           | Give that podium the board                                                |
| U             | Reverse the latest ruling (corrects the score, not board control)         |
| P             | Pause / resume (stops every clock)                                        |
| T             | Buzzer test on / off                                                      |
| E             | End the round now (unplayed clues stay unplayed)                          |
| ?             | The list                                                                  |

The console also lets you set any score (click it), rename or remove a
player, issue a **rejoin link** (a new credential for a seat whose phone
lost its own; the old one stops working), a **co-host link**, a
**hardware buzzer token**, or **transfer** the host role (you become a
co-host).

Every command carries the state it was aimed at. If the game moved on in
between (a buzz arrived, the clock ran out), the server refuses the command
instead of applying it to the wrong moment, and the console says so.

## The rules as implemented

The engine follows the televised format's published rules (see
`docs/decisions.md`, 2026-11-28 "Quiz", for the sources and the judgement
calls):

- **Board rounds**: six categories, five values (configurable per round, so
  historical value sets work). The first round places one wager clue and
  the second places two, never two in one category, weighted toward lower
  rows. A historical board's flagged positions are kept.
- **Board control**: a correct response takes control. If nobody is right,
  the selector keeps it. Each player gets one attempt per clue. Round 2+
  starts with the lowest score, and a tie goes to the leftmost podium.
- **Signalling**: buzzers stay locked while the clue is read and the host
  opens them. A press before then locks that player out for 250 ms (the
  setting is in "Rules and timing"). They must press again after the
  lockout ends. A press made while the phone showed the buzzers locked
  counts as early even if it arrives after they open. Winning the buzz
  starts a 5-second response window. The host can still rule after it runs
  out.
- **Wager clues**: only the selector responds, with a minimum of $5 (or the
  round's lowest value, if smaller). The maximum is the greater of their
  score and the round's top value. They keep control whatever the result.
- **Final round**: only positive scores play. Wagers run from 0 to the
  player's score and stay private. The clue appears only after every wager
  is in (the host can enter one for a player whose phone died). Written
  responses stay private until revealed. The reveal goes lowest score
  first. A tie for first goes to sudden-death clues (first correct
  response wins; a miss reopens to the others). If none are left, the
  winners share it. If nobody finishes above zero, there's no winner.
- **Question form**: rounds are `lenient` (a reminder, no penalty, once per
  player per clue) or `strict` (the host rules it incorrect). The defaults
  are lenient for the first round and strict for later ones.
- **Optional round time limit** ("Rules and timing" → minutes). When time
  runs out, the clue in play finishes and the round ends with whatever is
  unplayed.
- **Corrections**: reversing a ruling corrects the score and the statistics.
  It doesn't change who had the board. Reversing a final ruling after the
  game can change the winner (and can start a tiebreaker).

## The buzzer, and what it can't promise

The server holds each game in memory and decides every buzz synchronously:
engine, broadcast to every device, then acknowledgement. Nothing waits on
the database, which is written on a later turn of the event loop. The
first eligible press to **arrive** wins. Client timestamps are never
trusted.

That means a phone with a slower connection arrives later for the same
press. The game does not compensate for that, and it can't know which
finger moved first. The buzzer test shows each phone's round trip and
jitter so you can see whether it matters. For close games, use the LAN
listener (below): everyone on the same Wi-Fi, no Cloudflare in the path.

Measured with `pnpm quiz bench` (loopback, 2026-11-28, 300 contested
buzzes): arbitration takes ~14 µs median, and every device hears the result
~5 ms (p99 ~10 ms) after the presses. The host console shows the live
server-side figures for each game.

Phones send the press on `pointerdown` (not `click`). The buzzer disables
touch gestures and double-tap zoom, ignores key repeat (so a held key
counts once), flashes the moment the press is sent (before the result
returns), and keeps the screen awake where the browser allows. Space,
Enter or B on a keyboard, or a Bluetooth/USB button that types one of
those, also press it.

## Playing on the LAN

Set `QUIZ_LAN_LISTEN=<this machine's LAN address>:<port>` in `.env` (for
example `192.168.1.20:4330`) and restart the server. That starts a second
listener which serves **only** `/quiz` (everything else returns 404), so
turning it on exposes nothing else of the site. The host console then shows
a second QR code for phones on the same Wi-Fi.

Limits: it's plain HTTP, so the Screen Wake Lock API isn't available on
those phones (it needs HTTPS). Expect the screen to dim on long clues. Open
the port in the firewall for the LAN zone only.

## Writing your own games

`/quiz/edit/` → **New game**. A game you write belongs to its **edit link**
(`/quiz/edit/<id>#<key>`). There are no accounts. Anyone with the link can
edit or host the game, and without it nobody can. The browser remembers the
games it made. **Copy edit link** to keep yours somewhere safe.

- Rounds are tabs. **+ round** adds a board round. The values, the number
  of wager clues to place, and the question-form rule are per round.
- Click a cell to write its clue, correct response, alternatives (one per
  line), host notes (pronunciation, sources) and optional media: an image,
  audio or video at an `https://` address or `/quiz/media/<file>`.
  Ctrl/⌘ + arrows move between cells.
- **Always a wager clue here** pins a wager clue to that cell. Otherwise the
  game places them at random each time it's hosted.
- Every edit saves itself. The bar says **Ready to host**, or names the
  first thing missing.
- **Export** downloads the game file. **Import** replaces the game with one.

Games written in the editor never appear in the public library, random
boards or practice. To list one: `pnpm quiz list-on <id>`.

## The game file (`quiz-game/1`)

What the editor exports and `pnpm quiz import` reads:

```json
{
  "format": "quiz-game/1",
  "title": "Kitchen Table",
  "credit": "Written by Randy",
  "episode": { "id": "kt-1", "showNumber": null, "season": null, "airDate": null },
  "rounds": [
    {
      "kind": "board",
      "values": [200, 400, 600, 800, 1000],
      "wagers": 1,
      "questionForm": "lenient",
      "categories": [
        {
          "title": "CHEESES",
          "note": "",
          "clues": [
            {
              "text": "Holes are its trademark",
              "response": "Swiss",
              "accept": ["Emmental"],
              "notes": "",
              "media": null,
              "wager": false,
              "order": null
            },
            null
          ]
        }
      ]
    },
    {
      "kind": "final",
      "category": "ISLANDS",
      "note": "",
      "clue": { "text": "…", "response": "…" }
    }
  ],
  "tiebreakers": [{ "category": "OCEANS", "clue": { "text": "…", "response": "…" } }]
}
```

`clues` has one entry per value. `null` is an empty cell. `order` is the
original selection order, when known. Limits (validate.ts): 8 categories,
10 rows, 6 rounds, 1,000 characters per clue, 300 per response. Several
games can share one file as `{ "format": "quiz-games/1", "source": {…},
"games": [ … ] }`.

## Importing a dataset

```sh
pnpm quiz import games.json --source="My trivia nights" --license="Mine"
pnpm quiz import archive.csv --source="…" --license="…" --url="…" [--list]
pnpm quiz episodes --all        # what's there, listed or not
pnpm quiz list-on 12            # offer episode 12 in the library
pnpm quiz export 12 out.json
```

The command requires `--source` and `--license`. Every imported episode
records where it came from and on what terms, and the host's library shows
it. Imports start **unlisted**.

CSV/TSV uses the flat layout historical archives are usually published in,
one clue per line, columns matched by header: show number, air date, round,
category, value, clue/question, response/answer. It also reads optional row,
order, daily double/wager, accept (`|`-separated), notes, category note,
media url and media kind. Rounds can be `1`/`2`/`3` or names ("Jeopardy!",
"Double…", "Final…", "Tiebreaker"). Values infer the round's configuration
(100–500, 200–1,000, 400–2,000…). A value that fits no row is taken as a
wager amount, and that clue becomes a wager clue in the category's empty
row. Light HTML is stripped. Re-importing the same source and show updates
the episode instead of duplicating it.

**Licensing.** Nothing here fetches clues from anywhere. Historical
broadcast clues are someone else's copyrighted writing. Archives such as
J! Archive are fan-maintained references that grant no redistribution
rights, so don't import them to a public library without permission. Your
own games, your friends' and openly licensed sets are fine. A private,
unlisted import is between you and your conscience. Random boards and
practice draw only on **listed** episodes.

Random boards keep categories whole: six complete categories per round,
from different episodes where the library allows, in their original order
(only the dollar figures are normalised). The **query** field on the host
page prefers categories whose title contains it.

## Single player and practice

**Single player** (`/quiz/solo/`): the server hosts. The page reads each
clue aloud (browser speech synthesis, toggleable), opens the buzzer when
it's done, and judges what you type. It normalises case, accents, question
form and articles, and allows small misspellings (engine/answer.ts). It
never guesses synonyms. **I was right** overrules it. No language model is
involved.

**Practice** (`/quiz/practice/`): one clue at a time from listed episodes,
optionally filtered by category.

## Themes, words and sound

A theme is a directory with `theme.css` (CSS variables only: colours, fonts,
borders) and `theme.json` (the words: what a wager clue, the final round
and the currency are called; optional audio files). Two ship with the
code: `classic` (deep blue, gold values, condensed headings, serif clues) and
`studio` (to show that a theme is only variables). The host chooses one in
"Rules and timing".

Your own themes go in `private/quiz/themes/<name>/`. Use that for fonts,
sounds or anything else you may use but not redistribute. They're served
at `/quiz/themes/<name>/…`:

```json
{
  "terms": { "wagerClue": "Daily Gamble", "final": "Last Stand", "currency": "$" },
  "audio": {
    "final_think": "/quiz/themes/mine/think.mp3",
    "wager_reveal": "/quiz/themes/mine/stinger.mp3"
  }
}
```

Audio cues: `board_fill`, `category`, `wager_reveal`, `time_up`,
`round_end`, `buzz`, `final_think`, `game_over`. Each defaults to an
original sound synthesised in the browser, so nothing is downloaded or
licensed. Sound plays on the TV and in single player only. The display's
start click is what unlocks audio in the browser. The thinking music is one
channel that stops when the time ends.

Fonts: Newsreader (clues) and Oswald (headings, values), both under the
SIL Open Font License, served from `static/fonts/` with their licences.

## Hardware buzzers

A device is a role like any other. The host console issues a **hardware
buzzer token**. A device connects to `/quiz/ws`, sends `{ "type": "hello",
"code", "token" }`, answers pings, and sends `{ "type": "press", "seat": n }`
per press, where seat 0 is the leftmost podium. The server treats it as that
player's buzz. Hardware sees no game state, so arrival alone decides: a
press while the buzzers are locked locks that podium out like any early
press. An ESP32 with a WebSocket client, or a small USB-to-WebSocket bridge,
needs nothing else.

`pnpm quiz bridge wss://randyliang.net/quiz/ws <CODE> <token> --keys=123`
is the reference: a terminal keyboard as three podium buttons.

## Rooms, credentials, limits

- A room code (four consonants) only lets someone **join as a new player**
  or **watch**. Every role is a separate random credential: host, co-host,
  player, spectator, device. It's sent as the first WebSocket message, never
  in a URL the server sees (links carry it after `#`), never logged, and
  stored only as a hash.
- What each role is sent is built field by field for that role
  (engine/project.ts). Responses, alternatives, host notes, wager-clue
  positions, other players' final wagers and responses all stay on the
  server until revealed.
- Rooms last while in use. A room nobody is connected to leaves memory
  after 30 minutes and is deleted after 24 hours idle. The results stay.
  At most 100 rooms are held in memory and 24 connections per room.
- Per address, per hour: 30 new games, 60 joins/watches, 60 new boards. Per
  connection: 20 messages a second, and a connection that keeps sending
  junk is closed. Bodies are size-capped and every message is validated.

## Restarts and deploys

The server writes each room's event log and a snapshot after every action
(after the action is broadcast). One process is a room's only authority: it
holds the room's lease (`rooms.owner`, renewed every 20 s, 60 s long). A
deploy's candidate server sharing the database finds a live game's lease
held and refuses it. On SIGTERM the server writes final snapshots, releases
the leases and tells every device to reconnect. The new process picks each
game up when its first device reconnects. The game comes back **paused**
with its clocks where they stopped (a new process can't trust the old
one's clock), and the host presses `P`.

`Room.replay` rebuilds any game from its first state and its log. The tests
check that it reproduces the live state exactly.

## Statistics

Each finished game records final scores, Coryat scores (no wagers), right
and wrong counts, buzz presses, wins and early presses, wager-clue and
final-round results, and every ruling by category (`pnpm quiz results`
shows accuracy by category). "Median buzz" is measured **on the server**:
from the buzzers opening to the winning press arriving. That includes the
network and is not a human reaction time.

## Operations

`pnpm quiz rooms` lists live and recent rooms and who holds them.
`/quiz/api/health` returns room and connection counts. Log lines are JSON
(`quiz_room_created`, `quiz_game_over`, `quiz_flush_failed`, …) and never
include a credential. To back up, copy `private/quiz/quiz.db` (with
`sqlite3 .backup` while running).
