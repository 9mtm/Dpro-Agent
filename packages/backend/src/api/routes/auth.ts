/**
 * Authentication Routes
 * Login, Register, JWT token management
 *
 * B1.6: accounts and sessions go through the identity repository
 * (repositories/identity-auth.ts) with the request's actor; the token is
 * still verified here first so the answers (and their order) stay the same.
 * Rate limits and the per-source sign-in throttle (S0-Q.20) stay in front.
 */

import { actorOf } from '../../auth/auth-gate.js';
import type { FastifyInstance } from 'fastify';
import { loginThrottle, repositories } from '../../repositories/index.js';
import { AccountError } from '../../repositories/identity-auth.js';
import { ScopeError, actorOrReply, requireAdmin, sendScopeError } from '../../repositories/scope.js';
import type { Actor } from '../../repositories/actor.js';
import { getUserIdFromRequest } from '../../auth/jwt.js';
import { handleError } from '../error-handler.js';
import { parseDeviceToken } from '../../auth/account-lockout.js';
import { logAuthEvent } from '../../services/audit-logger.js';
import { authorizeActiveRole, OWNER_OR_ADMIN } from '../../auth/route-guards.js';
import { changePasswordRateLimit, loginRateLimit, registerRateLimit } from '../rate-limit-config.js';

/** Owner/admin actor (central rule), with this route's existing 403 wording. */
function ownerOrAdmin(actor: Actor | null | undefined): Actor {
  try {
    return requireAdmin(actor);
  } catch (err) {
    if (err instanceof ScopeError && err.status === 403) throw new ScopeError(403, 'This action requires an active owner or admin account');
    throw err;
  }
}

/**
 * SECURITY: Validate password strength
 * @param password Password to validate
 * @returns Validation result with success flag and error message
 */
function validatePasswordStrength(password: string): { valid: boolean; error?: string } {
  // Minimum 12 characters
  if (password.length < 12) {
    return {
      valid: false,
      error: 'Password must be at least 12 characters long'
    };
  }

  // Check for uppercase letter
  if (!/[A-Z]/.test(password)) {
    return {
      valid: false,
      error: 'Password must contain at least one uppercase letter'
    };
  }

  // Check for lowercase letter
  if (!/[a-z]/.test(password)) {
    return {
      valid: false,
      error: 'Password must contain at least one lowercase letter'
    };
  }

  // Check for number
  if (!/[0-9]/.test(password)) {
    return {
      valid: false,
      error: 'Password must contain at least one number'
    };
  }

  // Check for special character
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    return {
      valid: false,
      error: 'Password must contain at least one special character (!@#$%^&*...)'
    };
  }

  return { valid: true };
}

