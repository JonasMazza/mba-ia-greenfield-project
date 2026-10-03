import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const MAX_PART_NUMBER = 10000;

export class UploadedPartDto {
  @ApiProperty({ description: '1-based part number', example: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_PART_NUMBER)
  part_number: number;

  @ApiProperty({
    description: 'ETag returned by the storage for that part',
    example: '"9b2cf5f1e6c1f0b0b1a2c3d4e5f60718"',
  })
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @ApiProperty({
    description: 'Every uploaded part with the ETag the storage returned',
    type: [UploadedPartDto],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  parts: UploadedPartDto[];
}
