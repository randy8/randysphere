import { join, resolve } from 'node:path';

export interface Paths {
  readonly root: string;
  readonly originals: string;
  readonly albums: string;
  readonly generated: string;
  readonly manifests: string;
  readonly derivatives: string;
  readonly indexFile: string;
  readonly publishedFile: string;
  readonly configFile: string;
  /** Cache of generated descriptions, keyed by sourceId. Git-ignored; rebuildable, at the cost of calling the provider again. */
  readonly descriptionsFile: string;
}

export function resolvePaths(root: string): Paths {
  const generated = join(root, 'generated');
  return {
    root,
    originals: join(root, 'originals'),
    albums: join(root, 'albums'),
    generated,
    manifests: join(generated, 'albums'),
    derivatives: join(generated, 'derivatives'),
    indexFile: join(generated, 'index.json'),
    publishedFile: join(generated, 'published.json'),
    configFile: join(root, 'pipeline.config.ts'),
    descriptionsFile: join(generated, 'descriptions.json'),
  };
}

/**
 * Derived from this file's own location rather than the working directory, so
 * that `pnpm ingest` behaves identically whether it is run from the repository
 * root, from inside site/, or from an editor's task runner.
 *
 * src -> pipeline -> tools -> repository root.
 */
export function repositoryRoot(): string {
  return resolve(import.meta.dirname, '..', '..', '..');
}

/** Where a derivative key lives in the local cache. Mirrors the object key exactly. */
export function derivativePath(paths: Paths, key: string): string {
  return join(paths.derivatives, ...key.split('/'));
}
