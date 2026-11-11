// SPDX-License-Identifier: Apache-2.0
// S3-compatible store (ADR-0015). Path-style, no retries, checksums only when
// the operation requires them. A missing key is null. Other failures throw a
// message that does not include the store's response.
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { MAX_OBJECT_BYTES } from './gateway.ts';
import type { ObjectStore } from './store.ts';

export interface S3StoreConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]+$/;

function rejected(what: string): Error {
  return new Error(`object store ${what} was rejected`);
}

function assertS3StoreConfig(config: S3StoreConfig): void {
  let url: URL;
  try {
    url = new URL(config.endpoint);
  } catch {
    throw rejected('endpoint');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw rejected('endpoint');
  if (url.username !== '' || url.password !== '') throw rejected('endpoint');
  if (typeof config.bucket !== 'string' || !BUCKET.test(config.bucket)) throw rejected('bucket');
  if (typeof config.region !== 'string' || !REGION.test(config.region)) throw rejected('region');
  if (typeof config.accessKeyId !== 'string' || config.accessKeyId.length === 0) throw rejected('credentials');
  if (typeof config.secretAccessKey !== 'string' || config.secretAccessKey.length === 0) {
    throw rejected('credentials');
  }
}

export function createS3Client(config: S3StoreConfig): S3Client {
  assertS3StoreConfig(config);
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/** Only a missing key. A missing bucket is also HTTP 404 and stays a store failure. */
function isMissing(error: unknown): boolean {
  return error instanceof NoSuchKey || (error instanceof Error && error.name === 'NoSuchKey');
}

function destroyStream(body: object): void {
  const destroy = (body as { destroy?: () => void }).destroy;
  if (typeof destroy !== 'function') return;
  try {
    destroy.call(body);
  } catch {
    // The caller is already failing the read.
  }
}

/**
 * Read at most `limit` bytes. A declared length over the limit, or a body that
 * grows past it, fails before the rest is buffered.
 */
export async function readLimited(
  body: object,
  contentLength: number | undefined,
  limit: number,
): Promise<Uint8Array> {
  if (
    contentLength !== undefined
    && (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > limit)
  ) {
    destroyStream(body);
    throw failed();
  }
  if (!(Symbol.asyncIterator in body)) throw failed();
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<unknown>) {
    if (!(chunk instanceof Uint8Array)) {
      destroyStream(body);
      throw failed();
    }
    if (total + chunk.byteLength > limit) {
      destroyStream(body);
      throw failed();
    }
    parts.push(chunk);
    total += chunk.byteLength;
  }
  if (contentLength !== undefined && total !== contentLength) throw failed();
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function failed(): Error {
  return new Error('object store request failed');
}

export function createS3ObjectStore(config: S3StoreConfig): ObjectStore {
  const client = createS3Client(config);
  const bucket = config.bucket;
  return {
    async put(key, body) {
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: body.byteLength,
        }));
      } catch {
        throw failed();
      }
    },
    async get(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = response.Body;
        if (!body) {
          if (response.ContentLength === undefined || response.ContentLength === 0) return new Uint8Array();
          throw failed();
        }
        return await readLimited(body, response.ContentLength, MAX_OBJECT_BYTES);
      } catch (error) {
        if (isMissing(error)) return null;
        throw failed();
      }
    },
    close() {
      client.destroy();
    },
  };
}
