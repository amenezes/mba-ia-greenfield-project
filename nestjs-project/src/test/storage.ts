import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * Presigned URLs are signed for S3_PUBLIC_ENDPOINT, which points to the host
 * machine (e.g. http://localhost:9000). Tests run inside the nestjs-api
 * container, where only the Compose service name resolves — so tests sign
 * URLs for the internal endpoint instead. Must run before the config loads.
 */
export function useInternalEndpointForPresignedUrls(): void {
  process.env.S3_PUBLIC_ENDPOINT =
    process.env.S3_ENDPOINT ?? 'http://minio:9000';
}

export function createTestS3Client(): S3Client {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? '',
      secretAccessKey: process.env.S3_SECRET_KEY ?? '',
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export async function emptyAndDeleteBucket(
  client: S3Client,
  bucket: string,
): Promise<void> {
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: bucket }),
  );
  const objects = (listed.Contents ?? []).map((o) => ({ Key: o.Key }));
  if (objects.length > 0) {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects },
      }),
    );
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}

/** PUTs a part body to a presigned UploadPart URL and returns its ETag. */
export async function putToPresignedUrl(
  url: string,
  body: Buffer,
): Promise<string> {
  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
  });
  const etag = response.headers.get('etag');
  if (response.status !== 200 || !etag) {
    throw new Error(
      `Presigned PUT failed: ${response.status} ${await response.text()}`,
    );
  }
  return etag;
}
