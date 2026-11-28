// The host's console: the clue and its response, every ruling, the
// players' connections — utilitarian on purpose, and the whole game can be
// run from the keyboard (press ? for the keys). Every command carries the
// state seq it was aimed at; if the game moved on in between (a buzz, the
// clock), the server refuses it rather than apply it to the wrong moment.

import {
  connect,
  el,
  loadTheme,
  money,
  nameOf,
  page,
  put,
  remaining,
  roundName,
  statusText,
  takeToken,
  terms,
} from './lib.js';

const code = page().code;
const app = document.getElementById('app');
const token = takeToken(code, 'host');

if (!token) {
  put(
    app,
    el(
      'div',
      { class: 'doc' },
      el('h1', {}, 'No host credential here'),
      el('p', {}, 'Open the host link you were given (it ends in #…), or start a new game.'),
      el('a', { href: '/trivia/host/', class: 'button' }, 'Host a game'),
    ),
  );
} else {
  run();
}

function run() {
  let view = null;
  let welcome = null;
  let status = 'connecting';
  let diag = null;
  let presence = {};
  const cursor = { col: 0, row: 0 };
  let notice = '';
  let noticeTimer;

  const header = el('header', { class: 'host-head' });
  const lobby = el('section', { class: 'host-lobby' });
  const board = el('section', { class: 'host-board' });
  const clue = el('section', { class: 'host-clue' });
  const actions = el('div', { class: 'host-actions' });
  const players = el('section', { class: 'host-players' });
  const log = el('section', { class: 'host-log' });
  const help = el('dialog', { class: 'host-help' });
  const linkDialog = el('dialog', { class: 'host-link' });
  const main = el(
    'div',
    { class: 'host-grid' },
    board,
    el('div', { class: 'host-center' }, clue, actions),
    players,
  );
  app.append(header, lobby, main, log, help, linkDialog);

  function say(text) {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice = '';
      renderHeader();
    }, 4000);
    renderHeader();
  }

  async function act(action) {
    if (!view) return;
    const ack = await socket.act(action, view.seq);
    if (!ack.ok)
      say(
        ack.error === 'stale'
          ? 'The game moved on — check and try again.'
          : `Not now: ${ack.error}`,
      );
    return ack;
  }

  async function manage(op, playerId = null) {
    const reply = await socket.send({ type: 'manage', op, playerId });
    if (reply.type === 'link') showLink(reply);
    else if (!reply.ok) say(reply.error);
  }

  function showLink(reply) {
    const titles = {
      cohost: 'Co-host link',
      rejoin: `Rejoin link for ${nameOf(view, reply.playerId)}`,
      device: 'Hardware buzzer token',
      host: 'New host link (you are now a co-host)',
    };
    const value = reply.url ?? reply.token;
    put(
      linkDialog,
      el('h2', {}, titles[reply.kind] ?? 'Link'),
      el(
        'p',
        {},
        reply.kind === 'device'
          ? 'Give this token to the buzzer bridge (docs/quiz.md, “Hardware buzzers”).'
          : 'Anyone with this link has this role. Send it privately.',
      ),
      el('input', {
        class: 'link-value',
        value,
        readonly: true,
        onclick: (event) => event.target.select(),
      }),
      el(
        'div',
        { class: 'row' },
        el(
          'button',
          {
            type: 'button',
            onclick: () => navigator.clipboard?.writeText(value).then(() => say('Copied.')),
          },
          'Copy',
        ),
        el('button', { type: 'button', onclick: () => linkDialog.close() }, 'Close'),
      ),
    );
    linkDialog.showModal();
  }

  // ---- Header and lobby --------------------------------------------------------

  function renderHeader() {
    if (!view) return;
    const roundLeft = remaining(view, 'roundRemainingMs');
    // The state the console shows, for anyone (a test) waiting on the next one.
    document.body.dataset.seq = String(view.seq);
    put(
      header,
      el('span', { class: 'host-code' }, code),
      el('span', { class: 'host-title' }, view.title),
      el(
        'span',
        { class: 'host-phase' },
        `${roundName(view.round, view.rounds)} · ${view.phase.replace(/_/g, ' ')}`,
      ),
      roundLeft !== null
        ? el('span', { class: 'host-clock' }, `Round clock ${formatClock(roundLeft)}`)
        : null,
      view.paused
        ? el(
            'span',
            { class: 'host-paused' },
            view.paused === 'restart'
              ? 'PAUSED (server restarted) — P to resume'
              : 'PAUSED — P to resume',
          )
        : null,
      el('span', { class: `host-status ${status}` }, statusText(status)),
      notice ? el('span', { class: 'host-notice' }, notice) : null,
      el(
        'button',
        { type: 'button', class: 'linkish', onclick: () => help.showModal() },
        'Keys (?)',
      ),
    );
  }

  function renderLobby() {
    const inLobby = view.phase === 'lobby' || view.phase === 'buzzer_test';
    lobby.hidden = !inLobby && !lobby.dataset.pinned;
    if (lobby.hidden) return;
    const join = welcome?.joinUrl ?? '';
    const lan = welcome?.lanJoinUrl;
    put(
      lobby,
      el(
        'div',
        { class: 'lobby-steps' },
        el(
          'div',
          { class: 'lobby-qr-box' },
          el('img', {
            src: `/trivia/api/rooms/${code}/qr.svg`,
            alt: `QR code for ${join}`,
            class: 'host-qr',
          }),
          el('div', {}, join),
        ),
        lan
          ? el(
              'div',
              { class: 'lobby-qr-box' },
              el('img', {
                src: `/trivia/api/rooms/${code}/qr.svg?via=lan`,
                alt: `QR code for ${lan}`,
                class: 'host-qr',
              }),
              el('div', {}, `Same Wi-Fi, lower latency: ${lan}`),
            )
          : null,
        el(
          'ol',
          { class: 'lobby-list' },
          el('li', {}, 'Contestants scan the code and enter their names.'),
          el(
            'li',
            {},
            'Open the audience display on the TV: ',
            el(
              'a',
              { href: `/trivia/display/${code}`, target: '_blank', rel: 'noopener' },
              `/trivia/display/${code}`,
            ),
            ' — click it once there for full screen and sound.',
          ),
          el('li', {}, 'Test the buzzers (T), then start (Space).'),
        ),
      ),
      el(
        'div',
        { class: 'row' },
        view.phase === 'buzzer_test'
          ? el(
              'button',
              { type: 'button', onclick: () => act({ type: 'end_test' }) },
              'End buzzer test (T)',
            )
          : el(
              'button',
              { type: 'button', onclick: () => act({ type: 'start_test' }) },
              'Buzzer test (T)',
            ),
        el(
          'button',
          { type: 'button', class: 'primary', onclick: () => act({ type: 'start_game' }) },
          'Start the game (Space)',
        ),
        el('button', { type: 'button', onclick: () => manage('cohost_link') }, 'Co-host link'),
        el(
          'button',
          { type: 'button', onclick: () => manage('device_link') },
          'Hardware buzzer token',
        ),
        el(
          'button',
          {
            type: 'button',
            onclick: () =>
              confirm('Hand the game to someone else? You will become a co-host.') &&
              manage('transfer'),
          },
          'Transfer host',
        ),
      ),
      view.phase === 'buzzer_test' ? buzzerTestTable() : null,
    );
  }

  function buzzerTestTable() {
    const rows = view.players.map((player) => {
      const connection = diag?.connections.find((entry) => entry.playerId === player.id);
      return el(
        'tr',
        {},
        el('td', {}, player.name),
        el('td', {}, String(view.test?.[player.id] ?? 0)),
        el('td', {}, connection?.rtt != null ? `${connection.rtt.toFixed(0)} ms` : '—'),
        el('td', {}, connection?.jitter != null ? `${connection.jitter.toFixed(0)} ms` : '—'),
        el('td', {}, connection ? `${Math.round(connection.loss * 100)}%` : 'offline'),
      );
    });
    return el(
      'div',
      { class: 'diag' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Contestant'),
            el('th', {}, 'Presses'),
            el('th', {}, 'Round trip'),
            el('th', {}, 'Jitter'),
            el('th', {}, 'Lost pings'),
          ),
        ),
        el('tbody', {}, rows),
      ),
      el(
        'p',
        { class: 'fine' },
        'The server takes the first press to arrive. A phone with a longer round trip arrives later for the same press — that difference is not compensated. For a close game, have everyone on the same Wi-Fi (the LAN link, if set up) and watch for jitter above ~30 ms.',
      ),
    );
  }

  // ---- The board -------------------------------------------------------------------

  function renderBoard() {
    const b = view.board;
    const hostBoard = view.host.board;
    if (!b || !hostBoard) {
      put(board, el('div', { class: 'host-board-empty' }, roundName(view.round, view.rounds)));
      return;
    }
    cursor.col = Math.min(cursor.col, b.categories.length - 1);
    cursor.row = Math.min(cursor.row, b.values.length - 1);
    const grid = el('div', { class: 'mini-board' });
    grid.style.gridTemplateColumns = `repeat(${b.categories.length}, 1fr)`;
    hostBoard.categories.forEach((category, col) =>
      grid.append(
        el(
          'div',
          {
            class: `mini-head${b.categories[col].title ? '' : ' hidden-title'}`,
            title: category.title,
          },
          category.title,
        ),
      ),
    );
    b.values.forEach((value, row) =>
      hostBoard.categories.forEach((category, col) => {
        const left = b.remaining[col][row];
        const info = category.clues[row];
        const current = view.clue && view.clue.col === col && view.clue.row === row;
        grid.append(
          el(
            'button',
            {
              type: 'button',
              class: [
                'mini-cell',
                left ? '' : 'played',
                info?.wager ? 'wager' : '',
                cursor.col === col && cursor.row === row ? 'cursor' : '',
                current ? 'current' : '',
              ].join(' '),
              title: info ? `${info.text}\n— ${info.response}` : '',
              disabled: !left || view.phase !== 'board',
              onclick: () => {
                cursor.col = col;
                cursor.row = row;
                act({ type: 'select', col, row });
              },
            },
            left ? money(value) : '',
            info?.wager && left
              ? el('span', { class: 'wager-mark', title: terms.wagerClue }, '◆')
              : null,
          ),
        );
      }),
    );
    put(
      board,
      grid,
      el(
        'div',
        { class: 'fine' },
        `◆ = ${terms.wagerClue} (hidden from everyone else). Arrows + Enter to choose.`,
      ),
    );
  }

  // ---- The clue --------------------------------------------------------------------

  function renderClue() {
    const p = view.phase;
    const c = view.clue;
    const h = view.host;
    const parts = [];
    if (c) {
      parts.push(
        el(
          'div',
          { class: 'host-clue-top' },
          el('strong', {}, c.category),
          ' · ',
          c.tiebreak
            ? terms.tiebreak
            : c.wager
              ? `${terms.wagerClue} — ${nameOf(view, c.wagerer)}${c.wagerAmount !== null ? `, wagering ${money(c.wagerAmount)}` : ''}`
              : money(c.value),
        ),
        c.categoryNote ? el('div', { class: 'host-note' }, `Category: ${c.categoryNote}`) : null,
        el(
          'div',
          { class: 'host-clue-text' },
          c.text ?? view.host.board?.categories[c.col]?.clues[c.row]?.text ?? '',
        ),
        el(
          'div',
          { class: 'host-response' },
          el('span', { class: 'label' }, 'Response '),
          h.response ?? h.tiebreakResponse ?? '',
        ),
        h.accept.length
          ? el(
              'div',
              { class: 'host-accept' },
              el('span', { class: 'label' }, 'Also accept '),
              h.accept.join(' · '),
            )
          : null,
        h.notes
          ? el('div', { class: 'host-notes' }, el('span', { class: 'label' }, 'Notes '), h.notes)
          : null,
        c.media
          ? el('div', { class: 'host-notes' }, `Media: ${c.media.kind} ${c.media.url}`)
          : null,
      );
    }
    if (
      p === 'final_category' ||
      p === 'final_wager' ||
      p === 'final_clue' ||
      p === 'final_response' ||
      p === 'final_reveal'
    ) {
      parts.push(finalPanel());
    }
    if (p === 'tiebreak')
      parts.push(
        el(
          'div',
          { class: 'host-clue-text' },
          `${terms.tiebreak}: ${view.tiebreakCategory}. Tied: ${view.winners.map((id) => nameOf(view, id)).join(', ')}`,
        ),
      );
    if (p === 'game_over') parts.push(gameOverPanel());
    if (p === 'round_end')
      parts.push(
        el(
          'div',
          { class: 'host-clue-text' },
          `${terms.roundEnd}${view.roundExpired ? ' (time)' : ''}. Space to continue.`,
        ),
      );
    if (p === 'round_intro') {
      const shown = view.board?.categories.filter((category) => category.title).length ?? 0;
      const next = view.host.board?.categories[shown];
      parts.push(
        el(
          'div',
          { class: 'host-clue-text' },
          next
            ? `Introduce category ${shown + 1}: ${next.title}`
            : 'All categories shown. Space to start the round.',
        ),
      );
    }
    if (p === 'board')
      parts.push(
        el(
          'div',
          { class: 'host-clue-text' },
          `${nameOf(view, view.control) || 'Nobody'} has the board.`,
        ),
      );
    put(clue, ...parts, el('div', { class: 'host-line', id: 'host-line' }));
    updateLine();
  }

  function updateLine() {
    const line = document.getElementById('host-line');
    if (!line || !view) return;
    const p = view.phase;
    const left = remaining(view);
    const secs = left === null ? '' : ` (${(left / 1000).toFixed(1)} s)`;
    let text = '';
    if (p === 'reading')
      text = view.clue?.wager
        ? 'Read the clue, then Space to start their response time.'
        : 'Read the clue. Space opens the buzzers.';
    if (p === 'open') text = `BUZZERS OPEN${secs}`;
    if (p === 'responding')
      text = `${nameOf(view, view.clue?.responder)} is responding${secs} — Y correct, N incorrect, M more specific${view.host.questionForm === 'lenient' && !view.clue?.wager ? ', Q question-form reminder' : ''}`;
    if (p === 'adjudicating') text = `Time — ${nameOf(view, view.clue?.responder)}: Y or N`;
    if (p === 'clue_end')
      text = view.clue?.response
        ? 'Response shown. Space to return to the board.'
        : 'Space (or R) shows the response; Space again to continue.';
    if (p === 'final_response') text = `Thinking time${secs}`;
    line.textContent = text;
  }

  function finalPanel() {
    const f = view.final;
    const h = view.host;
    const rows = view.players
      .filter((player) => f.eligible.includes(player.id))
      .map((player) => {
        const revealed = f.revealed.find((entry) => entry.playerId === player.id);
        return el(
          'tr',
          { class: f.current === player.id ? 'current' : '' },
          el('td', {}, player.name),
          el('td', {}, money(player.score)),
          el(
            'td',
            {},
            h.finalWagers[player.id] !== undefined
              ? money(h.finalWagers[player.id])
              : el('button', { type: 'button', onclick: () => enterFinalWager(player) }, 'enter'),
          ),
          el(
            'td',
            {},
            h.finalResponses[player.id] ?? '—',
            view.phase === 'final_reveal' && !(h.finalResponses[player.id] ?? '')
              ? el('button', { type: 'button', onclick: () => enterFinalResponse(player) }, 'enter')
              : null,
          ),
          el('td', {}, revealed?.verdict ?? ''),
        );
      });
    return el(
      'div',
      { class: 'host-final' },
      el('div', { class: 'host-clue-top' }, el('strong', {}, terms.final), ' · ', f.category),
      f.note ? el('div', { class: 'host-note' }, f.note) : null,
      el(
        'div',
        { class: 'host-clue-text' },
        view.final.text ?? '(clue hidden until wagers are in)',
      ),
      el(
        'div',
        { class: 'host-response' },
        el('span', { class: 'label' }, 'Response '),
        h.finalResponse ?? '',
      ),
      h.finalAccept.length
        ? el(
            'div',
            { class: 'host-accept' },
            el('span', { class: 'label' }, 'Also accept '),
            h.finalAccept.join(' · '),
          )
        : null,
      el(
        'table',
        { class: 'final-table' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Contestant'),
            el('th', {}, 'Score'),
            el('th', {}, 'Wager'),
            el('th', {}, 'Response'),
            el('th', {}, 'Ruling'),
          ),
        ),
        el('tbody', {}, rows),
      ),
      view.phase === 'final_reveal'
        ? el(
            'p',
            { class: 'fine' },
            f.current
              ? `Revealing ${nameOf(view, f.current)}: ${f.step === 'response' ? 'Y / N to rule' : f.step === 'ruled' ? 'Space shows the wager' : 'Space for the next'}`
              : 'Space to reveal the first response (lowest score first).',
          )
        : null,
    );
  }

  function enterFinalWager(player) {
    const value = prompt(`${player.name}'s wager (0 to ${player.score})`);
    if (value !== null) act({ type: 'final_wager', amount: Number(value), playerId: player.id });
  }
  function enterFinalResponse(player) {
    const value = prompt(`${player.name}'s written response`);
    if (value !== null) act({ type: 'final_response', text: value, playerId: player.id });
  }

  function gameOverPanel() {
    const stats = view.host.stats;
    return el(
      'div',
      {},
      el(
        'div',
        { class: 'host-clue-text' },
        view.winners.length
          ? `Winner: ${view.winners.map((id) => nameOf(view, id)).join(' & ')}`
          : 'No winner.',
      ),
      el(
        'table',
        { class: 'stats-table' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            [
              'Contestant',
              'Score',
              'Coryat',
              'Right',
              'Wrong',
              'Buzz wins / presses',
              'Early presses',
              `${terms.wagerClue}s`,
              'Median buzz (server)',
            ].map((label) => el('th', {}, label)),
          ),
        ),
        el(
          'tbody',
          {},
          view.players.map((player) => {
            const s = stats[player.id] ?? {};
            const sorted = [...(s.buzzMs ?? [])].sort((a, b) => a - b);
            const median = sorted.length ? `${sorted[Math.floor(sorted.length / 2)]} ms` : '—';
            return el(
              'tr',
              {},
              el('td', {}, player.name),
              el('td', {}, money(player.score)),
              el('td', {}, money(s.coryat ?? 0)),
              el('td', {}, String(s.correct ?? 0)),
              el('td', {}, String(s.incorrect ?? 0)),
              el('td', {}, `${s.wins ?? 0} / ${s.buzzes ?? 0}`),
              el('td', {}, String(s.premature ?? 0)),
              el(
                'td',
                {},
                `${s.wagerCorrect ?? 0}/${s.wagerClues ?? 0} (${money(s.wagerNet ?? 0)})`,
              ),
              el('td', {}, median),
            );
          }),
        ),
      ),
      el(
        'p',
        { class: 'fine' },
        'Median buzz is measured on the server: buzzers open → the winning press arrives, network included. It is not a reaction time.',
      ),
    );
  }

  // ---- The action bar --------------------------------------------------------------

  function renderActions() {
    const p = view.phase;
    const b = (label, key, action, primary = false) =>
      el(
        'button',
        { type: 'button', class: primary ? 'primary' : '', onclick: action },
        label,
        key ? el('kbd', {}, key) : null,
      );
    const list = [];
    if (p === 'round_intro')
      list.push(b('Next category', 'Space', () => act({ type: 'intro_next' }), true));
    if (p === 'wager_reveal')
      list.push(b(`Take the wager`, 'Space', () => act({ type: 'continue' }), true));
    if (p === 'wager') {
      const bounds = view.host.wagerBounds;
      const input = el('input', {
        type: 'number',
        id: 'host-wager',
        min: bounds?.min,
        max: bounds?.max,
        placeholder: `${bounds?.min}–${bounds?.max}`,
      });
      list.push(
        el(
          'form',
          {
            class: 'inline',
            onsubmit: (event) => (
              event.preventDefault(),
              act({ type: 'wager', amount: Number(input.value) })
            ),
          },
          el('label', {}, `${nameOf(view, view.clue?.wagerer)}'s wager (W) `),
          input,
          el('button', { type: 'submit', class: 'primary' }, 'Set'),
          el(
            'button',
            { type: 'button', onclick: () => act({ type: 'wager', amount: bounds.max }) },
            `Max ${money(bounds?.max ?? 0)}`,
          ),
        ),
      );
    }
    if (p === 'reading')
      list.push(
        b(
          view.clue?.wager ? 'Start response time' : 'Open buzzers',
          'Space',
          () => act({ type: 'open' }),
          true,
        ),
      );
    if (p === 'responding' || p === 'adjudicating') {
      list.push(
        b('Correct', 'Y', () => act({ type: 'rule', verdict: 'correct' }), true),
        b('Incorrect', 'N', () => act({ type: 'rule', verdict: 'incorrect' })),
        b('More specific', 'M', () => act({ type: 'more_specific' })),
      );
      if (view.host.questionForm === 'lenient' && !view.clue?.wager)
        list.push(b('Question-form reminder', 'Q', () => act({ type: 'remind_form' })));
    }
    if (p === 'clue_end')
      list.push(
        view.clue?.response
          ? b('Back to the board', 'Space', () => act({ type: 'next' }), true)
          : b('Show response', 'R', () => act({ type: 'reveal' }), true),
      );
    if (['wager_reveal', 'wager', 'reading', 'open', 'responding', 'adjudicating'].includes(p))
      list.push(b('Skip clue', 'S', () => act({ type: 'skip' })));
    if (p === 'board')
      list.push(
        b(
          'End round now',
          'E',
          () =>
            confirm('End this round now? Unplayed clues are left.') && act({ type: 'end_round' }),
        ),
      );
    if (p === 'round_end') list.push(b('Next round', 'Space', () => act({ type: 'next' }), true));
    if (p === 'final_category')
      list.push(b('Take wagers', 'Space', () => act({ type: 'continue' }), true));
    if (p === 'final_wager')
      list.push(b('Show the clue', 'Space', () => act({ type: 'continue' }), true));
    if (p === 'final_clue')
      list.push(b('Start the thinking time', 'Space', () => act({ type: 'continue' }), true));
    if (p === 'final_response')
      list.push(
        b(
          'End thinking time now',
          '',
          () => confirm('End the thinking time early?') && act({ type: 'continue' }),
        ),
      );
    if (p === 'final_reveal') {
      const f = view.final;
      list.push(b('Reveal next', 'Space', () => act({ type: 'final_reveal' }), true));
      if (f?.current && f.step !== 'wager')
        list.push(
          b('Correct', 'Y', () => act({ type: 'final_rule', verdict: 'correct' })),
          b('Incorrect', 'N', () => act({ type: 'final_rule', verdict: 'incorrect' })),
        );
      if (!f?.response) list.push(b('Show correct response', 'R', () => act({ type: 'reveal' })));
    }
    if (p === 'tiebreak')
      list.push(
        b(`Show the ${terms.tiebreak} clue`, 'Space', () => act({ type: 'continue' }), true),
      );
    if (!['lobby', 'game_over'].includes(p))
      list.push(
        b(view.paused ? 'Resume' : 'Pause', 'P', () =>
          act({ type: view.paused ? 'resume' : 'pause' }),
        ),
      );
    put(actions, ...list);
  }

  // ---- Players ---------------------------------------------------------------------

  function renderPlayers() {
    const rows = [...view.players]
      .sort((a, b) => a.seat - b.seat)
      .map((player, index) => {
        const connection = diag?.connections.find((entry) => entry.playerId === player.id);
        const online = presence[player.id];
        return el(
          'div',
          {
            class: `host-player${view.control === player.id ? ' control' : ''}${online ? '' : ' away'}`,
          },
          el(
            'div',
            { class: 'host-player-top' },
            el('span', { class: 'seat' }, String(index + 1)),
            el('strong', {}, player.name),
            view.control === player.id ? el('span', { class: 'badge' }, 'board') : null,
          ),
          el(
            'button',
            {
              type: 'button',
              class: `host-score${player.score < 0 ? ' negative' : ''}`,
              title: 'Set score',
              onclick: () => editScore(player),
            },
            money(player.score),
          ),
          el(
            'div',
            { class: 'host-conn' },
            online
              ? `${connection?.rtt != null ? `${connection.rtt.toFixed(0)} ms` : '…'} ±${connection?.jitter != null ? connection.jitter.toFixed(0) : '–'} · ${connection ? Math.round(connection.loss * 100) : 0}% lost`
              : 'disconnected',
          ),
          el(
            'div',
            { class: 'row small' },
            el(
              'button',
              { type: 'button', onclick: () => act({ type: 'set_control', playerId: player.id }) },
              `Give board (${index + 1})`,
            ),
            el(
              'button',
              { type: 'button', onclick: () => manage('rejoin_link', player.id) },
              'Rejoin link',
            ),
            el(
              'button',
              {
                type: 'button',
                onclick: () => {
                  const name = prompt('Name', player.name);
                  if (name) act({ type: 'rename_player', playerId: player.id, name });
                },
              },
              'Rename',
            ),
            el(
              'button',
              {
                type: 'button',
                onclick: () =>
                  confirm(`Remove ${player.name} from the game?`) &&
                  act({ type: 'remove_player', playerId: player.id }),
              },
              'Remove',
            ),
          ),
        );
      });
    const others = diag ? diag.connections.filter((entry) => !entry.playerId) : [];
    put(
      players,
      el('h2', {}, `Contestants (${view.players.length})`),
      ...rows,
      el(
        'div',
        { class: 'fine' },
        `Also connected: ${others.map((entry) => entry.role).join(', ') || 'nobody'}`,
      ),
      diag
        ? el(
            'div',
            { class: 'fine' },
            `Buzz arbitration on the server: median ${(diag.arbitration.p50 * 1000).toFixed(0)} µs, p99 ${(diag.arbitration.p99 * 1000).toFixed(0)} µs; broadcast ${(diag.broadcast.p50 * 1000).toFixed(0)} µs (${diag.arbitration.n} presses)`,
          )
        : null,
    );
  }

  function editScore(player) {
    const value = prompt(`Set ${player.name}'s score`, String(player.score));
    if (value === null) return;
    const score = Number(value.replace(/[$,\s]/g, ''));
    if (Number.isInteger(score)) act({ type: 'adjust', playerId: player.id, score });
    else say('A whole number, please.');
  }

  function renderLog() {
    const rulings = [...view.host.rulings].reverse().slice(0, 12);
    put(
      log,
      el('h2', {}, 'Rulings (U reverses the latest)'),
      rulings.length === 0
        ? el('p', { class: 'fine' }, 'None yet.')
        : el(
            'ul',
            {},
            rulings.map((ruling) =>
              el(
                'li',
                {},
                `${nameOf(view, ruling.playerId)} · ${ruling.category} · ${ruling.kind === 'clue' ? money(ruling.amount) : `${ruling.kind} ${money(ruling.amount)}`} · ${ruling.verdict}${ruling.reversed ? ' (reversed)' : ''} `,
                ruling.kind !== 'tiebreak'
                  ? el(
                      'button',
                      {
                        type: 'button',
                        class: 'small',
                        onclick: () => act({ type: 'reverse', rulingId: ruling.id }),
                      },
                      'Reverse',
                    )
                  : null,
              ),
            ),
          ),
    );
  }

  function render() {
    if (!view) return;
    renderHeader();
    renderLobby();
    renderBoard();
    renderClue();
    renderActions();
    renderPlayers();
    renderLog();
  }

  // ---- Keys ---------------------------------------------------------------------------

  const KEYS = [
    [
      'Space / Enter',
      'The next step: start, next category, open buzzers, show response, continue…',
    ],
    ['Arrows, Enter', 'Move on the board and choose a clue'],
    ['Y / N', 'Correct / incorrect (also in the final reveal)'],
    ['M', 'More specific (restarts their response time)'],
    ['Q', 'Question-form reminder (first round only)'],
    ['R', 'Show the correct response'],
    ['S', 'Skip this clue'],
    ['W', 'Type the wager'],
    ['1–6', 'Give that podium the board'],
    ['U', 'Reverse the latest ruling'],
    ['P', 'Pause / resume'],
    ['T', 'Buzzer test on / off'],
    ['E', 'End the round now'],
    ['?', 'This list'],
  ];
  help.append(
    el('h2', {}, 'Keys'),
    el(
      'table',
      {},
      KEYS.map(([key, what]) => el('tr', {}, el('td', {}, el('kbd', {}, key)), el('td', {}, what))),
    ),
    el('button', { type: 'button', onclick: () => help.close() }, 'Close'),
  );

  function primary() {
    const p = view.phase;
    const map = {
      lobby: { type: 'start_game' },
      buzzer_test: { type: 'start_game' },
      round_intro: { type: 'intro_next' },
      wager_reveal: { type: 'continue' },
      reading: { type: 'open' },
      round_end: { type: 'next' },
      final_category: { type: 'continue' },
      final_wager: { type: 'continue' },
      final_clue: { type: 'continue' },
      final_reveal: { type: 'final_reveal' },
      tiebreak: { type: 'continue' },
    };
    if (p === 'board') return act({ type: 'select', col: cursor.col, row: cursor.row });
    if (p === 'clue_end') return act(view.clue?.response ? { type: 'next' } : { type: 'reveal' });
    if (map[p]) return act(map[p]);
  }

  document.addEventListener('keydown', (event) => {
    if (!view || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      if (event.key === 'Escape') event.target.blur();
      return;
    }
    if (help.open || linkDialog.open) return;
    if (event.repeat && !event.key.startsWith('Arrow')) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const p = view.phase;
    const final = p === 'final_reveal';
    const responding = p === 'responding' || p === 'adjudicating';
    const handled = (() => {
      if (key === ' ' || key === 'Enter') return (primary(), true);
      if (key === '?') return (help.showModal(), true);
      if (key === 'y' && responding) return (act({ type: 'rule', verdict: 'correct' }), true);
      if (key === 'n' && responding) return (act({ type: 'rule', verdict: 'incorrect' }), true);
      if (key === 'y' && final) return (act({ type: 'final_rule', verdict: 'correct' }), true);
      if (key === 'n' && final) return (act({ type: 'final_rule', verdict: 'incorrect' }), true);
      if (key === 'm') return (act({ type: 'more_specific' }), true);
      if (key === 'q') return (act({ type: 'remind_form' }), true);
      if (key === 'r') return (act({ type: 'reveal' }), true);
      if (key === 's') return (act({ type: 'skip' }), true);
      if (key === 'p') return (act({ type: view.paused ? 'resume' : 'pause' }), true);
      if (key === 't')
        return (act({ type: p === 'buzzer_test' ? 'end_test' : 'start_test' }), true);
      if (key === 'e' && p === 'board')
        return (confirm('End this round now?') && act({ type: 'end_round' }), true);
      if (key === 'w') return (document.getElementById('host-wager')?.focus(), true);
      if (key === 'u') {
        const last = [...view.host.rulings].reverse().find((ruling) => ruling.kind !== 'tiebreak');
        if (
          last &&
          confirm(`Reverse: ${nameOf(view, last.playerId)} ${last.verdict} on ${last.category}?`)
        )
          act({ type: 'reverse', rulingId: last.id });
        return true;
      }
      if (/^[1-6]$/.test(key)) {
        const player = [...view.players].sort((a, b) => a.seat - b.seat)[Number(key) - 1];
        if (player) act({ type: 'set_control', playerId: player.id });
        return true;
      }
      if (key.startsWith('Arrow') && view.board) {
        const cols = view.board.categories.length;
        const rows = view.board.values.length;
        if (key === 'ArrowLeft') cursor.col = (cursor.col + cols - 1) % cols;
        if (key === 'ArrowRight') cursor.col = (cursor.col + 1) % cols;
        if (key === 'ArrowUp') cursor.row = (cursor.row + rows - 1) % rows;
        if (key === 'ArrowDown') cursor.row = (cursor.row + 1) % rows;
        renderBoard();
        return true;
      }
      return false;
    })();
    if (handled) event.preventDefault();
  });

  // Countdowns tick between states.
  setInterval(() => {
    if (!view) return;
    updateLine();
    if (view.roundRemainingMs !== null) renderHeader();
  }, 200);

  const socket = connect({
    code,
    token,
    onWelcome: async (message) => {
      welcome = message;
      if (message.role !== 'host' && message.role !== 'cohost') {
        put(app, el('p', { class: 'notice' }, 'This link is not a host link.'));
        return;
      }
      await loadTheme(message.theme);
      render();
    },
    onState: (next, message) => {
      view = next;
      presence = message.presence;
      render();
    },
    onMessage: (message) => {
      if (message.type === 'diag') {
        diag = message;
        if (view) {
          renderPlayers();
          if (view.phase === 'buzzer_test') renderLobby();
        }
      }
    },
    onStatus: (next) => {
      status = next;
      renderHeader();
      if (next === 'refused')
        app.prepend(
          el(
            'p',
            { class: 'notice' },
            'This host link is no longer valid (the host role was transferred or revoked).',
          ),
        );
    },
  });
}

function formatClock(ms) {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
