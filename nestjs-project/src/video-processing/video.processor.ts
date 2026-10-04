import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { StorageService } from '../storage/storage.service';
import { VIDEO_STORAGE_KEYS } from '../videos/videos.constants';
import { VideosService } from '../videos/videos.service';
import { InvalidMediaError } from './media-probe.errors';
import { MediaProbeService } from './media-probe.service';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly mediaProbe: MediaProbeService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videosService.findForProcessing(videoId);
    if (!video) {
      // At-least-once delivery: the video was deleted or already processed.
      this.logger.warn(`Skipping job for video ${videoId}: not in processing`);
      return;
    }

    try {
      const inputUrl = await this.storageService.presignInternalGetUrl(
        video.storage_key,
      );
      const { durationSeconds, metadata } =
        await this.mediaProbe.probe(inputUrl);
      const thumbnail = await this.mediaProbe.extractThumbnail(
        inputUrl,
        this.mediaProbe.thumbnailOffset(durationSeconds),
      );
      const thumbnailKey = VIDEO_STORAGE_KEYS.thumbnail(video.id);
      await this.storageService.putObject(
        thumbnailKey,
        thumbnail,
        'image/jpeg',
      );
      await this.videosService.markReady(video.id, {
        durationSeconds,
        metadata,
        thumbnailKey,
      });
      this.logger.log(`Video ${video.id} is ready (${durationSeconds}s)`);
    } catch (err) {
      // Not a video: retrying cannot help, fail the job immediately.
      if (err instanceof InvalidMediaError) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const isFinal =
      error instanceof UnrecoverableError ||
      job.attemptsMade >= (job.opts.attempts ?? 1);
    this.logger.error(
      `Processing of video ${job.data.videoId} failed (attempt ${job.attemptsMade}${isFinal ? ', final' : ''}): ${error.message}`,
    );
    if (!isFinal) return;
    try {
      await this.videosService.markFailed(job.data.videoId, error.message);
    } catch (markError) {
      // Worker event handler: log instead of crashing the worker process.
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed: ${(markError as Error).message}`,
      );
    }
  }
}
