import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseListResponse } from './s3-list.ts';

const page = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>photographs</Name>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1/abc+def=</NextContinuationToken>
  <Contents>
    <Key>p/0123456789abcdef/400-1a2b3c4d.avif</Key>
    <LastModified>2026-07-01T00:00:00.000Z</LastModified>
    <Size>9812</Size>
  </Contents>
  <Contents>
    <Key>p/0123456789abcdef/og-4d5e6f70.jpg</Key>
    <Size>96122</Size>
  </Contents>
</ListBucketResult>`;

test('keys and sizes are read, and the continuation token is returned', () => {
  const result = parseListResponse(page);
  assert.equal(result.objects.size, 2);
  assert.equal(result.objects.get('p/0123456789abcdef/400-1a2b3c4d.avif'), 9812);
  assert.equal(result.objects.get('p/0123456789abcdef/og-4d5e6f70.jpg'), 96_122);
  assert.equal(result.continuationToken, '1/abc+def=');
});

test('a final page reports no continuation token', () => {
  const result = parseListResponse(page.replace('<IsTruncated>true', '<IsTruncated>false'));
  assert.equal(result.continuationToken, null);
});

test('objects that are not ours are ignored rather than trusted', () => {
  // A shared bucket, or anything left by another tool. Including these in the
  // diff would make publish believe derivatives exist that do not.
  const foreign = `<ListBucketResult><IsTruncated>false</IsTruncated>
    <Contents><Key>backups/2024.tar.gz</Key><Size>1</Size></Contents>
    <Contents><Key>p/0123456789abcdef/../../etc/passwd</Key><Size>2</Size></Contents>
    <Contents><Key>p/NOTHEX0123456789/400-1a2b3c4d.avif</Key><Size>3</Size></Contents>
  </ListBucketResult>`;
  assert.equal(parseListResponse(foreign).objects.size, 0);
});

test('an empty bucket parses to nothing', () => {
  const empty = '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>';
  assert.deepEqual([...parseListResponse(empty).objects], []);
  assert.equal(parseListResponse(empty).continuationToken, null);
});
