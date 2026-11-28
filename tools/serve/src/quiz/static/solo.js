// Single player: the television picture plus a strip for playing. The
// server is the host; this page reads clues aloud (speech synthesis, if
// on), tells the server when it's finished so the buzzer opens, and sends
// typed responses to be judged.

import { Audio } from './audio.js';
import {
  connect,
  el,
  keepAwake,
  loadTheme,
  money,
  page,
  put,
  storage,
  takeToken,
  terms,
  theme,
} from './lib.js';
import { Stage } from './stage.js';

const code = page().code;
const app = document.getElementById('app');
const token = takeToken(code, 'player');

if (!token) location.replace('/trivia/solo/');
else run();

function run() {
  const audio = new Audio();
  const stage = new Stage(app, { code, showJoin: false });
  let view = null;
  let judged = null;
  let narrate = storage.get('quiz:narrate') !== 'off';

  const input = el('input', {
    class: 'solo-input',
    maxlength: 200,
    autocomplete: 'off',
    placeholder: 'Type your response, then Enter',
    'aria-label': 'Your response',
  });
  const hint = el('div', { class: 'solo-hint' });
  const result = el('div', { class: 'solo-result' });
  const speakToggle = el(
    'button',
    {
      type: 'button',
      class: 'small',
      onclick: () => {
        narrate = !narrate;
        storage.set('quiz:narrate', narrate ? 'on' : 'off');
        speakToggle.textContent = narrate ? 'Narration on' : 'Narration off';
        if (!narrate) audio.silence();
      },
    },
    narrate ? 'Narration on' : 'Narration off',
  );
  const bar = el(
    'div',
    { class: 'solo-bar' },
    hint,
    input,
    result,
    el('div', { class: 'row small' }, speakToggle),
  );
  app.append(bar);

  const start = el(
    'button',
    { class: 'display-start', type: 'button' },
    el('span', { class: 'display-start-title' }, 'Start'),
    el('span', {}, 'Click or press any key for sound and narration'),
  );
  app.append(start);
  const begin = async () => {
    start.remove();
    document.removeEventListener('keydown', begin, true);
    await audio.unlock();
    keepAwake();
    if (view) onView(view, { cues: [] }, true);
  };
  start.addEventListener('click', begin);
  document.addEventListener('keydown', begin, true);

  let spokenSeq = -1;
  async function speakClue(text) {
    if (!narrate || !audio.ready) return;
    const seq = view.seq;
    if (spokenSeq === seq) return;
    spokenSeq = seq;
    await audio.speak(text);
    if (view.seq === seq) socket.raw({ type: 'narrated', seq });
  }

  function onView(next, message, replay = false) {
    view = next;
    judged = message.judged ?? judged;
    stage.render(view, { presence: message.presence ?? {}, cues: message.cues ?? [] });
    for (const cue of message.cues ?? []) {
      if (
        [
          'board_fill',
          'category',
          'wager_reveal',
          'time_up',
          'round_end',
          'game_over',
          'final_think',
        ].includes(cue.type)
      )
        audio.play(cue.type);
    }
    if (view.phase !== 'final_response') audio.stopMusic();
    const p = view.phase;
    if (p === 'reading' && view.clue?.text) speakClue(view.clue.text);
    if (p === 'final_clue' && view.final?.text) speakClue(view.final.text);
    renderBar(replay);
  }

  function renderBar() {
    const p = view.phase;
    const me = view.me?.id;
    const canAnswer = (p === 'responding' || p === 'adjudicating') && view.clue?.responder === me;
    const finalWriting = p === 'final_response' && view.final?.eligible.includes(me);
    input.hidden = !(canAnswer || finalWriting || p === 'wager' || p === 'final_wager');
    input.type = p === 'wager' || p === 'final_wager' ? 'number' : 'text';
    input.placeholder =
      p === 'wager'
        ? `${terms.wager}: ${money(view.me.wager?.min ?? 5)}–${money(view.me.wager?.max ?? 0)}`
        : p === 'final_wager'
          ? `${terms.wager}: ${money(0)}–${money(view.me.finalMax ?? 0)}`
          : 'Type your response, then Enter';
    if (!input.hidden && document.activeElement !== input) setTimeout(() => input.focus(), 30);
    let text = '';
    if (p === 'board') text = 'Choose a clue: click it on the board.';
    if (p === 'reading') text = narrate ? 'Listen…' : 'Read the clue…';
    if (p === 'open') text = 'Space to ring in';
    if (canAnswer) text = 'Your response:';
    if (p === 'wager' || p === 'final_wager') text = `${terms.wager}, then Enter`;
    if (p === 'final_response') text = `${terms.final}: your response, then Enter`;
    if (p === 'game_over') text = `Final score ${money(view.players[0]?.score ?? 0)}. `;
    hint.textContent = text;
    put(result);
    if (judged && ['clue_end', 'final_reveal', 'game_over'].includes(p)) {
      put(
        result,
        el(
          'span',
          { class: `judged ${judged.verdict.startsWith('correct') ? 'right' : 'wrong'}` },
          judged.text ? `“${judged.text}”: ${judged.verdict}` : judged.verdict,
        ),
        judged.verdict === 'incorrect' && judged.text
          ? el(
              'button',
              { type: 'button', class: 'small', onclick: () => socket.send({ type: 'appeal' }) },
              'I was right',
            )
          : null,
      );
    }
    if (p === 'game_over')
      result.append(el('a', { href: '/trivia/solo/', class: 'button' }, 'Play again'));
  }

  // Choosing a clue on the stage's board.
  app.addEventListener('click', (event) => {
    const cell = event.target.closest?.('.tile.cell');
    if (!cell || view?.phase !== 'board') return;
    socket.act({ type: 'select', col: Number(cell.dataset.col), row: Number(cell.dataset.row) });
  });

  document.addEventListener('keydown', (event) => {
    if (event.repeat || !view) return;
    if (event.target === input) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = input.value.trim();
      const p = view.phase;
      if (p === 'wager') socket.act({ type: 'wager', amount: Number(value) });
      else if (p === 'final_wager') socket.act({ type: 'final_wager', amount: Number(value) });
      else if (value) socket.send({ type: 'answer', text: value });
      input.value = '';
      return;
    }
    if (event.key === ' ' && ['open', 'reading'].includes(view.phase)) {
      event.preventDefault();
      socket.act({ type: 'buzz', seq: view.seq });
    }
  });

  const socket = connect({
    code,
    token,
    onWelcome: async (welcome) => {
      await loadTheme(welcome.theme);
      audio.theme = theme;
    },
    onState: (next, message) => onView(next, message),
  });
}
