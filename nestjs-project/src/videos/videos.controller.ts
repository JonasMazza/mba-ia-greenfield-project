import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PresignPartsDto } from './dto/presign-parts.dto';
import type {
  CompleteUploadResult,
  InitiateUploadResult,
  PresignPartsResult,
  PresignedUrlResult,
  PublicVideoResult,
  UploadedPartsResult,
  VideoStatusResult,
} from './videos.service';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      "Pre-registers the video as a draft on the caller's channel and opens a multipart upload, returning the plan the client follows to send parts straight to object storage.",
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        public_id: { type: 'string' },
        upload_id: { type: 'string' },
        part_size_bytes: { type: 'integer' },
        part_count: { type: 'integer' },
        expires_in: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'File exceeds the maximum upload size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Content type is not a video type',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':publicId/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiOperation({
    summary: 'Presign upload parts',
    description:
      'Issues presigned UploadPart URLs for the requested part numbers. This is also the resume path: ask only for the parts still missing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'integer' },
              url: { type: 'string' },
            },
          },
        },
        expires_in: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with this public id belongs to the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video has no active multipart upload',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async presignParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: PresignPartsDto,
  ): Promise<PresignPartsResult> {
    return this.videosService.presignParts(user.sub, publicId, dto);
  }

  @Get(':publicId/upload/parts')
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiOperation({
    summary: 'List the parts already uploaded',
    description:
      'Returns the parts the object storage already holds for the active multipart upload, with their ETags. This is the resume path after a page reload: the client signs only the missing parts and completes with server-sourced ETags.',
  })
  @ApiResponse({
    status: 200,
    description: 'Parts already received by the storage',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'integer' },
              etag: { type: 'string' },
              size: { type: 'integer' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with this public id belongs to the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video has no active multipart upload',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<UploadedPartsResult> {
    return this.videosService.listUploadedParts(user.sub, publicId);
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload and, in the same transaction, moves the video to `processing` and enqueues the processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed and processing enqueued',
    schema: {
      properties: {
        public_id: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with this public id belongs to the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'The video has no active multipart upload (`INVALID_UPLOAD_STATE`), or the stored parts do not add up to the declared `size_bytes` (`UPLOAD_SIZE_MISMATCH`)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user.sub, publicId, dto);
  }

  @Delete(':publicId/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the multipart upload and discards the draft, releasing the storage it held.',
  })
  @ApiResponse({
    status: 204,
    description: 'Upload aborted and draft discarded',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with this public id belongs to the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video has no active multipart upload',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, publicId);
  }

  @Get(':publicId/status')
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiOperation({
    summary: 'Poll the processing status',
    description:
      'Owner-only view of the `draft → processing → ready | failed` lifecycle. Metadata and a presigned thumbnail URL appear once the video is ready; the failure reason appears when it failed.',
  })
  @ApiResponse({
    status: 200,
    description: 'Current processing status',
    schema: {
      properties: {
        public_id: { type: 'string' },
        status: {
          type: 'string',
          enum: ['draft', 'processing', 'ready', 'failed'],
        },
        duration_seconds: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        thumbnail_url: { type: 'string' },
        failure_reason: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with this public id belongs to the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getStatus(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<VideoStatusResult> {
    return this.videosService.getStatus(user.sub, publicId);
  }

  @Public()
  @Get(':publicId')
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiOperation({
    summary: 'Resolve public video metadata',
    description:
      'Public metadata for a ready video — the API behind the watch page. A video that is not ready is invisible to anyone but its owner.',
  })
  @ApiResponse({
    status: 200,
    description: 'Public video metadata',
    schema: {
      properties: {
        public_id: { type: 'string' },
        title: { type: 'string', nullable: true },
        status: { type: 'string', example: 'ready' },
        duration_seconds: { type: 'integer', nullable: true },
        width: { type: 'integer', nullable: true },
        height: { type: 'integer', nullable: true },
        thumbnail_url: { type: 'string', nullable: true },
        created_at: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description:
      'Unknown public id, or not ready and the caller is not the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getPublicVideo(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('publicId') publicId: string,
  ): Promise<PublicVideoResult> {
    return this.videosService.getPublicVideo(publicId, user?.sub);
  }

  @Public()
  @Get(':publicId/stream')
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiOperation({
    summary: 'Issue a playback URL',
    description:
      'Authorizes playback and returns a short-lived presigned URL the player reads directly from object storage, with native HTTP Range support for seeking.',
  })
  @ApiResponse({
    status: 200,
    description: 'Range-capable presigned playback URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expires_in: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description:
      'Unknown public id, or not ready and the caller is not the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The owner requested playback of a video that is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getStreamUrl(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('publicId') publicId: string,
  ): Promise<PresignedUrlResult> {
    return this.videosService.getStreamUrl(publicId, user?.sub);
  }

  @Public()
  @Get(':publicId/download')
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiOperation({
    summary: 'Issue a download URL',
    description:
      'Same presigned mechanism as playback, with an attachment disposition so the browser saves the original file.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL delivered as an attachment',
    schema: {
      properties: {
        url: { type: 'string' },
        expires_in: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description:
      'Unknown public id, or not ready and the caller is not the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The owner requested a download of a video that is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownloadUrl(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('publicId') publicId: string,
  ): Promise<PresignedUrlResult> {
    return this.videosService.getDownloadUrl(publicId, user?.sub);
  }
}
