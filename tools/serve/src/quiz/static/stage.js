// The television picture: a fixed 1920×1080 stage, scaled to whatever
// screen it's on, with the board, the clue, full-screen cards and the
// podiums. Used by the audience display and by single player. It renders
// a public view (engine/project.ts) and nothing else — it never has a
// response before the host reveals it, because it is never sent one.

import { el, money, nameOf, put, remaining, roundName, terms } from './lib.js';

const W = 1920;
const H = 1080;

function clueSize(text) {
  const n = text.length;
  if (n > 260) return 54;
  if (n > 190) return 62;
  if (n > 120) return 72;
  if (n > 70) return 82;
  return 92;
}

export class Stage {
  constructor(root, { code = '', showJoin = true } = {}) {
    this.code = code;
    this.showJoin = showJoin;
    this.view = null;
    this.presence = {};
    this.lit = new Map();
    this.responseTotal = null;
    this.tv = el('div', { class: 'tv' });
    this.screen = el('div', { class: 'screen' });
    this.overlay = el('div', { class: 'overlay' });
    this.podiums = el('div', { class: 'podiums' });
    this.pausedBadge = el('div', { class: 'paused-badge', hidden: true }, 'Paused');
    this.tv.append(this.screen, this.overlay, this.podiums, this.pausedBadge);
    root.append(this.tv);
    this.fit = () => {
      const scale = Math.min(window.innerWidth / W, window.innerHeight / H);
      this.tv.style.transform = `translate(-50%, -50%) scale(${scale})`;
    };
    window.addEventListener('resize', this.fit);
    this.fit();
    this.sceneKey = '';
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  /** Per-frame: countdowns and podium timer lights. */
  frame() {
    const view = this.view;
    if (view) {
      const left = remaining(view);
      for (const bar of this.tv.querySelectorAll('[data-countdown]')) {
        const total = Number(bar.dataset.total);
        bar.style.transform = `scaleX(${left === null || !total ? 0 : Math.max(0, Math.min(1, left / total))})`;
      }
      const responder = view.clue?.responder;
      for (const podium of this.podiums.children) {
        const lights = podium.querySelectorAll('.timer-light');
        const active =
          responder &&
          podium.dataset.player === responder &&
          ['responding'].includes(view.phase) &&
          left !== null &&
          this.responseTotal;
        // Lights go out from both ends toward the middle as the time runs down.
        const fraction = active ? left / this.responseTotal : 0;
        const on = Math.ceil(fraction * Math.ceil(lights.length / 2));
        const middle = (lights.length - 1) / 2;
        lights.forEach((light, i) =>
          light.classList.toggle('on', Boolean(active) && Math.abs(i - middle) < on),
        );
      }
    }
    requestAnimationFrame(this.frame);
  }

  /** A press (buzz, test press, lockout) flashes a podium. */
  flash(playerId, kind) {
    const podium = this.podiums.querySelector(`[data-player="${CSS.escape(playerId)}"]`);
    if (!podium) return;
    podium.classList.remove('flash-buzz', 'flash-lockout', 'flash-test');
    void podium.offsetWidth;
    podium.classList.add(`flash-${kind}`);
  }

  render(view, { presence = {}, cues = [] } = {}) {
    const previous = this.view;
    this.view = view;
    this.presence = presence;
    if (
      view.phase === 'responding' &&
      (previous?.phase !== 'responding' ||
        previous?.clue?.responder !== view.clue?.responder ||
        (view.remainingMs ?? 0) > (this.responseTotal ?? 0))
    ) {
      this.responseTotal = view.remainingMs;
    }
    this.renderPodiums(view);
    this.pausedBadge.hidden = !view.paused;
    this.pausedBadge.textContent =
      view.paused === 'restart' ? 'Paused — the server restarted' : 'Paused';
    const key = this.sceneOf(view);
    const scene = key.split(':')[0];
    const fresh = key !== this.sceneKey;
    if (fresh) {
      const from =
        scene === 'clue' && previous && this.sceneKey.startsWith('board')
          ? this.tileRect(view.clue)
          : null;
      put(this.screen, this.build(view, scene));
      if (from) this.zoomFrom(from);
      this.sceneKey = key;
    } else {
      this.update(view, scene);
    }
    for (const cue of cues) this.cue(cue, view);
  }

  sceneOf(view) {
    const p = view.phase;
    if (p === 'lobby' || p === 'buzzer_test') return `lobby:${p}`;
    if (p === 'round_intro' || p === 'board' || p === 'round_end') return `board:${view.round}`;
    if (p === 'wager_reveal') return `wagerreveal:${view.clue?.col}:${view.clue?.row}`;
    if (p === 'wager') return `wager:${view.clue?.col}:${view.clue?.row}`;
    if (['reading', 'open', 'responding', 'adjudicating', 'clue_end'].includes(p)) {
      return `clue:${view.round}:${view.clue?.col}:${view.clue?.row}:${view.clue?.tiebreak ? 't' : ''}`;
    }
    if (p === 'final_category' || p === 'final_wager') return 'finalcard';
    if (p === 'final_clue' || p === 'final_response') return 'finalclue';
    if (p === 'final_reveal') return `finalreveal:${view.final?.current ?? 'none'}`;
    if (p === 'tiebreak') return `tiebreak:${view.tiebreakCategory}`;
    if (p === 'game_over') return 'over';
    return p;
  }

  build(view, scene) {
    switch (scene) {
      case 'lobby':
        return this.lobby(view);
      case 'board':
        return this.board(view);
      case 'wagerreveal':
        return el(
          'div',
          { class: 'card wager-card' },
          el('div', { class: 'wager-word' }, terms.wagerClue),
        );
      case 'wager':
        return el(
          'div',
          { class: 'card' },
          el('div', { class: 'card-kicker' }, view.clue?.category ?? ''),
          el('div', { class: 'card-title' }, terms.wager),
          el('div', { class: 'card-sub' }, nameOf(view, view.clue?.wagerer)),
        );
      case 'clue':
        return this.clue(view);
      case 'finalcard':
        return el(
          'div',
          { class: 'card final-card' },
          el('div', { class: 'card-kicker' }, terms.final),
          el('div', { class: 'card-title category-type' }, view.final?.category ?? ''),
          view.final?.note ? el('div', { class: 'card-note' }, view.final.note) : null,
          el('div', { class: 'card-sub', 'data-final-status': '' }),
        );
      case 'finalclue':
        return this.finalClue(view);
      case 'finalreveal':
        return this.finalReveal(view);
      case 'tiebreak':
        return el(
          'div',
          { class: 'card' },
          el('div', { class: 'card-kicker' }, terms.tiebreak),
          el('div', { class: 'card-title category-type' }, view.tiebreakCategory ?? ''),
        );
      case 'over':
        return this.gameOver(view);
      default:
        return el('div', { class: 'card' });
    }
  }

  update(view, scene) {
    if (scene === 'board') this.updateBoard(view);
    if (scene === 'clue') this.updateClue(view);
    if (scene === 'finalcard') {
      const status = this.screen.querySelector('[data-final-status]');
      if (status && view.phase === 'final_wager') {
        status.textContent = `${terms.wager}s in: ${view.final.wagered.length} of ${view.final.eligible.length}`;
      }
    }
    if (scene === 'finalclue') this.updateFinalClue(view);
    if (scene === 'finalreveal') put(this.screen, this.finalReveal(view));
    if (scene === 'over') put(this.screen, this.gameOver(view));
    if (scene === 'lobby') put(this.screen, this.lobby(view));
  }

  // -- Lobby ------------------------------------------------------------------

  lobby(view) {
    const testing = view.phase === 'buzzer_test';
    return el(
      'div',
      { class: 'lobby' },
      el('div', { class: 'lobby-title' }, view.title),
      view.credit ? el('div', { class: 'lobby-credit' }, view.credit) : null,
      testing
        ? el('div', { class: 'lobby-test' }, 'Buzzer test — contestants, press your buzzers')
        : this.showJoin && this.code
          ? el(
              'div',
              { class: 'lobby-join' },
              el('img', {
                class: 'lobby-qr',
                src: `/trivia/api/rooms/${this.code}/qr.svg`,
                alt: '',
              }),
              el(
                'div',
                { class: 'lobby-how' },
                el('div', {}, 'Scan to play, or go to'),
                el('div', { class: 'lobby-url' }, `${location.host}/trivia/join`),
                el('div', {}, 'and enter'),
                el('div', { class: 'lobby-code' }, this.code),
              ),
            )
          : null,
    );
  }

  // -- Board ------------------------------------------------------------------

  board(view) {
    const board = view.board;
    const grid = el('div', { class: 'board' });
    if (!board)
      return el(
        'div',
        { class: 'card' },
        el('div', { class: 'card-title' }, roundName(view.round, view.rounds)),
      );
    grid.style.gridTemplateColumns = `repeat(${board.categories.length}, 1fr)`;
    grid.style.gridTemplateRows = `1.25fr repeat(${board.values.length}, 1fr)`;
    board.categories.forEach((category, col) => {
      grid.append(
        el(
          'div',
          { class: 'tile head', dataset: { col } },
          el('span', { class: 'category-type' }, category.title ?? ''),
        ),
      );
    });
    board.values.forEach((value, row) => {
      board.categories.forEach((_, col) => {
        grid.append(
          el(
            'div',
            { class: 'tile cell', dataset: { col, row } },
            el('span', { class: 'value-type' }, money(value)),
          ),
        );
      });
    });
    const wrap = el(
      'div',
      { class: 'board-wrap' },
      grid,
      el('div', { class: 'round-banner', hidden: true }),
    );
    queueMicrotask(() => this.updateBoard(view));
    return wrap;
  }

  updateBoard(view) {
    const board = view.board;
    if (!board) return;
    for (const head of this.screen.querySelectorAll('.tile.head')) {
      const category = board.categories[Number(head.dataset.col)];
      const span = head.firstChild;
      if (span.textContent !== (category?.title ?? '')) span.textContent = category?.title ?? '';
      head.classList.toggle('blank', !category?.title);
    }
    for (const cell of this.screen.querySelectorAll('.tile.cell')) {
      const left = board.remaining[Number(cell.dataset.col)]?.[Number(cell.dataset.row)];
      cell.classList.toggle('played', !left);
    }
    const banner = this.screen.querySelector('.round-banner');
    if (banner) {
      banner.hidden = view.phase !== 'round_end';
      banner.textContent = view.roundExpired ? `Time — ${terms.roundEnd}` : terms.roundEnd;
    }
  }

  tileRect(clue) {
    const tile = this.screen.querySelector(
      `.tile.cell[data-col="${clue?.col}"][data-row="${clue?.row}"]`,
    );
    if (!tile) return null;
    const outer = this.screen.getBoundingClientRect();
    const rect = tile.getBoundingClientRect();
    return {
      x: (rect.left - outer.left) / outer.width,
      y: (rect.top - outer.top) / outer.height,
      w: rect.width / outer.width,
      h: rect.height / outer.height,
    };
  }

  /** The clue grows out of the tile it was chosen from. */
  zoomFrom(rect) {
    const panel = this.screen.firstElementChild;
    if (!panel?.animate) return;
    panel.animate(
      [
        {
          transformOrigin: '0 0',
          transform: `translate(${rect.x * 100}%, ${rect.y * 100}%) scale(${rect.w}, ${rect.h})`,
        },
        { transformOrigin: '0 0', transform: 'translate(0, 0) scale(1, 1)' },
      ],
      { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)' },
    );
  }

  // -- Clue -------------------------------------------------------------------

  clue(view) {
    const clue = view.clue;
    const text = clue?.text ?? '';
    const media =
      clue?.media && clue.media.kind === 'image'
        ? el('img', { class: 'clue-media', src: clue.media.url, alt: '' })
        : null;
    return el(
      'div',
      { class: 'clue-screen' },
      el('div', { class: 'signal left' }),
      el('div', { class: 'signal right' }),
      el(
        'div',
        { class: 'clue-top' },
        el('span', { class: 'clue-category category-type' }, clue?.category ?? ''),
        el(
          'span',
          { class: 'clue-value value-type' },
          clue?.tiebreak
            ? terms.tiebreak
            : clue?.wager
              ? money(clue.wagerAmount ?? 0)
              : money(clue?.value ?? 0),
        ),
      ),
      media,
      el('div', { class: 'clue-text clue-type', style: { fontSize: `${clueSize(text)}px` } }, text),
      el('div', { class: 'clue-response clue-type', hidden: true }),
      el(
        'div',
        { class: 'countdown' },
        el('div', { class: 'countdown-bar', dataset: { countdown: '' } }),
      ),
    );
  }

  updateClue(view) {
    const open = view.phase === 'open';
    for (const signal of this.screen.querySelectorAll('.signal'))
      signal.classList.toggle('lit', open);
    const response = this.screen.querySelector('.clue-response');
    if (response) {
      response.hidden = !view.clue?.response;
      response.textContent = view.clue?.response ?? '';
    }
    const bar = this.screen.querySelector('[data-countdown]');
    if (bar) {
      if (view.phase === 'open' || view.phase === 'responding') {
        if (bar.dataset.phase !== `${view.phase}:${view.seq}`) {
          bar.dataset.total = String(view.remainingMs ?? 0);
          bar.dataset.phase = `${view.phase}:${view.seq}`;
        }
      } else bar.dataset.total = '0';
    }
  }

  finalClue(view) {
    const text = view.final?.text ?? '';
    return el(
      'div',
      { class: 'clue-screen' },
      el(
        'div',
        { class: 'clue-top' },
        el('span', { class: 'clue-category category-type' }, view.final?.category ?? ''),
        el('span', { class: 'clue-value value-type' }, terms.final),
      ),
      el('div', { class: 'clue-text clue-type', style: { fontSize: `${clueSize(text)}px` } }, text),
      el(
        'div',
        { class: 'countdown' },
        el('div', { class: 'countdown-bar', dataset: { countdown: '', total: '0' } }),
      ),
    );
  }

  updateFinalClue(view) {
    const bar = this.screen.querySelector('[data-countdown]');
    if (bar && view.phase === 'final_response' && bar.dataset.phase !== 'final') {
      bar.dataset.total = String(view.remainingMs ?? 30000);
      bar.dataset.phase = 'final';
    }
  }

  finalReveal(view) {
    const current = view.final?.current;
    const entry = view.final?.revealed.find((item) => item.playerId === current);
    if (!current || !entry) {
      return el(
        'div',
        { class: 'card' },
        el('div', { class: 'card-kicker' }, terms.final),
        el('div', { class: 'card-title category-type' }, view.final?.category ?? ''),
        view.final?.response
          ? el('div', { class: 'card-sub clue-type' }, view.final.response)
          : null,
      );
    }
    return el(
      'div',
      { class: 'card final-reveal' },
      el('div', { class: 'card-kicker' }, nameOf(view, current)),
      el(
        'div',
        { class: `final-response handwriting ${entry.verdict ?? ''}` },
        entry.response || '—',
      ),
      entry.verdict
        ? el('div', { class: `verdict ${entry.verdict}` }, entry.verdict === 'correct' ? '✓' : '✗')
        : null,
      entry.wager !== null
        ? el('div', { class: 'final-wager value-type' }, money(entry.wager))
        : null,
    );
  }

  gameOver(view) {
    const winners = view.winners.map((id) => nameOf(view, id));
    const standings = [...view.players].sort((a, b) => b.score - a.score);
    return el(
      'div',
      { class: 'card game-over' },
      el(
        'div',
        { class: 'card-kicker' },
        winners.length === 0
          ? terms.noWinner
          : winners.length === 1
            ? terms.winner
            : `${terms.winner}s`,
      ),
      el('div', { class: 'card-title' }, winners.join(' & ') || '—'),
      el(
        'div',
        { class: 'standings' },
        standings.map((player) =>
          el(
            'div',
            { class: `standing${player.score < 0 ? ' negative' : ''}` },
            el('span', {}, player.name),
            el('span', { class: 'value-type' }, money(player.score)),
          ),
        ),
      ),
    );
  }

  // -- Podiums ----------------------------------------------------------------

  renderPodiums(view) {
    const players = [...view.players].sort((a, b) => a.seat - b.seat);
    const ids = players.map((player) => player.id).join(',');
    if (this.podiums.dataset.ids !== ids) {
      this.podiums.dataset.ids = ids;
      put(
        this.podiums,
        ...players.map((player) =>
          el(
            'div',
            { class: 'podium', dataset: { player: player.id } },
            el(
              'div',
              { class: 'timer-lights' },
              Array.from({ length: 9 }, () => el('span', { class: 'timer-light' })),
            ),
            el('div', { class: 'podium-score value-type' }),
            el('div', { class: 'podium-name handwriting' }),
          ),
        ),
      );
    }
    for (const podium of this.podiums.children) {
      const player = players.find((candidate) => candidate.id === podium.dataset.player);
      if (!player) continue;
      const score = podium.querySelector('.podium-score');
      score.textContent = money(player.score);
      score.classList.toggle('negative', player.score < 0);
      podium.querySelector('.podium-name').textContent = player.name;
      podium.classList.toggle(
        'responding',
        view.clue?.responder === player.id && ['responding', 'adjudicating'].includes(view.phase),
      );
      podium.classList.toggle(
        'control',
        view.control === player.id && ['board', 'round_intro'].includes(view.phase),
      );
      podium.classList.toggle('away', this.presence[player.id] === false);
      podium.classList.toggle(
        'out',
        Boolean(view.clue?.attempted?.includes(player.id)) &&
          ['open', 'responding', 'adjudicating'].includes(view.phase),
      );
      const tested = view.test?.[player.id] ?? 0;
      podium.classList.toggle('tested', view.phase === 'buzzer_test' && tested > 0);
    }
  }

  // -- Cues: animations ----------------------------------------------------------

  cue(cue, view) {
    if (cue.type === 'buzz') this.flash(cue.playerId, 'buzz');
    if (cue.type === 'test_press') this.flash(cue.playerId, 'test');
    if (cue.type === 'lockout') this.flash(cue.playerId, 'lockout');
    if (cue.type === 'board_fill') this.fillBoard();
    if (cue.type === 'category') this.introduce(view, cue.index);
  }

  fillBoard() {
    const cells = [...this.screen.querySelectorAll('.tile.cell')];
    const order = cells.map((cell) => ({ cell, at: Math.random() }));
    for (const { cell, at } of order) {
      cell.animate?.(
        [
          { opacity: 0, transform: 'scale(.6)' },
          { opacity: 1, transform: 'scale(1)' },
        ],
        { duration: 260, delay: at * 1100, fill: 'backwards', easing: 'ease-out' },
      );
    }
  }

  /** A category, full screen for a moment, then into its slot on the board. */
  introduce(view, index) {
    const category = view.board?.categories[index];
    if (!category?.title) return;
    const card = el(
      'div',
      { class: 'card intro-card' },
      el('div', { class: 'card-title category-type' }, category.title),
      category.note ? el('div', { class: 'card-note' }, category.note) : null,
    );
    put(this.overlay, card);
    card.animate?.(
      [
        { opacity: 0, transform: 'scale(1.06)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      { duration: 300, easing: 'ease-out' },
    );
    clearTimeout(this.introTimer);
    this.introTimer = setTimeout(() => {
      const fade = card.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 300 });
      if (fade) fade.onfinish = () => card.remove();
      else card.remove();
    }, 2200);
  }
}
