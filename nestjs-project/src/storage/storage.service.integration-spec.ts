import { randomBytes, randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { InvalidUploadPartsException } from '../common/exceptions/domain.exception';
import {
  createTestS3Client,
  emptyAndDeleteBucket,
  putToPresignedUrl,
  useInternalEndpointForPresignedUrls,
} from '../test/storage';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const FIVE_MIB = 5 * 1024 * 1024;

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('StorageService (integration)', () => {
  const bucket = `streamtube-test-${randomUUID().slice(0, 8)}`;
  let module: TestingModule;
  let storage: StorageService;
  let s3: S3Client;

  beforeAll(async () => {
    useInternalEndpointForPresignedUrls();
    process.env.S3_BUCKET = bucket;
    s3 = createTestS3Client();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await module.init();
    storage = module.get(StorageService);
  }, 30000);

  afterAll(async () => {
    await emptyAndDeleteBucket(s3, bucket);
    await module.close();
    s3.destroy();
  });

  it('creates the bucket on bootstrap and tolerates a second bootstrap', async () => {
    await expect(
      s3.send(new HeadBucketCommand({ Bucket: bucket })),
    ).resolves.toBeDefined();
    await expect(storage.ensureBucket()).resolves.toBeUndefined();
  });

  it('completes a two-part upload sent to presigned URLs', async () => {
    const key = `videos/${randomUUID()}/original`;
    const part1 = randomBytes(FIVE_MIB);
    const part2 = randomBytes(1024);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const { parts } = await storage.presignUploadParts(key, uploadId, [1, 2]);

    const etag1 = await putToPresignedUrl(parts[0].url, part1);
    const etag2 = await putToPresignedUrl(parts[1].url, part2);
    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 2, etag: etag2 },
      { partNumber: 1, etag: etag1 },
    ]);

    const info = await storage.headObject(key);
    expect(info.size).toBe(part1.length + part2.length);
    expect(info.contentType).toBe('video/mp4');
  }, 30000);

  it('maps an invalid ETag on completion to INVALID_UPLOAD_PARTS', async () => {
    const key = `videos/${randomUUID()}/original`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const { parts } = await storage.presignUploadParts(key, uploadId, [1]);
    await putToPresignedUrl(parts[0].url, randomBytes(1024));

    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"00000000000000000000000000000000"' },
      ]),
    ).rejects.toBeInstanceOf(InvalidUploadPartsException);

    await storage.abortMultipartUpload(key, uploadId);
  }, 30000);

  it('reads a byte range of a stored object', async () => {
    const key = `videos/${randomUUID()}/original`;
    const content = randomBytes(4096);
    await storage.putObject(key, content, 'video/mp4');

    const result = await storage.getObjectStream(key, 'bytes=0-9');
    const bytes = await readAll(result.body);

    expect(bytes.equals(content.subarray(0, 10))).toBe(true);
    expect(result.contentLength).toBe(10);
    expect(result.contentRange).toBe(`bytes 0-9/${content.length}`);
  });

  it('deletes an object', async () => {
    const key = `videos/${randomUUID()}/thumbnail.jpg`;
    await storage.putObject(key, randomBytes(16), 'image/jpeg');

    await storage.deleteObject(key);

    await expect(storage.headObject(key)).rejects.toMatchObject({
      $metadata: { httpStatusCode: 404 },
    });
  });

  it('serves an object through the internal presigned GET URL', async () => {
    const key = `videos/${randomUUID()}/original`;
    const content = randomBytes(256);
    await storage.putObject(key, content, 'video/mp4');

    const url = await storage.presignInternalGetUrl(key);
    const response = await fetch(url);

    expect(new URL(url).host).toBe(new URL(process.env.S3_ENDPOINT!).host);
    expect(Buffer.from(await response.arrayBuffer()).equals(content)).toBe(
      true,
    );
  });
});
