import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { attachmentDisposition } from './content-disposition.util';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { UploadPartsResponseDto } from './dto/upload-parts-response.dto';
import { UploadPartsDto } from './dto/upload-parts.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

// Range requests from a video player would exhaust the auth-oriented global throttler.
@SkipThrottle()
@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the caller channel, starts an S3 multipart upload and returns one presigned URL per part. The client PUTs each part directly to object storage — the file never passes through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload started',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid body (size above 10 GiB, non-video content type…)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'The authenticated user has no channel',
    schema: errorSchema,
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Re-sign upload part URLs',
    description:
      'Returns fresh presigned URLs for the given part numbers of a draft upload (e.g. after expiry or to retry a part).',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: UploadPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid id/body or part number out of range',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft',
    schema: errorSchema,
  })
  async presignParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadPartsDto,
  ): Promise<UploadPartsResponseDto> {
    return this.videosService.presignParts(user.sub, id, dto.partNumbers);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload, verifies the stored size against the declared size, moves the video to processing and enqueues the processing job (metadata + thumbnail).',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; processing started',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid id/body, incomplete or rejected part list (INVALID_UPLOAD_PARTS) or stored size mismatch (UPLOAD_SIZE_MISMATCH)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft',
    schema: errorSchema,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, id, dto.parts);
  }

  @Delete(':id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the multipart upload in object storage and deletes the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted, draft deleted' })
  @ApiResponse({
    status: 400,
    description: 'Invalid id',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft',
    schema: errorSchema,
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, id);
  }

  @Public()
  @Get(':slug')
  @ApiOperation({
    summary: 'Get a video by its unique URL slug',
    description:
      'Public video details (any status, so uploaders can poll processing) with stream, download and thumbnail links.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video details',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  async findBySlug(@Param('slug') slug: string): Promise<VideoResponseDto> {
    return this.videosService.findBySlug(slug);
  }

  @Public()
  @Get(':slug/thumbnail')
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOperation({
    summary: 'Get the video thumbnail',
    description: 'JPEG frame generated by the video worker.',
  })
  @ApiResponse({
    status: 200,
    description: 'JPEG image',
    content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: errorSchema,
  })
  async getThumbnail(@Param('slug') slug: string): Promise<StreamableFile> {
    const thumbnail = await this.videosService.getThumbnail(slug);
    return new StreamableFile(thumbnail.body, {
      type: 'image/jpeg',
      length: thumbnail.contentLength,
    });
  }

  @Public()
  @Get(':slug/stream')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Streams the original file. Honors a single HTTP `Range` header (206 Partial Content) so players can seek without downloading the whole file.',
  })
  @ApiHeader({
    name: 'Range',
    required: false,
    description: 'Single byte range, e.g. `bytes=0-1048575`',
  })
  @ApiResponse({
    status: 200,
    description: 'Full file (no Range header)',
    content: { 'video/*': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({
    status: 206,
    description: 'Requested byte range',
    content: { 'video/*': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 416,
    description: 'Malformed, multi-range or out-of-bounds Range header',
    schema: errorSchema,
  })
  async stream(
    @Param('slug') slug: string,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const content = await this.videosService.openStream(slug, range);
    res.status(content.status);
    res.setHeader('Accept-Ranges', 'bytes');
    if (content.contentRange) {
      res.setHeader('Content-Range', content.contentRange);
    }
    return new StreamableFile(content.stream, {
      type: content.contentType,
      length: content.contentLength,
    });
  }

  @Public()
  @Get(':slug/download')
  @ApiOperation({
    summary: 'Download a video',
    description: 'Returns the original file as an attachment.',
  })
  @ApiResponse({
    status: 200,
    description: 'Original file (Content-Disposition: attachment)',
    content: { 'video/*': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: errorSchema,
  })
  async download(@Param('slug') slug: string): Promise<StreamableFile> {
    const content = await this.videosService.openDownload(slug);
    return new StreamableFile(content.stream, {
      type: content.contentType,
      length: content.contentLength,
      disposition: attachmentDisposition(content.fileName),
    });
  }
}
