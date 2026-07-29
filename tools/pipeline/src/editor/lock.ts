/**
 * Serializes writes to the same album directory within this process.
 *
 * `applyPhotoEdits` does an `await readFile` before its `await
 * writeFileAtomic`, and Node's event loop can service a second HTTP request
 * in between those two awaits. Two overlapping `POST /api/edits` requests
 * for the *same* album (two browser tabs, or a slow request racing a fast
 * one) could otherwise interleave and lose one side's edit. This only
 * protects against that — a single server process, a single local user. It
 * is not a cross-process lock and never needs to be: the editor is loopback-
 * only, single-machine, single-user by design (see docs/decisions.md).
 */
const queues = new Map<string, Promise<unknown>>();

export function withAlbumLock<T>(albumDirectory: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = queues.get(albumDirectory) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Swallow rejections in the queue chain itself (not in what callers receive)
  // so one failed edit doesn't wedge every later request for this album.
  queues.set(
    albumDirectory,
    next.catch(() => undefined),
  );
  return next;
}
