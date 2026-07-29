import { isDerivativeKey } from '../recipe.ts';

export interface ListPage {
  readonly objects: Map<string, number>;
  readonly continuationToken: string | null;
}

/**
 * Reads keys and sizes out of an S3 ListObjectsV2 response.
 *
 * This is a targeted read of three element names rather than a general XML
 * parser, and it is only safe because of a constraint enforced elsewhere: every
 * key the pipeline writes matches KEY_PATTERN, whose alphabet is hexadecimal
 * digits, decimal digits, hyphens, dots and slashes. None of those are escaped
 * in XML, so no key of ours can arrive encoded.
 *
 * Anything that does not match the pattern is ignored rather than trusted,
 * which also keeps unrelated objects in a shared bucket out of the diff.
 */
export function parseListResponse(xml: string): ListPage {
  const objects = new Map<string, number>();

  for (const [, block = ''] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([^<]*)<\/Key>/.exec(block)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(block)?.[1];
    if (key !== undefined && size !== undefined && isDerivativeKey(key)) {
      objects.set(key, Number.parseInt(size, 10));
    }
  }

  const truncated = /<IsTruncated>([^<]*)<\/IsTruncated>/.exec(xml)?.[1] === 'true';
  const token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { objects, continuationToken: truncated && token !== undefined ? token : null };
}
