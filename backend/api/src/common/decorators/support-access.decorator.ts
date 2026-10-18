import { SetMetadata } from '@nestjs/common';

export const SUPPORT_ACCESS_ACTION_KEY = 'kemfai:supportAccessAction';
export const RequireSupportAccess = (action: string): MethodDecorator & ClassDecorator =>
  SetMetadata(SUPPORT_ACCESS_ACTION_KEY, action);
