import type { Readable } from 'node:stream';

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface PresignedParts {
  parts: PresignedPart[];
  expiresAt: Date;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface StoredObjectInfo {
  size: number;
  contentType: string | undefined;
}

export interface ObjectStream {
  body: Readable;
  contentLength: number;
  contentRange: string | undefined;
  contentType: string | undefined;
}
