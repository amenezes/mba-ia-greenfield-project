import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Generates a small H.264/AAC MP4 with ffmpeg's lavfi test sources. */
export async function generateTestVideo(
  options: { durationSeconds?: number; width?: number; height?: number } = {},
): Promise<Buffer> {
  const { durationSeconds = 3, width = 320, height = 240 } = options;
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-media-'));
  const file = join(dir, 'video.mp4');
  try {
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=25`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${durationSeconds}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      '+faststart',
      file,
    ]);
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
