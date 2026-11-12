import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { AppConfig, CONFIG_TOKEN } from '../../config/configuration';
import { CurrentUser, Public } from '../../common/decorators';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../../common/types/request-context';
import { AuthDocs } from '../../swagger/docs/auth.docs';
import { AuthService } from './auth.service';
import { IssuedTokens, SessionContext } from './token.service';
import {
  ChangePasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  UpdateProfileDto,
} from './dto/auth.dto';
import {
  AuthTokensResponse,
  MessageResponse,
  UserProfileResponse,
} from './dto/auth.response';

/**
 * Authentication endpoints.
 *
 * All OpenAPI documentation for these routes lives in
 * `src/swagger/docs/auth.docs.ts` — see that file for request/response
 * schemas, error cases and role notes.
 *
 * Refresh tokens travel in an HttpOnly cookie for browsers (so JavaScript,
 * and therefore XSS, cannot read them) and are also returned in the body for
 * non-browser clients that have no cookie jar.
 */
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @AuthDocs.register()
  async register(
    @Body() dto: RegisterDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokensResponse> {
    const { tokens, profile } = await this.authService.register(
      dto,
      this.sessionContext(request),
      request.correlationId,
    );
    this.setRefreshCookie(response, tokens);
    return this.toAuthResponse(tokens, profile);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  @AuthDocs.login()
  async login(
    @Body() dto: LoginDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokensResponse> {
    const { tokens, profile } = await this.authService.login(
      dto,
      this.sessionContext(request),
      request.correlationId,
    );
    this.setRefreshCookie(response, tokens);
    return this.toAuthResponse(tokens, profile);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 30, ttl: 60_000 } })
  @AuthDocs.refresh()
  async refresh(
    @Body() dto: RefreshDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokensResponse> {
    // Cookie first: a browser should never need to hold the token in JS.
    const presented =
      request.cookies?.[this.config.auth.refreshCookieName] ?? dto.refreshToken;

    if (!presented) {
      throw ApiError.unauthorized(
        ErrorCode.AUTHENTICATION_REQUIRED,
        'No refresh token was supplied',
      );
    }

    try {
      const { tokens, profile } = await this.authService.refresh(
        presented,
        this.sessionContext(request),
        request.correlationId,
      );
      this.setRefreshCookie(response, tokens);
      return this.toAuthResponse(tokens, profile);
    } catch (error) {
      // A rejected refresh means the cookie is useless; clear it so the
      // browser stops replaying a dead token on every request.
      this.clearRefreshCookie(response);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @AuthDocs.logout()
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MessageResponse> {
    const presented = request.cookies?.[this.config.auth.refreshCookieName];
    await this.authService.logout(presented, request.user, request.correlationId);
    this.clearRefreshCookie(response);
    // Always 200: logging out should be idempotent and never reveal whether
    // the presented token was valid.
    return { message: 'Signed out' };
  }

  @Get('me')
  @AuthDocs.me()
  async me(@CurrentUser() user: AuthenticatedUser): Promise<UserProfileResponse> {
    return this.authService.buildProfile(user.id);
  }

  @Patch('me')
  @AuthDocs.updateProfile()
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserProfileResponse> {
    return this.authService.updateProfile(user.id, dto);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @AuthDocs.changePassword()
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MessageResponse> {
    await this.authService.changePassword(user.id, dto, request.correlationId);
    // Every session was just revoked, including this one.
    this.clearRefreshCookie(response);
    return {
      message: 'Password changed. All sessions have been signed out.',
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private sessionContext(request: AuthenticatedRequest): SessionContext {
    return {
      userAgent: request.headers['user-agent'] ?? null,
      // `request.ip` honours X-Forwarded-For only when trust proxy is enabled,
      // which is why TRUST_PROXY is explicit configuration.
      ipAddress: request.ip ?? null,
    };
  }

  private setRefreshCookie(response: Response, tokens: IssuedTokens): void {
    response.cookie(this.config.auth.refreshCookieName, tokens.refreshToken, {
      httpOnly: true,
      secure: this.config.auth.cookieSecure,
      sameSite: this.config.auth.cookieSameSite,
      domain: this.config.auth.refreshCookieDomain,
      // Scoped to the refresh and logout routes, so the token is not attached
      // to every ordinary API call.
      path: `/${this.config.http.globalPrefix}/v1/auth`,
      expires: tokens.refreshTokenExpiresAt,
    });
  }

  private clearRefreshCookie(response: Response): void {
    response.clearCookie(this.config.auth.refreshCookieName, {
      httpOnly: true,
      secure: this.config.auth.cookieSecure,
      sameSite: this.config.auth.cookieSameSite,
      domain: this.config.auth.refreshCookieDomain,
      path: `/${this.config.http.globalPrefix}/v1/auth`,
    });
  }

  private toAuthResponse(
    tokens: IssuedTokens,
    profile: UserProfileResponse,
  ): AuthTokensResponse {
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: 'Bearer',
      expiresIn: tokens.accessTokenExpiresIn,
      user: profile,
    };
  }
}
