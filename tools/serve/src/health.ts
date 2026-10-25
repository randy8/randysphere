import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Whether this process can actually serve the site, not merely whether it
 * is running: the built front page is readable, at least one album
 * manifest parses, and an image that manifest names is on disk (so
 * generated/derivatives/ is present and matches the build). Each check is
 * a filesystem read — no network, nothing slow — so a watchdog can call
 * it every minute. Answered at /healthz.
 */
export interface Health {
  readonly ok: boolean;
  readonly checks: {
    readonly page: boolean;
    readonly manifest: boolean;
    readonly image: boolean;
  };
  /** From dist/build-info.json, written by the deploy; null for a hand-run `pnpm build`. */
  readonly release: { readonly commit: string; readonly builtAt: string } | null;
}

export interface HealthPaths {
  readonly distDir: string;
  readonly generatedAlbumsDir: string;
  readonly derivativesDir: string;
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

interface ManifestPhoto {
  readonly og?: { readonly key?: unknown };
  readonly variants?: readonly { readonly key?: unknown }[];
}

/** The key of some image the first readable manifest says exists, or null if none parses. */
async function sampleImageKey(generatedAlbumsDir: string): Promise<string | null> {
  let names: string[];
  try {
    names = (await readdir(generatedAlbumsDir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const manifest = JSON.parse(await readFile(join(generatedAlbumsDir, name), 'utf8')) as {
        photos?: readonly ManifestPhoto[];
      };
      const [photo] = manifest.photos ?? [];
      const key = photo?.variants?.[0]?.key ?? photo?.og?.key;
      if (typeof key === 'string' && key.startsWith('p/')) return key;
    } catch {
      // Unreadable or malformed: try the next one.
    }
  }
  return null;
}

async function readRelease(distDir: string): Promise<Health['release']> {
  try {
    const info = JSON.parse(await readFile(join(distDir, 'build-info.json'), 'utf8')) as {
      commit?: unknown;
      builtAt?: unknown;
    };
    return typeof info.commit === 'string' && typeof info.builtAt === 'string'
      ? { commit: info.commit, builtAt: info.builtAt }
      : null;
  } catch {
    return null;
  }
}

export async function checkHealth(paths: HealthPaths): Promise<Health> {
  const [page, key, release] = await Promise.all([
    isNonEmptyFile(join(paths.distDir, 'exposures', 'index.html')),
    sampleImageKey(paths.generatedAlbumsDir),
    readRelease(paths.distDir),
  ]);
  const image = key !== null && (await isNonEmptyFile(join(paths.derivativesDir, key)));
  const checks = { page, manifest: key !== null, image };
  return { ok: page && key !== null && image, checks, release };
}
