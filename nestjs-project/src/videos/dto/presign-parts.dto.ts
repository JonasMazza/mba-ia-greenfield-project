import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsInt, Max, Min } from 'class-validator';

const MAX_PART_NUMBER = 10000;

export class PresignPartsDto {
  @ApiProperty({
    description:
      'Part numbers to presign. On resume, send only the parts still missing.',
    example: [1, 2, 3],
    type: [Number],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_PART_NUMBER, { each: true })
  part_numbers: number[];
}
