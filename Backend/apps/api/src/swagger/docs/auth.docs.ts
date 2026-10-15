import { applyDecorators } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  BadRequestResponse,
  ConflictResponse,
  TooManyRequestsResponse,
  UnauthorizedResponse,
} from '../shared/responses';
import { ErrorCode } from '../../common/errors/api-error';
import {
  ChangePasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  UpdateProfileDto,
} from '../../modules/auth/dto/auth.dto';
import {
  AuthTokensResponse,
  MessageResponse,
  UserProfileResponse,
} from '../../modules/auth/dto/auth.response';

/**
 * OpenAPI documentation for /api/v1/auth/*.
 *
 * Token model, documented once here and referenced by the operations below:
 *
 *   • Access token — short-lived JWT (15 min default), sent as
 *     `Authorization: Bearer <token>`. Verified statelessly, but the user row
 *     is re-read per request so a suspended account stops working at once.
 *
 *   • Refresh token — long-lived (14 days default). Returned in the body for
 *     non-browser clients and set as an HttpOnly, SameSite cookie scoped to
 *     /api/v1/auth. Browsers should rely on the cookie: a token in JS-readable
 *     storage is reachable by any XSS on the page.
 *
 *   • Rotation — every refresh invalidates the presented token and issues a
 *     new one. Presenting an already-rotated token is treated as theft and
 *     revokes the whole session family (TOKEN_REUSED).
 *
 * Email verification is NOT required to register or sign in.
 */

const REFRESH_COOKIE_NOTE =
  'Browsers: the refresh token is read from the HttpOnly `bg_rt` cookie and ' +
  'the request body may be empty. Non-browser clients: pass `refreshToken` ' +
  'in the body.';

