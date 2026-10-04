import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { InvalidUploadPartsException } from '../common/exceptions/domain.exception';
import {
  INVALID_UPLOAD_PARTS_S3_ERRORS,
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_CLIENT,
} from './storage.constants';
import type {
  CompletedPart,
  ObjectStream,
  PresignedParts,
  StoredObjectInfo,
} from './storage.types';

function isS3Error(err: unknown, names: readonly string[]): boolean {
  return err instanceof S3ServiceException && names.includes(err.name);
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404
  );
}

@Injectable()
export class StorageService implements OnModuleInit {
  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    const Bucket = this.config.bucket;
    try {
      await this.internalClient.send(new HeadBucketCommand({ Bucket }));
      return;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    try {
      await this.internalClient.send(new CreateBucketCommand({ Bucket }));
    } catch (err) {
      // API and worker may bootstrap concurrently — the bucket existing is the goal.
      if (!isS3Error(err, ['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'])) {
        throw err;
      }
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const response = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!response.UploadId) {
      throw new Error(`Storage returned no UploadId for key ${key}`);
    }
    return response.UploadId;
  }

  async presignUploadParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<PresignedParts> {
    const expiresIn = this.config.presignedUrlExpirationSeconds;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(
          this.publicClient,
          new UploadPartCommand({
            Bucket: this.config.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn },
        ),
      })),
    );
    return { parts, expiresAt };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((part) => ({
                PartNumber: part.partNumber,
                ETag: part.etag,
              })),
          },
        }),
      );
    } catch (err) {
      if (isS3Error(err, INVALID_UPLOAD_PARTS_S3_ERRORS)) {
        throw new InvalidUploadPartsException();
      }
      throw err;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<StoredObjectInfo> {
    const response = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    return {
      size: response.ContentLength ?? 0,
      contentType: response.ContentType,
    };
  }

  async getObjectStream(key: string, range?: string): Promise<ObjectStream> {
    const response = await this.internalClient.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Range: range,
      }),
    );
    if (!(response.Body instanceof Readable)) {
      throw new Error(`Storage returned no readable body for key ${key}`);
    }
    return {
      body: response.Body,
      contentLength: response.ContentLength ?? 0,
      contentRange: response.ContentRange,
      contentType: response.ContentType,
    };
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  async presignInternalGetUrl(key: string): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: this.config.presignedUrlExpirationSeconds },
    );
  }
}
