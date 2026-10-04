import { randomUUID } from 'node:crypto';
import { parse } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
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
import type { CompletedPart, ObjectStream } from '../storage/storage.types';
import { VideoProcessingQueue } from '../video-processing/video-processing-queue.service';
import type { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import type { UploadPartsResponseDto } from './dto/upload-parts-response.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import { Video, type VideoMetadata } from './entities/video.entity';
import { parseRange } from './range.util';
import { generateVideoSlug } from './slug.util';
import {
  MAX_VIDEO_SIZE_BYTES,
  UPLOAD_PART_SIZE_BYTES,
  VIDEO_STORAGE_KEYS,
  VideoStatus,
} from './videos.constants';

export interface VideoContent {
  stream: ObjectStream['body'];
  status: 200 | 206;
  contentType: string;
  contentLength: number;
  contentRange?: string;
  fileName: string;
}

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_COLUMN = 'slug';
const MAX_SLUG_ATTEMPTS = 5;

function isUniqueViolationOn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & {
    code?: unknown;
    detail?: unknown;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}

function partCountOf(sizeBytes: number): number {
  return Math.ceil(sizeBytes / UPLOAD_PART_SIZE_BYTES);
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoProcessingQueue: VideoProcessingQueue,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();

    const id = randomUUID();
    const storageKey = VIDEO_STORAGE_KEYS.original(id);
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.contentType,
    );

    let video: Video;
    try {
      video = await this.insertWithUniqueSlug({
        id,
        channel_id: channel.id,
        title: dto.title ?? (parse(dto.fileName).name || dto.fileName),
        status: VideoStatus.DRAFT,
        original_file_name: dto.fileName,
        content_type: dto.contentType,
        size_bytes: String(dto.fileSize),
        storage_key: storageKey,
        upload_id: uploadId,
      });
    } catch (err) {
      // Compensation: do not leave an orphan multipart upload in storage.
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
      throw err;
    }

    const partCount = partCountOf(dto.fileSize);
    const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
    const { parts, expiresAt } = await this.storageService.presignUploadParts(
      storageKey,
      uploadId,
      partNumbers,
    );

    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      uploadId,
      partSize: UPLOAD_PART_SIZE_BYTES,
      partCount,
      parts,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async presignParts(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<UploadPartsResponseDto> {
    const video = await this.findDraftOwnedBy(userId, videoId);
    const partCount = partCountOf(Number(video.size_bytes));
    if (partNumbers.some((n) => n < 1 || n > partCount)) {
      throw new InvalidUploadPartsException();
    }

    const { parts, expiresAt } = await this.storageService.presignUploadParts(
      video.storage_key,
      video.upload_id!,
      partNumbers,
    );
    return { parts, expiresAt: expiresAt.toISOString() };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    parts: CompletedPart[],
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findDraftOwnedBy(userId, videoId);
    const declaredSize = Number(video.size_bytes);

    const partNumbers = parts.map((p) => p.partNumber).sort((a, b) => a - b);
    const coversEveryPart =
      partNumbers.length === partCountOf(declaredSize) &&
      partNumbers.every((n, i) => n === i + 1);
    if (!coversEveryPart) throw new InvalidUploadPartsException();

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      video.upload_id!,
      parts,
    );

    // Presigned part URLs cannot bound the bytes sent, so the 10 GiB cap and the
    // declared size are enforced on the stored object.
    const { size } = await this.storageService.headObject(video.storage_key);
    if (size !== declaredSize || size > MAX_VIDEO_SIZE_BYTES) {
      await this.storageService.deleteObject(video.storage_key);
      await this.videoRepository.update(video.id, {
        status: VideoStatus.FAILED,
        upload_id: null,
        processing_error: `Uploaded size ${size} does not match declared size ${declaredSize}`,
      });
      throw new UploadSizeMismatchException();
    }

    const { affected } = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING, upload_id: null },
    );
    // A concurrent completion already moved the video out of draft.
    if (!affected) throw new InvalidVideoStatusException();

    try {
      await this.videoProcessingQueue.enqueue(video.id);
    } catch (err) {
      // Never leave the video stuck in processing without a job (TD-09: the
      // terminal failure state is `failed`, visible in processing_error).
      await this.videoRepository.update(
        { id: video.id, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.FAILED,
          processing_error: 'Processing could not be scheduled',
        },
      );
      throw err;
    }

    return { id: video.id, slug: video.slug, status: VideoStatus.PROCESSING };
  }

  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findDraftOwnedBy(userId, videoId);
    await this.storageService.abortMultipartUpload(
      video.storage_key,
      video.upload_id!,
    );
    await this.videoRepository.delete({ id: video.id });
  }

  async findBySlug(slug: string): Promise<VideoResponseDto> {
    return this.toResponse(await this.getBySlug(slug));
  }

  async getThumbnail(slug: string): Promise<ObjectStream> {
    const video = await this.getReadyBySlug(slug);
    return this.storageService.getObjectStream(video.thumbnail_key!);
  }

  /** Original file of a ready video; honors a single HTTP Range (206). */
  async openStream(slug: string, rangeHeader?: string): Promise<VideoContent> {
    const video = await this.getReadyBySlug(slug);
    const size = Number(video.size_bytes);
    const base = {
      contentType: video.content_type,
      fileName: video.original_file_name,
    };

    if (!rangeHeader) {
      const object = await this.storageService.getObjectStream(
        video.storage_key,
      );
      return { ...base, stream: object.body, status: 200, contentLength: size };
    }

    const { start, end } = parseRange(rangeHeader, size);
    const object = await this.storageService.getObjectStream(
      video.storage_key,
      `bytes=${start}-${end}`,
    );
    return {
      ...base,
      stream: object.body,
      status: 206,
      contentLength: end - start + 1,
      contentRange: `bytes ${start}-${end}/${size}`,
    };
  }

  /** Whole original file of a ready video, for download as an attachment. */
  async openDownload(slug: string): Promise<VideoContent> {
    return this.openStream(slug);
  }

  /** Video awaiting processing, or null when it is gone or already handled. */
  async findForProcessing(videoId: string): Promise<Video | null> {
    return this.videoRepository.findOne({
      where: { id: videoId, status: VideoStatus.PROCESSING },
    });
  }

  async markReady(
    videoId: string,
    result: {
      durationSeconds: number;
      metadata: VideoMetadata;
      thumbnailKey: string;
    },
  ): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: result.durationSeconds,
        metadata: result.metadata,
        thumbnail_key: result.thumbnailKey,
        processing_error: null,
      },
    );
  }

  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, processing_error: reason },
    );
  }

  private async getBySlug(slug: string): Promise<Video> {
    const video = await this.videoRepository.findOne({ where: { slug } });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  private async getReadyBySlug(slug: string): Promise<Video> {
    const video = await this.getBySlug(slug);
    if (video.status !== VideoStatus.READY) throw new VideoNotReadyException();
    return video;
  }

  private toResponse(video: Video): VideoResponseDto {
    const basePath = `/videos/${video.slug}`;
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      metadata: video.metadata,
      sizeBytes: video.size_bytes,
      contentType: video.content_type,
      channelId: video.channel_id,
      streamUrl: `${basePath}/stream`,
      downloadUrl: `${basePath}/download`,
      thumbnailUrl:
        video.status === VideoStatus.READY ? `${basePath}/thumbnail` : null,
      createdAt: video.created_at.toISOString(),
    };
  }

  private async findOwnedBy(userId: string, videoId: string): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    const video = channel
      ? await this.videoRepository.findOne({
          where: { id: videoId, channel_id: channel.id },
        })
      : null;
    // Non-owners get the same answer as unknown ids — existence is not revealed.
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  private async findDraftOwnedBy(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.findOwnedBy(userId, videoId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new InvalidVideoStatusException();
    }
    return video;
  }

  private async insertWithUniqueSlug(fields: Partial<Video>): Promise<Video> {
    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({ ...fields, slug: generateVideoSlug() }),
        );
      } catch (err) {
        if (!isUniqueViolationOn(err, SLUG_COLUMN)) throw err;
      }
    }
    throw new Error(
      `Video slug conflict could not be resolved after ${MAX_SLUG_ATTEMPTS} attempts`,
    );
  }
}
