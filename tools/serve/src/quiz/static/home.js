import { el, loadTheme, terms } from './lib.js';

const app = document.getElementById('app');
await loadTheme('classic');
app.append(
  el(
    'div',
    { class: 'doc home' },
    el('h1', { class: 'home-title category-type' }, terms.game),
    el(
      'p',
      { class: 'lede' },
      'A television-style quiz for a living room: one host, up to three contestants on their phones, and the board on the TV.',
    ),
    el(
      'nav',
      { class: 'home-actions' },
      el(
        'a',
        { class: 'tile-link', href: '/trivia/host/' },
        el('strong', {}, 'Host a game'),
        el('span', {}, 'Choose a game, get a code, put it on the TV'),
      ),
      el(
        'a',
        { class: 'tile-link', href: '/trivia/join/' },
        el('strong', {}, 'Join a game'),
        el('span', {}, 'Enter the code on the screen'),
      ),
      el(
        'a',
        { class: 'tile-link', href: '/trivia/solo/' },
        el('strong', {}, 'Single player'),
        el('span', {}, 'The computer hosts; type your responses'),
      ),
      el(
        'a',
        { class: 'tile-link', href: '/trivia/practice/' },
        el('strong', {}, 'Practice'),
        el('span', {}, 'One clue at a time'),
      ),
      el(
        'a',
        { class: 'tile-link', href: '/trivia/edit/' },
        el('strong', {}, 'Write a game'),
        el('span', {}, 'Your own categories and clues'),
      ),
    ),
    el(
      'p',
      { class: 'fine' },
      'An unofficial, independent fan project. Not affiliated with, endorsed by or connected to any television program or its owners. Clues in the built-in library are original.',
    ),
  ),
);
