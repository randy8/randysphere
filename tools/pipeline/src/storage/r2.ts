import { AwsClient } from 'aws4fetch';

import { PipelineError } from '../errors.ts';
import { parseListResponse } from './s3-list.ts';
import { IMMUTABLE_CACHE_CONTROL } from './storage.ts';
import type { Storage } from './storage.ts';

export interface R2Credentials {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

async function describeFailure(response: Response, what: string): Promise<PipelineError> {
  const body = (await response.text().catch(() => '')).slice(0, 500);
  return new PipelineError(
    `${what} failed: ${response.status.toString()} ${response.statusText}. ${body}\n` +
      'Check R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, and that the token has Object Read & Write on this bucket.',
  );
}

export function createR2Storage(credentials: R2Credentials): Storage {
  const endpoint = `https://${credentials.accountId}.r2.cloudflarestorage.com/${credentials.bucket}`;
  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    service: 's3',
    region: 'auto',
  });

  return {
    description: `r2:${credentials.bucket}`,

    async list(prefix: string): Promise<Map<string, number>> {
      const found = new Map<string, number>();
      let continuationToken: string | null = null;

      do {
        const url = new URL(endpoint);
        url.searchParams.set('list-type', '2');
        url.searchParams.set('prefix', prefix);
        url.searchParams.set('max-keys', '1000');
        if (continuationToken !== null) {
          url.searchParams.set('continuation-token', continuationToken);
        }

        const response = await client.fetch(url.toString(), { method: 'GET' });
        if (!response.ok) throw await describeFailure(response, `Listing ${credentials.bucket}`);

        const page = parseListResponse(await response.text());
        for (const [key, size] of page.objects) found.set(key, size);
        continuationToken = page.continuationToken;
      } while (continuationToken !== null);

      return found;
    },

    async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
      const response = await client.fetch(`${endpoint}/${key}`, {
        method: 'PUT',
        body,
        headers: { 'Content-Type': contentType, 'Cache-Control': IMMUTABLE_CACHE_CONTROL },
      });
      if (!response.ok) throw await describeFailure(response, `Uploading ${key}`);
      // Drain so the connection can be reused for the next of several thousand.
      await response.arrayBuffer();
    },
  };
}

export function readCredentialsFromEnvironment(bucket: string): R2Credentials {
  const accountId = process.env['R2_ACCOUNT_ID'];
  const accessKeyId = process.env['R2_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];

  const missing = [
    accountId === undefined ? 'R2_ACCOUNT_ID' : null,
    accessKeyId === undefined ? 'R2_ACCESS_KEY_ID' : null,
    secretAccessKey === undefined ? 'R2_SECRET_ACCESS_KEY' : null,
  ].filter((name): name is string => name !== null);

  if (accountId === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new PipelineError(
      `Missing ${missing.join(', ')}.\n` +
        'Put them in a .env file at the repository root (it is git-ignored), or pass --local to publish into ' +
        'a directory instead of a bucket.',
    );
  }
  return { accountId, bucket, accessKeyId, secretAccessKey };
}
