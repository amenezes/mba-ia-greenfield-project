import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../videos.constants';

export class VideoMetadataDto {
  @ApiProperty({ nullable: true, example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  formatName: string | null;

  @ApiProperty({ nullable: true, example: 1048576 })
  bitRate: number | null;

  @ApiProperty({ nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ nullable: true, example: 'h264' })
  videoCodec: string | null;

  @ApiProperty({ nullable: true, example: 'aac' })
  audioCodec: string | null;
}

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  slug: string;

  @ApiProperty({ example: 'aula' })
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ nullable: true, example: 212.48 })
  durationSeconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({
    example: '314572800',
    description: 'File size in bytes (bigint as decimal string)',
  })
  sizeBytes: string;

  @ApiProperty({ example: 'video/mp4' })
  contentType: string;

  @ApiProperty({ format: 'uuid' })
  channelId: string;

  @ApiProperty({ example: '/videos/dQw4w9WgXcQ/stream' })
  streamUrl: string;

  @ApiProperty({ example: '/videos/dQw4w9WgXcQ/download' })
  downloadUrl: string;

  @ApiProperty({
    nullable: true,
    example: '/videos/dQw4w9WgXcQ/thumbnail',
    description: 'Present only when the video is ready',
  })
  thumbnailUrl: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}
