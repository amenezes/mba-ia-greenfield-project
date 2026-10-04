import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidUploadPartsException,
  InvalidVideoStatusException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingQueue } from '../video-processing/video-processing-queue.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './videos.constants';
import { VideosService } from './videos.service';

const USER_ID = 'user-1';
const CHANNEL = { id: 'channel-1', user_id: USER_ID };

function uniqueSlugViolation(): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error('duplicate'));
  Object.assign(err, {
    code: '23505',
    detail: 'Key (slug)=(abc) already exists.',
  });
  return err;
}

function draftVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    channel_id: CHANNEL.id,
    slug: 'abcdefghijk',
    title: 'aula',
    status: VideoStatus.DRAFT,
    original_file_name: 'aula.mp4',
    content_type: 'video/mp4',
    size_bytes: String(250 * 1024 * 1024),
    storage_key: 'videos/video-1/original',
    upload_id: 'upload-1',
    ...overrides,
  } as Video;
}

describe('VideosService', () => {
  let service: VideosService;
  let repository: Record<
    'save' | 'create' | 'findOne' | 'update' | 'delete',
    jest.Mock
  >;
  let queue: Record<'enqueue', jest.Mock>;
  let channelsService: jest.Mocked<Pick<ChannelsService, 'findByUserId'>>;
  let storage: Record<
    | 'createMultipartUpload'
    | 'presignUploadParts'
    | 'abortMultipartUpload'
    | 'completeMultipartUpload'
    | 'headObject'
    | 'deleteObject'
    | 'getObjectStream',
    jest.Mock
  >;

  beforeEach(() => {
    repository = {
      create: jest.fn((fields: Partial<Video>) => fields as Video),
      save: jest.fn((video: Video) => Promise.resolve(video)),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue(CHANNEL),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignUploadParts: jest.fn(
        (_key: string, _uploadId: string, partNumbers: number[]) =>
          Promise.resolve({
            parts: partNumbers.map((partNumber) => ({
              partNumber,
              url: `http://storage/part-${partNumber}`,
            })),
            expiresAt: new Date('2030-01-01T00:00:00.000Z'),
          }),
      ),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({
        size: 250 * 1024 * 1024,
        contentType: 'video/mp4',
      }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      getObjectStream: jest.fn().mockResolvedValue({ body: 'stream' }),
    };
    service = new VideosService(
      repository as unknown as Repository<Video>,
      channelsService as unknown as ChannelsService,
      storage as unknown as StorageService,
      queue as unknown as VideoProcessingQueue,
    );
  });

  describe('initiateUpload', () => {
    const dto = {
      fileName: 'minha.aula.mp4',
      fileSize: 250 * 1024 * 1024,
      contentType: 'video/mp4',
    };

    it('defaults the title to the file name without extension and signs every part', async () => {
      const result = await service.initiateUpload(USER_ID, dto);

      expect(result.title).toBe('minha.aula');
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.partCount).toBe(3);
      expect(result.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
      expect(result.expiresAt).toBe('2030-01-01T00:00:00.000Z');
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        `videos/${result.id}/original`,
        'video/mp4',
      );
    });

    it('keeps an explicit title', async () => {
      const result = await service.initiateUpload(USER_ID, {
        ...dto,
        title: 'Aula 1',
      });

      expect(result.title).toBe('Aula 1');
    });

    it('fails with CHANNEL_NOT_FOUND when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.initiateUpload(USER_ID, dto)).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('retries with a new slug on a unique-slug violation', async () => {
      repository.save
        .mockRejectedValueOnce(uniqueSlugViolation())
        .mockImplementationOnce((video: Video) => Promise.resolve(video));

      const result = await service.initiateUpload(USER_ID, dto);

      expect(repository.save).toHaveBeenCalledTimes(2);
      const slugs = repository.create.mock.calls.map(
        ([fields]: [Video]) => fields.slug,
      );
      expect(slugs[0]).not.toBe(slugs[1]);
      expect(result.slug).toBe(slugs[1]);
    });

    it('aborts the multipart upload when the draft cannot be persisted', async () => {
      repository.save.mockRejectedValue(new Error('db down'));

      await expect(service.initiateUpload(USER_ID, dto)).rejects.toThrow(
        'db down',
      );
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/original$/),
        'upload-1',
      );
    });
  });

  describe('presignParts', () => {
    it('signs the requested parts of an owned draft', async () => {
      repository.findOne.mockResolvedValue(draftVideo());

      const result = await service.presignParts(USER_ID, 'video-1', [2, 3]);

      expect(result.parts.map((p) => p.partNumber)).toEqual([2, 3]);
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 'video-1', channel_id: CHANNEL.id },
      });
    });

    it('rejects part numbers beyond the part count', async () => {
      repository.findOne.mockResolvedValue(draftVideo());

      await expect(
        service.presignParts(USER_ID, 'video-1', [4]),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
    });

    it('rejects videos that are not drafts', async () => {
      repository.findOne.mockResolvedValue(
        draftVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.presignParts(USER_ID, 'video-1', [1]),
      ).rejects.toBeInstanceOf(InvalidVideoStatusException);
    });

    it('hides videos that are not owned by the caller', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.presignParts(USER_ID, 'video-1', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('completeUpload', () => {
    const allParts = [
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
      { partNumber: 3, etag: '"c"' },
    ];

    it('persists processing before enqueueing the job', async () => {
      repository.findOne.mockResolvedValue(draftVideo());
      const order: string[] = [];
      repository.update.mockImplementation(() => {
        order.push('update');
        return Promise.resolve({ affected: 1 });
      });
      queue.enqueue.mockImplementation(() => {
        order.push('enqueue');
        return Promise.resolve();
      });

      const result = await service.completeUpload(USER_ID, 'video-1', allParts);

      expect(result).toEqual({
        id: 'video-1',
        slug: 'abcdefghijk',
        status: VideoStatus.PROCESSING,
      });
      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-1', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, upload_id: null },
      );
      expect(queue.enqueue).toHaveBeenCalledWith('video-1');
      expect(order).toEqual(['update', 'enqueue']);
    });

    it('rejects a part list that does not cover every part', async () => {
      repository.findOne.mockResolvedValue(draftVideo());

      await expect(
        service.completeUpload(USER_ID, 'video-1', allParts.slice(0, 2)),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('deletes the object and marks the video failed on size mismatch', async () => {
      repository.findOne.mockResolvedValue(draftVideo());
      storage.headObject.mockResolvedValue({
        size: 10,
        contentType: 'video/mp4',
      });

      await expect(
        service.completeUpload(USER_ID, 'video-1', allParts),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(storage.deleteObject).toHaveBeenCalledWith(
        'videos/video-1/original',
      );
      expect(repository.update).toHaveBeenCalledWith(
        'video-1',
        expect.objectContaining({
          status: VideoStatus.FAILED,
          upload_id: null,
        }),
      );
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('rejects completion of a video that is no longer a draft', async () => {
      repository.findOne.mockResolvedValue(
        draftVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.completeUpload(USER_ID, 'video-1', allParts),
      ).rejects.toBeInstanceOf(InvalidVideoStatusException);
    });

    it('marks the video failed when the job cannot be enqueued', async () => {
      repository.findOne.mockResolvedValue(draftVideo());
      const queueDown = new Error('Redis unavailable');
      queue.enqueue.mockRejectedValue(queueDown);

      await expect(
        service.completeUpload(USER_ID, 'video-1', allParts),
      ).rejects.toBe(queueDown);
      expect(repository.update).toHaveBeenLastCalledWith(
        { id: 'video-1', status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.FAILED,
          processing_error: 'Processing could not be scheduled',
        },
      );
    });

    it('does not enqueue when a concurrent completion already won', async () => {
      repository.findOne.mockResolvedValue(draftVideo());
      repository.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.completeUpload(USER_ID, 'video-1', allParts),
      ).rejects.toBeInstanceOf(InvalidVideoStatusException);
      expect(queue.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('abortUpload', () => {
    it('aborts the multipart upload and deletes the draft', async () => {
      repository.findOne.mockResolvedValue(draftVideo());

      await service.abortUpload(USER_ID, 'video-1');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
      );
      expect(repository.delete).toHaveBeenCalledWith({ id: 'video-1' });
    });

    it('hides videos that are not owned by the caller', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.abortUpload(USER_ID, 'video-1'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('findBySlug', () => {
    const createdAt = new Date('2026-10-04T00:00:00.000Z');

    it('exposes links and hides the thumbnail until the video is ready', async () => {
      repository.findOne.mockResolvedValue(
        draftVideo({ status: VideoStatus.PROCESSING, created_at: createdAt }),
      );

      const result = await service.findBySlug('abcdefghijk');

      expect(result).toMatchObject({
        slug: 'abcdefghijk',
        status: VideoStatus.PROCESSING,
        streamUrl: '/videos/abcdefghijk/stream',
        downloadUrl: '/videos/abcdefghijk/download',
        thumbnailUrl: null,
        sizeBytes: String(250 * 1024 * 1024),
        createdAt: '2026-10-04T00:00:00.000Z',
      });
    });

    it('includes the thumbnail link for ready videos', async () => {
      repository.findOne.mockResolvedValue(
        draftVideo({ status: VideoStatus.READY, created_at: createdAt }),
      );

      const result = await service.findBySlug('abcdefghijk');

      expect(result.thumbnailUrl).toBe('/videos/abcdefghijk/thumbnail');
    });

    it('fails with VIDEO_NOT_FOUND for an unknown slug', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.findBySlug('nope')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });
  });

  describe('getThumbnail', () => {
    it('streams the stored thumbnail of a ready video', async () => {
      repository.findOne.mockResolvedValue(
        draftVideo({
          status: VideoStatus.READY,
          thumbnail_key: 'videos/video-1/thumbnail.jpg',
        }),
      );

      await service.getThumbnail('abcdefghijk');

      expect(storage.getObjectStream).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
      );
    });

    it('rejects videos that are not ready', async () => {
      repository.findOne.mockResolvedValue(
        draftVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(service.getThumbnail('abcdefghijk')).rejects.toBeInstanceOf(
        VideoNotReadyException,
      );
    });
  });

  describe('openStream / openDownload', () => {
    beforeEach(() => {
      repository.findOne.mockResolvedValue(
        draftVideo({ status: VideoStatus.READY, size_bytes: '1000' }),
      );
    });

    it('serves the whole file with 200 when no Range is sent', async () => {
      const content = await service.openStream('abcdefghijk');

      expect(content).toMatchObject({
        status: 200,
        contentLength: 1000,
        contentType: 'video/mp4',
        fileName: 'aula.mp4',
      });
      expect(content.contentRange).toBeUndefined();
      expect(storage.getObjectStream).toHaveBeenCalledWith(
        'videos/video-1/original',
      );
    });

    it('serves the requested range with 206', async () => {
      const content = await service.openStream('abcdefghijk', 'bytes=100-199');

      expect(content).toMatchObject({
        status: 206,
        contentLength: 100,
        contentRange: 'bytes 100-199/1000',
      });
      expect(storage.getObjectStream).toHaveBeenCalledWith(
        'videos/video-1/original',
        'bytes=100-199',
      );
    });

    it('rejects videos that are not ready', async () => {
      repository.findOne.mockResolvedValue(
        draftVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(service.openDownload('abcdefghijk')).rejects.toBeInstanceOf(
        VideoNotReadyException,
      );
    });
  });
});
