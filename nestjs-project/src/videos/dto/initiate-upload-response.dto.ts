import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../videos.constants';
import { PresignedPartDto } from './upload-parts-response.dto';

export class InitiateUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ', minLength: 11, maxLength: 11 })
  slug: string;

  @ApiProperty({ example: 'aula' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ description: 'S3 multipart upload id' })
  uploadId: string;

  @ApiProperty({ example: 104857600, description: 'Part size in bytes' })
  partSize: number;

  @ApiProperty({ example: 3 })
  partCount: number;

  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}