export const AuthDocs = {
  register: () =>
    applyDecorators(
      ApiOperation({
        summary: 'Create an account',
        description: [
          'Registers a new user and returns an authenticated session.',
          '',
          '**No email verification is required** — the account is ACTIVE',
          'immediately. This is deliberate: the prototype must be usable with',
          'no mail provider configured.',
          '',
          '**Role**: self-registration always creates a `LAB_TECHNICIAN`.',
          'A `role` field in the request body is rejected outright, so',
          'privilege cannot be self-assigned. Elevation is an administrative',
          'action on the membership endpoints.',
          '',
          '**Laboratory**: pass `laboratoryCode` to join an existing',
          'laboratory as a technician. Omit it to register without one; an',
          'administrator can add the user afterwards.',
          '',
          '**Password**: minimum 12 characters. Length is the only rule —',
          'there are no composition requirements. Stored with Argon2id',
          '(19 MiB, t=2, p=1).',
        ].join('\n'),
      }),
      ApiBody({
        type: RegisterDto,
        examples: {
          withLaboratory: {
            summary: 'Join an existing laboratory',
            value: {
              email: 'new.technician@laboratory.test',
              password: 'correct-horse-battery-staple',
              fullName: 'Chidi Nwosu',
              jobTitle: 'Analytical Technician',
              laboratoryCode: 'DEMO-LAB-01',
            },
          },
          withoutLaboratory: {
            summary: 'Register without a laboratory',
            value: {
              email: 'independent@laboratory.test',
              password: 'a-sufficiently-long-passphrase',
              fullName: 'Aisha Mohammed',
            },
          },
        },
      }),
      ApiCreatedResponse({
        description:
          'Account created. The refresh token is also set as an HttpOnly cookie.',
        type: AuthTokensResponse,
      }),
      BadRequestResponse('Request validation failed', [
        'password must be at least 12 characters',
      ]),
      ConflictResponse('An account with this email address already exists'),
      TooManyRequestsResponse(),
    ),

  login: () =>
    applyDecorators(
      ApiOperation({
        summary: 'Sign in',
        description: [
          'Exchanges credentials for an access token and a refresh token.',
          '',
          '**Account enumeration**: an unknown email and a wrong password',
          'produce an identical `INVALID_CREDENTIALS` response, and both take',
          'comparable time — an unknown address is still verified against a',
          'dummy hash so the rejection cannot be timed.',
          '',
          '**Lockout**: 8 consecutive failures lock the account for 15',
          'minutes, reported as 403 `ACCOUNT_SUSPENDED`. A successful sign-in',
          'clears the counter.',
        ].join('\n'),
      }),
      ApiBody({
        type: LoginDto,
        examples: {
          seededTechnician: {
            summary: 'Seeded demonstration technician',
            description:
              'Password comes from SEED_TECHNICIAN_PASSWORD, printed once by ' +
              '`npm run db:seed`.',
            value: {
              email: 'technician@breadguard.test',
              password: '<printed by the seed script>',
            },
          },
        },
      }),
      ApiOkResponse({
        description: 'Authenticated.',
        type: AuthTokensResponse,
      }),
      UnauthorizedResponse(
        'Email or password is incorrect',
        ErrorCode.INVALID_CREDENTIALS,
      ),
      TooManyRequestsResponse(),
    ),

  refresh: () =>
    applyDecorators(
      ApiOperation({
        summary: 'Rotate the session',
        description: [
          'Exchanges a valid refresh token for a new access/refresh pair.',
          '',
          REFRESH_COOKIE_NOTE,
          '',
          '**Rotation is mandatory**: the presented token is revoked as part',
          'of this call. Store the returned token (or let the cookie be',
          'replaced) — the old one will not work again.',
          '',
          '**Reuse detection**: presenting a token that was already rotated',
          'means it leaked. The server revokes every token in that session',
          'family and returns 401 `TOKEN_REUSED`. This signs out the',
          'legitimate user too, which is the intended trade-off.',
        ].join('\n'),
      }),
      ApiBody({ type: RefreshDto, required: false }),
      ApiHeader({
        name: 'Cookie',
        required: false,
        description: 'bg_rt=<refresh token> — set automatically by browsers.',
      }),
      ApiOkResponse({
        description: 'A new token pair was issued.',
        type: AuthTokensResponse,
      }),
      UnauthorizedResponse(
        'This session has been invalidated. Please sign in again.',
        ErrorCode.TOKEN_REUSED,
      ),
      TooManyRequestsResponse(),
    ),

  logout: () =>
    applyDecorators(
      ApiOperation({
        summary: 'Sign out',
        description: [
          'Revokes the presented refresh token and clears the refresh cookie.',
          '',
          'Idempotent, and always returns 200 — calling it with a missing or',
          'already-revoked token is not an error and reveals nothing about',
          'whether that token was valid.',
          '',
          'Note that any already-issued access token remains valid until it',
          'expires (15 minutes by default). To revoke access immediately,',
          'change the password, which bumps the token version.',
        ].join('\n'),
      }),
      ApiOkResponse({ description: 'Signed out.', type: MessageResponse }),
    ),

  me: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Get the current user',
        description:
          'Returns the authenticated user together with their laboratory ' +
          'memberships and the capability list their role grants. Clients ' +
          'should drive navigation from `permissions` rather than hard-coding ' +
          'role names.',
      }),
      ApiOkResponse({ type: UserProfileResponse }),
      UnauthorizedResponse(),
    ),

  updateProfile: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Update your own profile',
        description:
          "Updates the caller's display name and job title. Email, role and " +
          'account status are not editable here — they are not accepted in ' +
          'the body at all.',
      }),
      ApiBody({ type: UpdateProfileDto }),
      ApiOkResponse({ type: UserProfileResponse }),
      BadRequestResponse(),
      UnauthorizedResponse(),
    ),

  changePassword: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Change your password',
        description: [
          'Requires the current password.',
          '',
          '**Every session is terminated**, including the one making this',
          "call: all refresh tokens are revoked and the user's token version",
          'is incremented, which immediately invalidates every outstanding',
          'access token. The client must sign in again.',
        ].join('\n'),
      }),
      ApiBody({ type: ChangePasswordDto }),
      ApiOkResponse({
        description: 'Password changed; all sessions signed out.',
        type: MessageResponse,
      }),
      BadRequestResponse('The new password must differ from the current one'),
      UnauthorizedResponse(
        'Current password is incorrect',
        ErrorCode.INVALID_CREDENTIALS,
      ),
      TooManyRequestsResponse(),
    ),
};
