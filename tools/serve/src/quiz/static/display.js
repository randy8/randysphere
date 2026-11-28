// The audience display: the television. Watches the room as a spectator
// (its own token, public view only), plays the sound, and shows nothing
// but the game — no controls once it has started. One click or key press
// first, because browsers allow full screen and sound only after one.

import { Audio } from './audio.js';
import {
  api,
  connect,
  el,
  keepAwake,
  loadTheme,
  page,
  put,
  statusText,
  storage,
  theme,
} from './lib.js';
import { Stage } from './stage.js';

const code = page().code;
const app = document.getElementById('app');

async function spectatorToken() {
  const key = `quiz:${code}:spectator`;
  const saved = storage.get(key);
  if (saved) return saved;
  const { token } = await api(`/quiz/api/rooms/${code}/watch`, { method: 'POST', body: {} });
  storage.set(key, token);
  return token;
}

async function main() {
  let token;
  try {
    token = await spectatorToken();
  } catch (error) {
    put(app, el('p', { class: 'notice' }, `No game with the code ${code}. ${error.message}`));
    return;
  }
  const audio = new Audio();
  const stage = new Stage(app, { code });
  const corner = el('div', { class: 'display-status' });
  app.append(corner);

  const start = el(
    'button',
    { class: 'display-start', type: 'button' },
    el('span', { class: 'display-start-title' }, 'Start the display'),
    el('span', {}, 'Click or press any key — for full screen and sound'),
  );
  app.append(start);
  const begin = async () => {
    start.remove();
    document.removeEventListener('keydown', begin);
    try {
      await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    } catch {
      // Not allowed here (an embedded browser); the page still works.
    }
    await audio.unlock();
    keepAwake();
  };
  start.addEventListener('click', begin);
  document.addEventListener('keydown', begin);
  // Hide the pointer once the game is on screen.
  let idle;
  document.addEventListener('pointermove', () => {
    document.body.classList.remove('hide-cursor');
    clearTimeout(idle);
    idle = setTimeout(() => document.body.classList.add('hide-cursor'), 2500);
  });

  let themed = false;
  let lastPhase = '';
  connect({
    code,
    token,
    onWelcome: async (welcome) => {
      if (!themed) {
        themed = true;
        await loadTheme(welcome.theme);
        audio.theme = theme;
        if (audio.ctx) await audio.preload();
      }
    },
    onState: (view, message) => {
      stage.render(view, { presence: message.presence, cues: message.cues });
      for (const cue of message.cues) {
        if (
          ['board_fill', 'category', 'wager_reveal', 'time_up', 'round_end', 'game_over'].includes(
            cue.type,
          )
        )
          audio.play(cue.type);
        if (cue.type === 'buzz') audio.play('buzz');
        if (cue.type === 'final_think') audio.play('final_think');
      }
      if (lastPhase === 'final_response' && view.phase !== 'final_response') audio.stopMusic();
      // A display that joins during the thinking time picks the music up where it is.
      if (
        view.phase === 'final_response' &&
        lastPhase !== 'final_response' &&
        !message.cues.some((cue) => cue.type === 'final_think') &&
        view.remainingMs !== null
      ) {
        audio.play('final_think', Math.max(0, 30000 - view.remainingMs));
      }
      lastPhase = view.phase;
    },
    onStatus: (status) => {
      corner.textContent = status === 'online' ? '' : statusText(status);
      corner.classList.toggle('bad', status !== 'online');
    },
  });
}

main();
