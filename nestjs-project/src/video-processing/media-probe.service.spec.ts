import { InvalidMediaError } from './media-probe.errors';
import { parseProbeOutput, thumbnailOffset } from './media-probe.service';

describe('MediaProbeService helpers', () => {
  describe('thumbnailOffset', () => {
    it.each([
      [120, 5],
      [20, 2],
      [0.5, 0],
    ])('for a %ss video returns %ss', (duration, expected) => {
      expect(thumbnailOffset(duration)).toBeCloseTo(expected);
    });
  });

  describe('parseProbeOutput', () => {
    const videoStream = {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
    };

    it('maps format and first video/audio streams to metadata', () => {
      const result = parseProbeOutput(
        JSON.stringify({
          streams: [videoStream, { codec_type: 'audio', codec_name: 'aac' }],
          format: {
            duration: '12.500000',
            bit_rate: '1048576',
            format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          },
        }),
      );

      expect(result).toEqual({
        durationSeconds: 12.5,
        metadata: {
          formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
          bitRate: 1048576,
          width: 1920,
          height: 1080,
          videoCodec: 'h264',
          audioCodec: 'aac',
        },
      });
    });

    it('accepts a video without an audio stream', () => {
      const result = parseProbeOutput(
        JSON.stringify({ streams: [videoStream], format: { duration: '3' } }),
      );

      expect(result.metadata.audioCodec).toBeNull();
      expect(result.metadata.bitRate).toBeNull();
    });

    it('rejects input without a video stream', () => {
      expect(() =>
        parseProbeOutput(
          JSON.stringify({
            streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
            format: { duration: '3' },
          }),
        ),
      ).toThrow(InvalidMediaError);
    });

    it('rejects input without a numeric duration', () => {
      expect(() =>
        parseProbeOutput(
          JSON.stringify({
            streams: [videoStream],
            format: { duration: 'N/A' },
          }),
        ),
      ).toThrow(InvalidMediaError);
    });
  });
});
