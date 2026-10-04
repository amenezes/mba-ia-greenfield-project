import { ApiProperty } from '@nestjs/swagger';

export class PresignedPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({
    description: 'Presigned S3 UploadPart URL — PUT the part bytes to it.',
    example:
      'http://localhost:9000/streamtube/videos/0b3c.../original?partNumber=1&uploadId=...&X-Amz-Signature=...',
  })
  url: string;
}

export class UploadPartsResponseDto {
  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}
