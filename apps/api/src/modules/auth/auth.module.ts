import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

@Module({
  imports: [
    // Secrets are passed per-sign/verify call rather than registered globally,
    // because access and refresh tokens use different secrets. Registering one
    // here would make it too easy to sign a refresh token with the access
    // secret by omitting the option.
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService],
  exports: [AuthService, TokenService, JwtModule],
})
export class AuthModule {}
