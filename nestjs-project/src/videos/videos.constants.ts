export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024;
export const UPLOAD_PART_SIZE_BYTES = 100 * 1024 * 1024;

export const VIDEO_STORAGE_KEYS = {
  original: (videoId: string): string => `videos/${videoId}/original`,
  thumbnail: (videoId: string): string => `videos/${videoId}/thumbnail.jpg`,
} as const;
