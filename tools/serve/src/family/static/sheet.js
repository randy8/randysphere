// A sheet over the conversation: from the bottom on a phone, from the right
// on a wide screen. Modal while open (the conversation behind is inert),
// Escape or the close button dismisses it, and focus returns to whatever
// opened it.

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Opens a sheet titled `title`, whose body `build(body, close)` fills.
 * Returns `close`. Only one sheet at a time: opening another closes the first.
 */
let current = null;

export function openSheet({ title, closeLabel, build, onClose, wide = false }) {
  current?.(true);
  const opener = document.activeElement;
  // The conversation and, beside it, the room list.
  const behind = document.querySelectorAll('[data-app], [data-rooms]');

  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  const sheet = document.createElement('section');
  sheet.className = `sheet${wide ? ' sheet-wide' : ''}`;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.tabIndex = -1;

  const head = document.createElement('header');
  head.className = 'sheet-head';
  const heading = document.createElement('h2');
  heading.textContent = title;
  heading.id = `sheet-${Math.random().toString(36).slice(2)}`;
  sheet.setAttribute('aria-labelledby', heading.id);
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'sheet-done';
  done.textContent = closeLabel;
  head.append(heading, done);

  const body = document.createElement('div');
  body.className = 'sheet-body';
  sheet.append(head, body);

  let closed = false;
  const close = (immediately = false) => {
    if (closed) return;
    closed = true;
    if (current === close) current = null;
    document.removeEventListener('keydown', onKey, true);
    for (const node of behind) node.removeAttribute('inert');
    const finish = () => {
      scrim.remove();
      sheet.remove();
    };
    if (immediately || reducedMotion.matches) finish();
    else {
      sheet.classList.add('closing');
      scrim.classList.add('closing');
      setTimeout(finish, 220);
    }
    onClose?.();
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
  };
  const onKey = (event) => {
    // A dialog stacked on the sheet (the photo viewer) handles its own Escape.
    if (event.key === 'Escape' && !document.querySelector('.viewer')) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      // Focus stays inside while it's open.
      const focusable = [
        ...sheet.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex="0"]',
        ),
      ].filter((node) => node.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  done.addEventListener('click', () => close());
  scrim.addEventListener('click', () => close());
  document.addEventListener('keydown', onKey, true);

  build(body, close);
  document.body.append(scrim, sheet);
  for (const node of behind) node.setAttribute('inert', '');
  current = close;
  sheet.focus({ preventScroll: true });
  return close;
}

/** A titled group of rows, the way the Members page lays out its settings. */
export function group(parent, title, footnote) {
  const section = document.createElement('section');
  section.className = 'group';
  if (title) {
    const heading = document.createElement('h3');
    heading.className = 'group-title';
    heading.textContent = title;
    section.append(heading);
  }
  const rows = document.createElement('div');
  rows.className = 'group-rows';
  section.append(rows);
  if (footnote) {
    const note = document.createElement('p');
    note.className = 'group-note';
    note.textContent = footnote;
    section.append(note);
  }
  parent.append(section);
  return { section, rows };
}

/** One row: a label on the left, `trailing` (text or a node) on the right. */
export function row(parent, label, trailing) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const name = document.createElement('span');
  name.textContent = label;
  cell.append(name);
  if (trailing !== undefined) {
    if (typeof trailing === 'string') {
      const value = document.createElement('span');
      value.className = 'dim';
      value.textContent = trailing;
      cell.append(value);
    } else cell.append(trailing);
  }
  parent.append(cell);
  return cell;
}

/** A switch (a checkbox styled as one), labelled by its row. */
export function toggle(parent, label, checked, onChange) {
  const cell = document.createElement('label');
  cell.className = 'cell cell-toggle';
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.className = 'switch';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked, input));
  cell.append(name, input);
  parent.append(cell);
  return input;
}

/** A row that is a button (an action, in the accent colour; `danger` in red). */
export function action(parent, label, onClick, { danger = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `cell cell-button${danger ? ' cell-danger' : ''}`;
  button.textContent = label;
  button.addEventListener('click', () => onClick(button));
  parent.append(button);
  return button;
}
