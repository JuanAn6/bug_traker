import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { Env } from '../../core/config/env.schema';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AbilityService } from './ability.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { VisibilityService } from './visibility.service';

/**
 * Global because the guards registered app-wide (JwtAuthGuard, ThresholdGuard) resolve
 * AuthService and TokenService, and because almost every feature module needs AbilityService
 * and VisibilityService.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: { algorithm: 'HS256' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, AbilityService, VisibilityService],
  exports: [AuthService, PasswordService, TokenService, AbilityService, VisibilityService],
})
export class AuthModule {}
