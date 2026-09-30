import {
  Body, Controller, Delete, HttpCode, Param, ParseIntPipe, Patch, Post,
} from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { CUSTOM_FIELD_TYPES } from '../../shared/config';
import type { CustomFieldType } from '../../shared/models';
import { Requires } from '../../common/decorators/requires.decorator';
import { CustomFieldsService } from './custom-fields.service';

class CreateCustomFieldDto {
  @IsString() @MaxLength(64) name!: string;
  @IsIn(CUSTOM_FIELD_TYPES) type!: CustomFieldType;
  @IsOptional() @IsArray() @IsString({ each: true }) options?: string[];
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional() @IsString() @MaxLength(255) defaultValue?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) projectIds?: number[];
}

class UpdateCustomFieldDto {
  @IsOptional() @IsString() @MaxLength(64) name?: string;
  @IsOptional() @IsIn(CUSTOM_FIELD_TYPES) type?: CustomFieldType;
  @IsOptional() @IsArray() @IsString({ each: true }) options?: string[];
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional() @IsString() @MaxLength(255) defaultValue?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) projectIds?: number[];
}

/** Reads live in the catalog module, with usage counts. */
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Post()
  @Requires('manageCustomFields')
  create(@Body() dto: CreateCustomFieldDto) {
    return this.fields.create(dto);
  }

  @Patch(':id')
  @HttpCode(204)
  @Requires('manageCustomFields')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCustomFieldDto) {
    await this.fields.update(id, dto);
  }

  /** Returns how many issue values went with it, so the UI can report the damage. */
  @Delete(':id')
  @HttpCode(200)
  @Requires('manageCustomFields')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.fields.remove(id);
  }
}