export async function authRoutes(fastify: FastifyInstance) {
  const identity = () => repositories.identity;

  // SECURITY (S0-Q.22): route limits are keyed by email / account, never by
  // the shared loopback IP alone; sign-in only has a CPU flood guard (see
  // ../rate-limit-config.ts). The sign-in throttle (S0-Q.20) does the rest.

  /**
   * POST /api/auth/register
   * Create a user account. SECURITY (S0-Q.13): there is no open
   * self-registration. Only an active owner/admin can create accounts (the
   * first owner comes from the setup wizard). The new user gets no token here;
   * they sign in with /api/auth/login. Owners may create admin/user/guest
   * accounts, admins only user/guest; nobody creates another owner here.
   * Team invitations still work: the invitee signs in to the account created
   * here and accepts with /api/team/invitations/:token/accept.
   */
  fastify.post('/api/auth/register', {
    config: { rateLimit: registerRateLimit }
  }, async (request, reply) => {
    // Token check with the existing answers (401 bad token, 403 inactive or
    // not owner/admin), then the central rule on the request's actor.
    if (authorizeActiveRole(request, reply, OWNER_OR_ADMIN) === null) return reply;
    const creator = actorOrReply(reply, actorOf(request), ownerOrAdmin);
    if (creator === null) return reply;

    let user;
    try {
      user = await identity().createAccount(creator, (request.body ?? {}) as Record<string, unknown>, validatePasswordStrength);
    } catch (err) {
      if (err instanceof AccountError) return reply.code(err.status).send({ error: err.error, message: err.message });
      if (err instanceof ScopeError) return sendScopeError(reply, err);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, err, 'internal', '[Auth] Registration failed');
    }

    // SECURITY: Log successful registration (L-02)
    logAuthEvent('auth.register', request, creator.userId, user.username, true);

    // Return the new user (without password). No token: the caller is the
    // owner/admin, not the new user.
    return reply.code(201).send({ user });
  });

  /**
   * POST /api/auth/login
   * Login with email/password
   */
  fastify.post('/api/auth/login', {
    config: { rateLimit: loginRateLimit }
  }, async (request, reply) => {
    reply.header('Cache-Control','no-store');
    const body = (request.body ?? {}) as any;
    const { email, password } = body;
    // S0-Q.20: optional device token from an earlier sign-in (never logged).
    // Malformed values are treated as absent.
    const deviceToken = parseDeviceToken(body.deviceToken);

    // Validation
    if (!email || !password) {
      return reply.code(400).send({
        error: 'Missing credentials',
        message: 'email and password are required'
      });
    }

    // Client IP and User-Agent for attempt tracking. No trustProxy: this is the
    // socket address (127.0.0.1 behind a proxy). Remote exposure needs
    // trustProxy set to the known proxy hop.
    const ipAddress = request.ip || 'unknown';
    const userAgent = request.headers['user-agent'];

    // SECURITY (M-02, S0-Q.20): throttle per source, never lock the account.
    // Checked before the password and without looking at the account, so the
    // reply is the same for known and unknown emails.
    const throttle = await loginThrottle.check(String(email), ipAddress, deviceToken);
    if (throttle.throttled) {
      const minutes = Math.max(1, Math.ceil(throttle.retryAfterSeconds / 60));
      return reply.code(429).header('Retry-After', String(throttle.retryAfterSeconds)).send({
        error: 'Too many attempts',
        code: 'rate_limited',
        message: `Too many failed sign-in attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
      });
    }

    try {
      const denied = { error: 'Forbidden', code: 'account_inactive', message: 'Account access denied' };
      const invalid = { error: 'Unauthorized', code: 'invalid_credentials', message: 'Invalid email or password' };

      const result = await identity().signIn(email, password, body.verification,body.recovery===true?'recovery':'totp');
      switch (result.status) {
        // S0-Q.21: 'unknown' and 'bad_password' must look exactly alike (same
        // 401 body, a failure row, bcrypt ran). signIn only reports account
        // state (system / inactive / unverified / published password) after
        // the password matched.
        case 'unknown':
          // SECURITY: Track + log the failed attempt (M-02, L-02); generic message (M-12)
          await loginThrottle.failed(email, ipAddress, userAgent, deviceToken);
          logAuthEvent('auth.login.failed', request, undefined, email, false, 'Invalid credentials');
          return reply.code(401).send(invalid);
        case 'bad_password':
          await loginThrottle.failed(email, ipAddress, userAgent, deviceToken);
          logAuthEvent('auth.login.failed', request, result.userId, result.username, false, 'Invalid password');
          return reply.code(401).send(invalid);
        // The refusals below come with the right password, but they still count
        // as failures for the throttle: no session is created, and otherwise a
        // refused account would be an unthrottled password oracle. (A published
        // password is public anyway, so it gets the same treatment.)
        case 'system':
          // SECURITY (S0-Q.2): internal system accounts can never log in
          await loginThrottle.failed(email, ipAddress, userAgent, deviceToken);
          logAuthEvent('auth.login.failed', request, result.userId, result.username, false, 'System account login refused');
          return reply.code(403).send(denied);
        case 'inactive':
        case 'unverified':
          // SECURITY: generic "Forbidden" for account status / unverified e-mail (M-09, M-12)
          await loginThrottle.failed(email, ipAddress, userAgent, deviceToken);
          logAuthEvent('auth.login.failed', request, result.userId, result.username, false, 'Account not active');
          return reply.code(403).send(denied);
        case 'published_password':
          // SECURITY (S0-Q.2): passwords published in the source (old seed/demo accounts) are refused
          await loginThrottle.failed(email, ipAddress, userAgent, deviceToken);
          logAuthEvent('auth.login.failed', request, result.userId, result.username, false, 'Published default password refused');
          return reply.code(403).send({
            error: 'Forbidden',
            code: 'published_password',
            message: 'This account uses a default password and is disabled. Reset the password from the CLI.'
          });
        case 'recovered':
          return {requiresSignIn:true,recovered:true};
        case 'verification_limited':
          return reply.header('Retry-After','300').code(429).send({error:'Too many verification challenges',code:'verification_limited'});
        case 'verification_required':
          return {verificationRequired:true,challenge:result.challenge,nonce:result.nonce,expiresAt:result.expiresAt,verificationMethod:result.verificationMethod};
        case 'ok':
          // SECURITY: Track successful login and clear failed attempts (M-02); log it (L-02)
          const newDeviceToken = await loginThrottle.succeeded(email, ipAddress, userAgent, deviceToken);
          logAuthEvent('auth.login', request, result.user.id, result.user.username, true);
          // The token carries token_version for invalidation support (H-01).
          // deviceToken (S0-Q.20): rotated on every sign-in; the client keeps
          // it and sends it back on the next sign-in.
          return { user: result.user, token: result.token, deviceToken: newDeviceToken };
      }
    } catch (error: any) {
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Auth] Login failed');
    }
  });

  /**
   * GET /api/auth/me
   * Get current user (requires authentication)
   */
  fastify.get('/api/auth/me', async (request, reply) => {
    // Get token from Authorization header
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing or invalid Authorization header'
      });
    }

    try {
      // SECURITY: Use centralized JWT verification (M-06). S0-Q.9: also checks
      // token_version, and only active accounts count as signed in (the Next.js
      // server verifies its callers through this endpoint).
      getUserIdFromRequest(request);
    } catch (error: any) {
      // SECURITY: Standardize error messages (M-12)
      if (error.name === 'TokenExpiredError') {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Session expired'
        });
      }

      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid session'
      });
    }

    let user = null;
    try {
      user = await identity().self(actorOf(request));
    } catch (err) {
      if (!(err instanceof ScopeError)) throw err;
    }
    if (!user) {
      // SECURITY: Use "Unauthorized" for consistency (M-12)
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid or expired session'
      });
    }

    // Return user (without password)
    return { user };
  });

  /**
   * POST /api/auth/logout
   * End the caller's session (F-02). The token must still be valid; the user's
   * token_version is bumped, so this token and every other token issued to the
   * user are refused from now on (all devices are signed out).
   */
  fastify.post('/api/auth/logout', async (request, reply) => {
    const invalidSession = () => reply.code(401).send({
      error: 'Unauthorized',
      message: 'Invalid session'
    });
    try {
      getUserIdFromRequest(request);
    } catch {
      return invalidSession();
    }

    try {
      const actor = actorOf(request);
      const { username } = await identity().endSessions(actor);
      logAuthEvent('auth.logout', request, actor?.userId, username, true);
      return { success: true };
    } catch (error: any) {
      if (error instanceof ScopeError) return invalidSession();
      return handleError(reply, error, 'internal', '[Auth] Logout failed');
    }
  });

  /**
   * POST /api/auth/change-password
   * Change user password (requires authentication)
   */
  fastify.post('/api/auth/change-password', {
    config: { rateLimit: changePasswordRateLimit }
  }, async (request, reply) => {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing or invalid Authorization header'
      });
    }

    const invalidSession = () => reply.code(401).send({
      error: 'Unauthorized',
      message: 'Invalid session'
    });
    try {
      // F-02: includes token_version, so a logged-out token cannot change the password.
      getUserIdFromRequest(request);
    } catch {
      return invalidSession();
    }
    const { currentPassword, newPassword } = (request.body ?? {}) as any;

    if (!currentPassword || !newPassword) {
      return reply.code(400).send({
        error: 'Missing fields',
        message: 'currentPassword and newPassword are required'
      });
    }

    // SECURITY: Validate new password strength
    const passwordValidation = validatePasswordStrength(newPassword);
    if (!passwordValidation.valid) {
      return reply.code(400).send({
        error: 'Weak password',
        message: passwordValidation.error
      });
    }

    try {
      const result = await identity().changePassword(actorOf(request), currentPassword, newPassword);
      // SECURITY: Use "Unauthorized" for consistency (M-12)
      if (result.status === 'no_user') return invalidSession();
      if (result.status === 'wrong_password') {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Current password is incorrect'
        });
      }

      // SECURITY: Log password change (L-02)
      logAuthEvent('auth.password.change', request, result.userId, result.username, true);

      return {
        success: true,
        message: 'Password updated successfully'
      };
    } catch (error: any) {
      if (error instanceof ScopeError) return invalidSession();
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Auth] Password change failed');
    }
  });

  /**
   * GET /api/auth/stats
   * Get user statistics (for dashboard)
   */
  fastify.get('/api/auth/stats', async (request, reply) => {
    // SECURITY: Require authentication (M-15)
    getUserIdFromRequest(request);

    // B1-core: identity repository (member accounts only).
    let counts: Record<string, number>;
    try {
      counts = await repositories.identity.countByRole(actorOf(request));
    } catch (err) { return sendScopeError(reply, err); }

    return {
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      byRole: counts
    };
  });
}
