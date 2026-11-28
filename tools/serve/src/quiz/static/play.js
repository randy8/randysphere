// The contestant's phone: a buzzer, their score, and — only when it's
// theirs to do — choosing a clue, a wager, a final response. Ordinary
// responses are spoken aloud to the host, as on television; nothing here
// asks for typing except the final round's written response.
//
// The buzzer fires on pointerdown (not click: a click waits for the finger
// to lift). It always sends the press, even when the buzzers look locked —
// the server decides, and a press before the light locks the player out
// for a quarter second. What the phone shows at once is only that the
// press was sent; whether it won arrives with the next state.

import {
  connect,
  el,
  forgetToken,
  keepAwake,
  loadTheme,
  money,
  nameOf,
  page,
  put,
  remaining,
  statusText,
  takeToken,
  terms,
} from './lib.js';

const code = page().code;
const app = document.getElementById('app');
const token = takeToken(code, 'player');

if (!token) {
  location.replace(`/trivia/join/${code}`);
} else {
  run();
}

function run() {
  let view = null;
  let me = null;
  let status = 'connecting';
  let lastLatency = null;

  const header = el(
    'header',
    { class: 'play-head' },
    el('span', { class: 'play-name' }),
    el('span', { class: 'play-score value-type' }),
    el('span', { class: 'play-conn' }),
  );
  const message = el('div', { class: 'play-message' });
  const panel = el('div', { class: 'play-panel' });
  const buzzer = el(
    'button',
    { class: 'buzzer', type: 'button', 'aria-label': 'Buzzer' },
    el('span', { class: 'buzzer-label' }, ''),
  );
  const footer = el('div', { class: 'play-foot' });
  app.append(header, message, panel, buzzer, footer);

  // ---- The buzzer -----------------------------------------------------------
  let pressedAt = 0;
  function press(event) {
    event?.preventDefault?.();
    if (!view || !socket.open) return;
    pressedAt = performance.now();
    buzzer.classList.remove('sent');
    void buzzer.offsetWidth;
    buzzer.classList.add('sent');
    navigator.vibrate?.(15);
    // The seq of the state this phone is showing: the server judges a
    // press made while the buzzers looked locked as early.
    socket.act({ type: 'buzz', seq: view.seq }).then((ack) => {
      lastLatency = Math.round(performance.now() - pressedAt);
      footer.textContent = `Last press reached the server and back in ${lastLatency} ms${ack.ok ? '' : ` (${ack.error})`}`;
      if (!ack.ok && ack.error === 'locked out') flashLocked();
    });
  }
  buzzer.addEventListener('pointerdown', press);
  buzzer.addEventListener('contextmenu', (event) => event.preventDefault());
  // Keyboards and USB/Bluetooth buttons that type a key: Space, Enter, B.
  document.addEventListener('keydown', (event) => {
    if (event.repeat) return; // a held key is one press
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
      return;
    if (event.key === ' ' || event.key === 'Enter' || event.key === 'b' || event.key === 'B')
      press(event);
  });

  function flashLocked() {
    buzzer.classList.add('locked-flash');
    setTimeout(() => buzzer.classList.remove('locked-flash'), 260);
  }

  keepAwake();

  // ---- Rendering ------------------------------------------------------------
  function render() {
    if (!view || !me) return;
    const player = view.players.find((candidate) => candidate.id === me);
    header.children[0].textContent = player?.name ?? '';
    const score = header.children[1];
    score.textContent = money(player?.score ?? 0);
    score.classList.toggle('negative', (player?.score ?? 0) < 0);
    header.children[2].textContent = status === 'online' ? '●' : '○';
    header.children[2].className = `play-conn ${status}`;

    const p = view.phase;
    const clue = view.clue;
    const responder = clue?.responder;
    let state = 'idle';
    let label = '';
    let text = '';
    if (status !== 'online') {
      state = 'disconnected';
      label = '';
      text = statusText(status);
    } else if (view.paused) {
      text = 'Paused';
    } else if (p === 'lobby') {
      text = 'You’re in. Waiting for the host to start.';
    } else if (p === 'buzzer_test') {
      state = 'ready';
      label = 'TEST';
      text = 'Buzzer test: press your buzzer.';
    } else if (
      p === 'open' &&
      clue &&
      !clue.attempted.includes(me) &&
      !clue.wager &&
      clue.responder === null
    ) {
      state = 'ready';
      label = terms.buzz.toUpperCase();
    } else if ((p === 'responding' || p === 'adjudicating') && responder === me) {
      state = 'won';
      label = 'YOU';
      text = clue?.wager ? 'Your response' : 'You rang in first. Respond aloud';
    } else if ((p === 'responding' || p === 'adjudicating') && responder) {
      state = 'locked';
      text = `${nameOf(view, responder)} is responding`;
    } else if (p === 'reading' && clue && !clue.wager) {
      state = 'waiting';
      text = 'Wait for the buzzers…';
    } else if (clue?.attempted?.includes(me) && ['open', 'responding'].includes(p)) {
      state = 'locked';
      text = 'You’ve responded to this one';
    } else if (p === 'board') {
      text =
        view.control === me
          ? `${terms.boardControl}: choose a clue`
          : `${nameOf(view, view.control)} is choosing`;
    } else if (p === 'game_over') {
      text = view.winners.includes(me)
        ? `You win! ${money(player?.score ?? 0)}`
        : `${view.winners.map((id) => nameOf(view, id)).join(' & ') || 'Nobody'} wins`;
    } else if (
      p === 'final_category' ||
      p === 'final_wager' ||
      p === 'final_clue' ||
      p === 'final_response' ||
      p === 'final_reveal'
    ) {
      text = view.final?.eligible.includes(me)
        ? ''
        : 'You sit out the final round (a score above zero is needed)';
    } else if (p === 'wager_reveal' || p === 'wager') {
      text =
        clue?.wagerer === me ? '' : `${nameOf(view, clue?.wagerer)} found the ${terms.wagerClue}`;
    } else if (p === 'tiebreak') {
      text = view.winners.includes(me) ? `${terms.tiebreak}: get ready to buzz` : terms.tiebreak;
    }
    buzzer.dataset.state = state;
    buzzer.firstChild.textContent = label;
    buzzer.hidden =
      ['board', 'wager', 'final_wager', 'final_clue', 'final_response'].includes(p) &&
      renderPanel(true);
    message.textContent = text;
    renderPanel(false);
  }

  /** The panel for whatever is this player's to do. Returns whether it shows something. */
  let panelKey = '';
  function renderPanel(probe) {
    const p = view.phase;
    const mine = view.me;
    let key = 'none';
    if (p === 'board' && mine.canSelect) key = `select:${view.seq}`;
    else if (p === 'wager' && mine.wager) key = `wager:${view.clue?.col}:${view.clue?.row}`;
    else if (p === 'final_wager' && mine.finalMax !== null) key = 'finalwager';
    else if ((p === 'final_clue' || p === 'final_response') && mine.finalMax !== null)
      key = `finalresponse:${p}`;
    if (probe) return key !== 'none';
    if (key === panelKey) {
      if (key === 'finalwager') updateFinalWager();
      return key !== 'none';
    }
    panelKey = key;
    put(panel);
    if (key.startsWith('select')) panel.append(selectionGrid());
    else if (key.startsWith('wager'))
      panel.append(
        wagerForm(mine.wager.min, mine.wager.max, (amount) =>
          socket.act({ type: 'wager', amount }),
        ),
      );
    else if (key === 'finalwager') {
      panel.append(
        el('div', { class: 'panel-title' }, `${terms.final}: ${view.final.category}`),
        wagerForm(
          0,
          mine.finalMax,
          (amount) => socket.act({ type: 'final_wager', amount }),
          mine.finalWager,
        ),
        el('div', { class: 'panel-note', id: 'final-wager-status' }),
      );
      updateFinalWager();
    } else if (key.startsWith('finalresponse')) panel.append(finalResponse());
    return key !== 'none';
  }

  function updateFinalWager() {
    const note = document.getElementById('final-wager-status');
    if (note)
      note.textContent =
        view.me.finalWager === null
          ? 'Your wager is private.'
          : `Wager locked in: ${money(view.me.finalWager)} . You can change it until the clue is shown.`;
  }

  function selectionGrid() {
    const board = view.board;
    const grid = el('div', { class: 'select-grid' });
    grid.style.gridTemplateColumns = `repeat(${board.categories.length}, 1fr)`;
    board.categories.forEach((category) =>
      grid.append(el('div', { class: 'select-head category-type' }, category.title ?? '')),
    );
    board.values.forEach((value, row) =>
      board.categories.forEach((_, col) => {
        const left = board.remaining[col][row];
        grid.append(
          el(
            'button',
            {
              class: 'select-cell value-type',
              type: 'button',
              disabled: !left,
              onclick: () => socket.act({ type: 'select', col, row }),
            },
            left ? money(value) : '',
          ),
        );
      }),
    );
    return el('div', {}, el('div', { class: 'panel-title' }, 'Choose a clue'), grid);
  }

  function wagerForm(min, max, submit, current = null) {
    const input = el('input', {
      type: 'number',
      inputmode: 'numeric',
      min,
      max,
      step: 1,
      value: current ?? '',
      class: 'wager-input',
      'aria-label': 'Wager',
    });
    const error = el('div', { class: 'panel-error' });
    const form = el(
      'form',
      {
        class: 'wager-form',
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          const amount = Number(input.value);
          if (!Number.isInteger(amount) || amount < min || amount > max) {
            error.textContent = `Enter a whole number from ${money(min)} to ${money(max)}.`;
            return;
          }
          const ack = await submit(amount);
          error.textContent = ack.ok ? '' : ack.error;
        },
      },
      el('label', { class: 'panel-title' }, `${terms.wager}: ${money(min)} to ${money(max)}`),
      input,
      el(
        'div',
        { class: 'wager-quick' },
        el(
          'button',
          { type: 'button', onclick: () => (input.value = String(max)) },
          `All ${money(max)}`,
        ),
      ),
      el('button', { type: 'submit', class: 'primary' }, 'Lock in'),
      error,
    );
    setTimeout(() => input.focus(), 50);
    return form;
  }

  function finalResponse() {
    const open = view.phase === 'final_response';
    const box = el('textarea', {
      class: 'final-input',
      rows: 3,
      maxlength: 200,
      placeholder: 'Who is… / What is…',
      disabled: !open,
      'aria-label': 'Your response',
    });
    box.value = view.me.finalResponse ?? '';
    const note = el(
      'div',
      { class: 'panel-note' },
      open
        ? 'Saved as you type. Only the host sees it until it’s revealed.'
        : 'The clue is up. Writing opens when the host starts the clock.',
    );
    const timer = el('div', { class: 'final-timer' });
    let saveTimer;
    box.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => socket.act({ type: 'final_response', text: box.value }), 350);
    });
    const tick = () => {
      if (!document.body.contains(timer)) return;
      const left = remaining(view);
      timer.textContent =
        view.phase === 'final_response' && left !== null ? `${Math.ceil(left / 1000)} s` : '';
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    if (open) setTimeout(() => box.focus(), 50);
    return el(
      'div',
      {},
      el('div', { class: 'panel-title' }, view.final?.text ?? view.final?.category ?? ''),
      box,
      timer,
      note,
    );
  }

  // ---- The connection --------------------------------------------------------
  const socket = connect({
    code,
    token,
    onWelcome: async (welcome) => {
      me = welcome.playerId;
      await loadTheme(welcome.theme);
      render();
    },
    onState: (next, msg) => {
      const before = view;
      view = next;
      for (const cue of msg.cues) {
        if (cue.type === 'lockout' && cue.playerId === me) flashLocked();
        if (cue.type === 'buzz' && cue.playerId === me) navigator.vibrate?.([30, 40, 30]);
      }
      if (before?.phase !== view.phase && panelKey.startsWith('select')) panelKey = '';
      render();
    },
    onStatus: (next) => {
      status = next;
      if (next === 'refused') forgetToken(code, 'player');
      render();
      if (next === 'refused' || next === 'gone') {
        buzzer.hidden = true;
        message.textContent = statusText(next);
        put(panel, el('a', { href: `/trivia/join/${code}`, class: 'button' }, 'Join again'));
      }
    },
  });
}
