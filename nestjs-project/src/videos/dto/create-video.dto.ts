import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { MAX_VIDEO_SIZE_BYTES } from '../videos.constants';

export class CreateVideoDto {
  /** Original file name, e.g. `aula.mp4`. */
  @IsString()
  @Length(1, 255)
  fileName: string;

  /** File size in bytes (max 10 GiB). */
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  fileSize: number;

  /** MIME type of the file; must be a video type (e.g. `video/mp4`). */
  @IsString()
  @Matches(/^video\/[\w.+-]+$/)
  contentType: string;

  /** Video title; defaults to the file name without its extension. */
  @IsOptional()
  @IsString()
  @Length(1, 255)
  title?: string;
}
