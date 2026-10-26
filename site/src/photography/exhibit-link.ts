/**
 * Reveals a page's Exhibition link. Server-rendered `hidden`, like
 * Selected Work's toolbar: the exhibition needs JavaScript, so a visitor
 * without it never sees a link to a page that can't play.
 */

const bar = document.querySelector<HTMLElement>('[data-exhibit-bar]');
if (bar !== null) bar.hidden = false;
