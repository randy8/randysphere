// pnpm family <command> — the chat's accounts and backups, from a terminal
// on the server; pnpm disc <command> the same for Disc (--chat=disc), whose
// accounts are its own. The Members page (/<chat>/admin) does the same account
// work from a phone; this is how the first account (yours) gets made, and
// how backups are taken and restored. See docs/family.md.

import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CHATS } from './chats.ts';
import { openDatabase, SCHEMA_VERSION } from './db.ts';
import { FamilyError, FamilyStore } from './store.ts';

function repositoryRoot(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not find the repository root above ${process.cwd()}.`);
}

const ROOT = repositoryRoot();
const CHAT_ARG = '--chat=';
const slug = process.argv.find((arg) => arg.startsWith(CHAT_ARG))?.slice(CHAT_ARG.length);
const found = CHATS.find((chat) => chat.slug === (slug ?? 'family'));
if (!found) throw new Error(`No chat named “${slug ?? ''}”.`);
const CHAT = found;
const DATA = join(ROOT, 'private', CHAT.slug);
const BACKUPS = join(ROOT, 'private', `${CHAT.slug}-backups`);

const USAGE = `pnpm ${CHAT.slug} <command>

  list                                   everyone, and when they were last seen
  add <username> --name=<display name>   a new account; asks for its password
      [--lang=zh|en] [--admin]
      [--suggest-change]                 a starter password (any length): offered
                                         the chance to choose their own on sign-in
      [--same-password-as=<chat>]        the password they have in another chat
  passwd <username>                      set a new password (signs them out everywhere)
  rename <username> <display name>
  disable <username> | enable <username>
  revoke <username>                      sign them out on every device
  backup [<directory>]                   a consistent copy, safe while the server runs
                                         (default: private/${CHAT.slug}-backups/<time>/)
  restore <directory>                    replace the chat with a backup; stop the server first`;

function option(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function positional(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith('--'));
}

/** A password typed without echo (or one line of stdin when piped). */
async function askPassword(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    let text = '';
    for await (const chunk of stdin) text += String(chunk);
    return text.split('\n')[0] ?? '';
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((done, fail) => {
    let value = '';
    const onData = (key: string): void => {
      for (const char of key) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          done(value);
          return;
        }
        if (char === '\u0003') {
          stdin.setRawMode(false);
          fail(new Error('Cancelled.'));
          return;
        }
        if (char === '\u007f') value = [...value].slice(0, -1).join('');
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function newPassword(): Promise<string> {
  const first = await askPassword('Password: ');
  if (!process.stdin.isTTY) return first;
  const second = await askPassword('Again: ');
  if (first !== second) throw new FamilyError('Those didn’t match.');
  return first;
}

function ago(at: number | null): string {
  if (at === null) return 'never';
  const hours = (Date.now() - at) / 3_600_000;
  if (hours < 1) return `${String(Math.round(hours * 60))} min ago`;
  if (hours < 48) return `${String(Math.round(hours))} h ago`;
  return `${String(Math.round(hours / 24))} days ago`;
}

function userOrFail(
  store: FamilyStore,
  username: string | undefined,
): ReturnType<FamilyStore['requireUser']> {
  const user = username ? store.findUserByUsername(username) : null;
  if (!user)
    throw new FamilyError(`No account named “${username ?? ''}”. Try: pnpm ${CHAT.slug} list`);
  return user;
}

async function serverIsRunning(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:4322/healthz', {
      signal: AbortSignal.timeout(1500),
    });
    return response.status > 0;
  } catch {
    return false;
  }
}

function backup(store: FamilyStore, target: string): void {
  mkdirSync(target, { recursive: true });
  const file = join(target, 'chat.db');
  if (existsSync(file)) throw new FamilyError(`${file} already exists.`);
  // VACUUM INTO: a consistent snapshot even with the server writing.
  store.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const images = join(DATA, 'images');
  if (existsSync(images)) cpSync(images, join(target, 'images'), { recursive: true });
  // The notification key: without it, every device's subscription would
  // stop working after a restore.
  const vapid = join(DATA, 'vapid.json');
  if (existsSync(vapid)) cpSync(vapid, join(target, 'vapid.json'));
  const stats = store.stats();
  writeFileSync(
    join(target, 'backup.json'),
    `${JSON.stringify({ createdAt: new Date().toISOString(), schema: SCHEMA_VERSION, ...stats }, null, 2)}\n`,
  );
  console.log(
    `Backed up ${String(stats.messages)} messages and ${String(stats.images)} photos to ${target}`,
  );
}

async function restore(source: string): Promise<void> {
  const file = join(source, 'chat.db');
  if (!existsSync(file)) throw new FamilyError(`${file} doesn't exist.`);
  if (await serverIsRunning()) {
    throw new FamilyError(
      'The server is running. Stop it first:  sudo systemctl stop photography-serve',
    );
  }
  const check = new DatabaseSync(file, { readOnly: true });
  const result = check.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  check.close();
  if (result.integrity_check !== 'ok')
    throw new FamilyError(`The backup is damaged: ${result.integrity_check}`);

  // Nothing is deleted: what's there now is set aside first.
  const aside = join(
    ROOT,
    'private',
    `${CHAT.slug}-replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  if (existsSync(DATA)) renameSync(DATA, aside);
  mkdirSync(DATA, { recursive: true });
  cpSync(file, join(DATA, 'chat.db'));
  const images = join(source, 'images');
  if (existsSync(images)) cpSync(images, join(DATA, 'images'), { recursive: true });
  for (const kept of ['vapid.json']) {
    // From the backup if it has one, else the one being replaced.
    const from = existsSync(join(source, kept)) ? join(source, kept) : join(aside, kept);
    if (existsSync(from)) cpSync(from, join(DATA, kept));
  }
  // Opening runs any migrations the backup is behind on. A new epoch tells
  // every open page that its revs belong to the replaced database.
  const restored = new FamilyStore(openDatabase(join(DATA, 'chat.db')));
  restored.renewEpoch();
  restored.db.close();
  rmSync(join(DATA, 'chat.db-shm'), { force: true });
  console.log(`Restored from ${source}. The previous chat is kept at ${aside}.`);
  console.log('Start the server again:  sudo systemctl start photography-serve');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2).filter((arg) => !arg.startsWith(CHAT_ARG));
  if (command === 'restore') {
    const [directory] = positional(args);
    if (!directory) throw new FamilyError(USAGE);
    await restore(resolve(directory));
    return;
  }

  const store = new FamilyStore(openDatabase(join(DATA, 'chat.db')));
  const [first, ...rest] = positional(args);

  switch (command) {
    case 'list': {
      const users = store.members();
      if (users.length === 0)
        console.log(
          `No accounts yet. Start with: pnpm ${CHAT.slug} add <you> --name=<your name> --admin`,
        );
      for (const user of users) {
        const flags = [
          user.isAdmin ? 'admin' : '',
          user.disabledAt === null ? '' : 'DISABLED',
          user.lang,
        ]
          .filter(Boolean)
          .join(', ');
        console.log(
          `${user.username.padEnd(16)} ${user.displayName.padEnd(14)} ${flags.padEnd(18)} last seen ${ago(user.lastSeenAt)}, ${String(store.sessions(user.id).length)} device(s)`,
        );
      }
      return;
    }
    case 'add': {
      const name = option(args, 'name');
      if (!first || !name) throw new FamilyError(USAGE);
      // --same-password-as=<chat>: the password this username already has
      // there, copied as its hash (never seen or typed again).
      const from = option(args, 'same-password-as');
      let passwordHash: string | undefined;
      if (from !== undefined) {
        if (!CHATS.some((chat) => chat.slug === from))
          throw new FamilyError(`No chat named “${from}”.`);
        const other = new FamilyStore(openDatabase(join(ROOT, 'private', from, 'chat.db')));
        passwordHash = other.passwordHash(first) ?? undefined;
        other.db.close();
        if (!passwordHash) throw new FamilyError(`No account named “${first}” in ${from}.`);
      }
      const user = await store.createUser({
        username: first,
        displayName: name,
        password: passwordHash === undefined ? await newPassword() : '',
        ...(passwordHash === undefined ? {} : { passwordHash }),
        suggestNewPassword: args.includes('--suggest-change'),
        lang: option(args, 'lang') === 'zh' ? 'zh' : 'en',
        isAdmin: args.includes('--admin'),
      });
      console.log(
        `Added ${user.displayName} (${user.username}). They sign in at https://randyliang.net/${CHAT.slug}/`,
      );
      return;
    }
    case 'passwd': {
      const user = userOrFail(store, first);
      await store.setPassword(user.id, await newPassword());
      console.log(`New password set for ${user.displayName}; their devices are signed out.`);
      return;
    }
    case 'rename': {
      const user = userOrFail(store, first);
      const renamed = store.rename(user.id, rest.join(' '));
      console.log(
        `${user.username} is now “${renamed.displayName}” (shown after their next reload).`,
      );
      return;
    }
    case 'disable':
    case 'enable': {
      const user = userOrFail(store, first);
      store.setDisabled(user.id, command === 'disable');
      console.log(
        `${user.displayName} is ${command === 'disable' ? 'disabled and signed out' : 'enabled'}.`,
      );
      return;
    }
    case 'revoke': {
      const user = userOrFail(store, first);
      store.revokeSessions(user.id);
      console.log(`${user.displayName} is signed out everywhere (open pages notice within 20 s).`);
      return;
    }
    case 'backup': {
      backup(
        store,
        first ? resolve(first) : join(BACKUPS, new Date().toISOString().replace(/[:.]/g, '-')),
      );
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = command === undefined || command === 'help' ? 0 : 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
