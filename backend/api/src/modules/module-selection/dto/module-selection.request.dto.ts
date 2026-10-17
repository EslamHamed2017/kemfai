import { ArrayUnique, IsArray, IsNotEmpty, IsString } from 'class-validator';

export class ModuleSelectionRequestDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  featureKeys: string[];
}
