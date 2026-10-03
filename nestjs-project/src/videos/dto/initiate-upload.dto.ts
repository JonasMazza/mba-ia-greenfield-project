import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { MIN_PART_SIZE_BYTES } from '../videos.constants';

/**
 * Note on what is *not* validated here: the `video/*` rule and the 10 GiB
 * ceiling are enforced in the service so they surface as `415` and `413`
 * domain errors instead of a generic `400` from the ValidationPipe.
 */
export class InitiateUploadDto {
  @ApiProperty({
    description: 'Original file name — only used to derive the storage key',
    example: 'clip.mp4',
  })
  @IsString()
  @IsNotEmpty()
  filename: string;

  @ApiProperty({
    description: 'MIME type of the upload; must be a `video/*` type',
    example: 'video/mp4',
  })
  @IsString()
  @IsNotEmpty()
  content_type: string;

  @ApiProperty({
    description: 'Total size of the file in bytes (max 10 GiB)',
    example: 52428800,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  size_bytes: number;

  @ApiPropertyOptional({
    description: `Desired part size in bytes; at least ${MIN_PART_SIZE_BYTES} (5 MiB), the S3 minimum for every part but the last`,
    example: 67108864,
    minimum: MIN_PART_SIZE_BYTES,
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_PART_SIZE_BYTES)
  part_size_bytes?: number;
}
