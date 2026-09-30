import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// Side-effect import: @fastify/cookie augments FastifyRequest/FastifyReply with
// cookies/setCookie/clearCookie via declaration merging, which only applies if the module
// is actually imported here.
import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../../core/config/env.schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { DemoModeGuard } from '../../common/guards/demo-mode.guard';
import { Throttle, ThrottleGuard } from '../../common/guards/throttle.guard';
import { AuthService } from './auth.service';
import type { AuthUser, TokenPair } from './auth.types';
import { ChangePasswordDto, LoginDto } from './dto/auth.dto';

/** The refresh token never reaches JavaScript: httpOnly, and scoped to the auth routes. */
const REFRESH_COOKIE = 'bt_refresh';
const REFRESH_PATH = '/api/auth';

@Controller('auth')
export class AuthController {
  private readonly secure: boolean;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<Env, true>,
  ) {
    // Secure cookies over plain HTTP are silently dropped, which would break local development
    // behind XAMPP; production is expected to terminate TLS.
    this.secure = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle({ name: 'login', subjectFrom: 'username' })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.login(dto.username, dto.password, this.contextOf(request));
    this.setRefreshCookie(reply, result.tokens, dto.remember ?? true);
    return this.body(result.tokens, result.user);
  }

  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle({ name: 'refresh' })
  @Post('refresh')
  async refresh(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = this.readRefreshCookie(request);
    const result = await this.auth.refresh(token ?? '', this.contextOf(request));
    this.setRefreshCookie(reply, result.tokens, true);
    return this.body(result.tokens, result.user);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(this.readRefreshCookie(request));
    void reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Post('password')
  @UseGuards(ThrottleGuard)
  @Throttle({ name: 'password', limit: 5 })
  @HttpCode(204)
  async changePassword(@CurrentUser('id') userId: number, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(userId, dto.currentPassword, dto.newPassword);
  }

  /**
   * The clickable account cards the login page shows. DEMO_MODE only — otherwise this is a
   * user directory served to anonymous callers.
   */
  @Public()
  @UseGuards(DemoModeGuard)
  @Get('demo-users')
  demoUsers() {
    return this.auth.demoUsers();
  }

  private body(tokens: TokenPair, user: AuthUser) {
    // The refresh token is intentionally absent: it lives only in the httpOnly cookie.
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, user };
  }

  private contextOf(request: FastifyRequest) {
    const agent = request.headers['user-agent'];
    return {
      ...(agent ? { userAgent: agent } : {}),
      ...(request.ip ? { ip: request.ip } : {}),
    };
  }

  private readRefreshCookie(request: FastifyRequest): string | undefined {
    return request.cookies[REFRESH_COOKIE];
  }

  private setRefreshCookie(reply: FastifyReply, tokens: TokenPair, remember: boolean): void {
    void reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: REFRESH_PATH,
      // Without `remember` the cookie is a session cookie: it dies with the browser, while the
      // server-side token keeps its own expiry either way.
      ...(remember ? { expires: tokens.refreshExpiresAt } : {}),
    });
  }
}
