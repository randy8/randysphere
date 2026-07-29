/**
 * Run `worker` over every item with at most `limit` in flight, preserving
 * result order.
 *
 * This is a dozen lines and it is the only concurrency primitive the pipeline
 * needs, so it is written here rather than taken as a dependency. When one
 * worker throws, the others finish what they are holding and no new work is
 * started, so a failure does not leave half-written files behind it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const queue = items.map((item, index) => ({ item, index }));
  const results = new Array<R>(items.length);
  let cursor = 0;
  let stopped = false;

  async function drain(): Promise<void> {
    for (let job = queue[cursor++]; job !== undefined && !stopped; job = queue[cursor++]) {
      try {
        results[job.index] = await worker(job.item, job.index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, drain);
  await Promise.all(workers);
  return results;
}
