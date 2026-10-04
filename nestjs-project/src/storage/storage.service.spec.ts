import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

const config = {
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://storage.example.com:9000',
  region: 'us-east-1',
  accessKey: 'access',
  secretKey: 'secret',
  bucket: 'streamtube',
  presignedUrlExpirationSeconds: 600,
} as ReturnType<typeof storageConfig>;

function client(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: 'access', secretAccessKey: 'secret' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
}

describe('StorageService (presigning)', () => {
  const service = new StorageService(
    client(config.endpoint),
    client(config.publicEndpoint),
    config,
  );

  it('signs upload part URLs for the public endpoint', async () => {
    const { parts, expiresAt } = await service.presignUploadParts(
      'videos/abc/original',
      'upload-1',
      [1, 2],
    );

    expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);
    for (const part of parts) {
      const url = new URL(part.url);
      expect(url.host).toBe('storage.example.com:9000');
      expect(url.pathname).toBe('/streamtube/videos/abc/original');
      expect(url.searchParams.get('uploadId')).toBe('upload-1');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
      expect(url.searchParams.has('x-amz-sdk-checksum-algorithm')).toBe(false);
    }
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 590_000);
  });

  it('signs the internal GET URL for the internal endpoint', async () => {
    const url = new URL(
      await service.presignInternalGetUrl('videos/abc/original'),
    );

    expect(url.host).toBe('minio:9000');
    expect(url.pathname).toBe('/streamtube/videos/abc/original');
  });
});
