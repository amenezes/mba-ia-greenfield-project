import { execFile } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import type { VideoMetadata } from '../videos/entities/video.entity';
import { InvalidMediaError } from './media-probe.errors';

const PROBE_TIMEOUT_MS = 2 * 60 * 1000;
const THUMBNAIL_TIMEOUT_MS = 2 * 60 * 1000;
const PROBE_MAX_BUFFER = 10 * 1024 * 1024;
const THUMBNAIL_MAX_BUFFER = 20 * 1024 * 1024;
const THUMBNAIL_MAX_WIDTH = 1280;
const THUMBNAIL_MAX_OFFSET_SECONDS = 5;
const INVALID_DATA_MARKERS = [
  'Invalid data found when processing input',
  'moov atom not found',
];

export interface ProbeResult {
  durationSeconds: number;
  metadata: VideoMetadata;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string; format_name?: string };
}

function toNumberOrNull(value: string | number | undefined): number | null {
  const n = Number(value);
  return value === undefined || Number.isNaN(n) ? null : n;
}

/** Maps ffprobe's JSON output to the domain metadata shape. */
export function parseProbeOutput(json: string): ProbeResult {
  const output = JSON.parse(json) as FfprobeOutput;
  const streams = output.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new InvalidMediaError('No video stream found');

  const durationSeconds = Number(output.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new InvalidMediaError('Video duration could not be determined');
  }

  return {
    durationSeconds,
    metadata: {
      formatName: output.format?.format_name ?? null,
      bitRate: toNumberOrNull(output.format?.bit_rate),
      width: video.width ?? null,
      height: video.height ?? null,
      videoCodec: video.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
    },
  };
}

/** Frame offset for the thumbnail: 10% of the duration, capped at 5s (0 under 1s). */
export function thumbnailOffset(durationSeconds: number): number {
  if (durationSeconds < 1) return 0;
  return Math.min(durationSeconds * 0.1, THUMBNAIL_MAX_OFFSET_SECONDS);
}

function run(
  command: string,
  args: string[],
  input: string,
  timeout: number,
  maxBuffer: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'buffer', timeout, maxBuffer },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        // The input may be a presigned URL: never leak its signature into
        // logs or the persisted processing_error.
        const details = (stderr.toString().trim() || error.message)
          .split(input)
          .join('<input>');
        if (INVALID_DATA_MARKERS.some((m) => details.includes(m))) {
          return reject(new InvalidMediaError(details));
        }
        reject(new Error(`${command} failed: ${details}`));
      },
    );
  });
}

@Injectable()
export class MediaProbeService {
  /** Extracts duration and metadata; `input` may be a URL or a local path. */
  async probe(input: string): Promise<ProbeResult> {
    const stdout = await run(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        input,
      ],
      input,
      PROBE_TIMEOUT_MS,
      PROBE_MAX_BUFFER,
    );
    return parseProbeOutput(stdout.toString());
  }

  /** Renders one JPEG frame at `offsetSeconds` (width capped at 1280px). */
  async extractThumbnail(
    input: string,
    offsetSeconds: number,
  ): Promise<Buffer> {
    const jpeg = await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        offsetSeconds.toFixed(3),
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      input,
      THUMBNAIL_TIMEOUT_MS,
      THUMBNAIL_MAX_BUFFER,
    );
    if (jpeg.length === 0) {
      throw new InvalidMediaError(
        'No frame could be extracted for the thumbnail',
      );
    }
    return jpeg;
  }

  thumbnailOffset(durationSeconds: number): number {
    return thumbnailOffset(durationSeconds);
  }
}
