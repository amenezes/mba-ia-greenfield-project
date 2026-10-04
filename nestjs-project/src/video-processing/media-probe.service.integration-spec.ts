import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateTestVideo } from '../test/media';
import { InvalidMediaError } from './media-probe.errors';
import { MediaProbeService } from './media-probe.service';

function jpegWidth(jpeg: Buffer): number {
  // Walk JPEG segments until a SOFn marker, which carries height/width.
  let offset = 2;
  while (offset < jpeg.length) {
    const marker = jpeg[offset + 1];
    const length = jpeg.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return jpeg.readUInt16BE(offset + 7);
    offset += 2 + length;
  }
  throw new Error('No SOF marker found');
}

describe('MediaProbeService (integration)', () => {
  const service = new MediaProbeService();
  let dir: string;
  let videoPath: string;
  let widePath: string;
  let garbagePath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-probe-'));
    videoPath = join(dir, 'clip.mp4');
    widePath = join(dir, 'wide.mp4');
    garbagePath = join(dir, 'garbage.mp4');
    await writeFile(videoPath, await generateTestVideo());
    await writeFile(
      widePath,
      await generateTestVideo({
        durationSeconds: 1,
        width: 1920,
        height: 1080,
      }),
    );
    await writeFile(garbagePath, randomBytes(64 * 1024));
  }, 60000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts duration, dimensions and codecs from a real video', async () => {
    const result = await service.probe(videoPath);

    expect(result.durationSeconds).toBeCloseTo(3, 0);
    expect(result.metadata).toMatchObject({
      width: 320,
      height: 240,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
  });

  it('rejects a file that is not a video without leaking the input', async () => {
    const error = await service.probe(garbagePath).catch((e: Error) => e);

    expect(error).toBeInstanceOf(InvalidMediaError);
    expect((error as Error).message).not.toContain(garbagePath);
    expect((error as Error).message).toContain('<input>');
  });

  it('extracts a JPEG frame', async () => {
    const jpeg = await service.extractThumbnail(videoPath, 0.3);

    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpegWidth(jpeg)).toBe(320);
  });

  it('caps the thumbnail width at 1280px', async () => {
    const jpeg = await service.extractThumbnail(widePath, 0);

    expect(jpegWidth(jpeg)).toBe(1280);
  });
});
