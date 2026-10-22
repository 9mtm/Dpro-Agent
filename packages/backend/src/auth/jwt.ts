/**
 * JWT Authentication Utilities
 */

import jwt from 'jsonwebtoken';
import {randomUUID} from 'node:crypto';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { getRepositories } from '../db/index.js';
import { dbDriver } from '../db/pg/config.js';
import { pgOne } from '../db/pg/pool.js';

// SECURITY: JWT payload schema validation (M-13)
const JwtPayloadSchema = z.object({
    userId: z.string().min(1, 'User ID is required'),
    tokenVersion: z.number().int().positive().optional(),
    iat: z.number().optional(), // Issued at
    exp: z.number().optional(), // Expiration
});

type JwtPayload = z.infer<typeof JwtPayloadSchema>;

/** A signed token whose payload does not have the expected shape. */
export class JwtPayloadError extends Error {}

/**
 * Get JWT secret from environment
 * SECURITY: Lazy loading to ensure .env is loaded first
 */
function getJwtSecret(): string {
    if (!process.env.JWT_SECRET) {
        throw new Error('FATAL: JWT_SECRET is not set. It is generated into .data/secrets.env on server start (or run "agent-player setup").');
    }
    return process.env.JWT_SECRET;
}

/**
 * A refused bearer token (missing, malformed, expired, invalidated, unknown or
 * inactive user). The message always starts with "Unauthorized:" (callers and
 * handleError map that to 401). Database errors are NOT wrapped in this class:
 * the async check lets them propagate (generic 500), never a pass.
 */
export class AuthTokenError extends Error {
    override readonly name = 'AuthTokenError';
}

/** The users-row fields the token check needs. */
export interface TokenUser {
    role: string;
    status?: string | null;
    token_version?: number | null;
}

/**
 * Who the gate already verified for this request (auth/auth-gate.ts sets
 * request.authUser after the async token check: signature, expiry,
 * token_version, active status, role). Synchronous callers reuse it instead
 * of querying the database again, so they also work on PostgreSQL.
 */
function gateVerifiedUser(request: FastifyRequest): { id: string; role: string } | null {
    const u = (request as any).authUser;
    return u && typeof u.id === 'string' && u.id ? u : null;
}

/** Header + signature + payload shape. Throws AuthTokenError. */
function decodeRequestToken(request: FastifyRequest): JwtPayload {
    const authHeader = request.headers?.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new AuthTokenError('Unauthorized: Missing or invalid authorization header');
    }
    try {
        // SECURITY: Verify and validate JWT payload structure (M-13)
        return verifyToken(authHeader.substring(7));
    } catch (error: any) {
        if (error?.name === 'TokenExpiredError') throw new AuthTokenError('Unauthorized: Token expired');
        // JsonWebTokenError and its subclasses (NotBeforeError, ...) are refusals.
        if (error?.name === 'JsonWebTokenError' || error instanceof jwt.JsonWebTokenError) throw new AuthTokenError('Unauthorized: Invalid token');
        if (error instanceof JwtPayloadError) throw new AuthTokenError('Unauthorized: Invalid token');
        // Anything else (e.g. JWT_SECRET missing) is a server fault, not a refusal.
        throw error;
    }
}

/** The account checks on a loaded user row. Throws AuthTokenError. */
function checkTokenUser(decoded: JwtPayload, user: TokenUser | undefined, requireActive: boolean): void {
    if (!user) {
        throw new AuthTokenError('Unauthorized: User not found');
    }
    // SECURITY (S0-A.3): a disabled/suspended account loses access at once,
    // not when its token expires.
    if (requireActive && user.status !== undefined && user.status !== null && user.status !== 'active') {
        throw new AuthTokenError('Unauthorized: Account is not active');
    }
    // SECURITY: Verify token_version matches current user version (H-01)
    // If password was changed, token_version is incremented and old tokens are invalidated
    const tokenVersion = decoded.tokenVersion || 1; // Default to 1 for old tokens
    const userVersion = user.token_version || 1; // Default to 1 for old users
    if (tokenVersion !== userVersion) {
        throw new AuthTokenError('Unauthorized: Token invalidated (password changed)');
    }
}

/**
 * The token-check row for a user id on the configured driver (B2.2b).
 * Database errors propagate to the caller.
 */
export async function findTokenUser(userId: string): Promise<TokenUser | undefined> {
    if (dbDriver() === 'postgres') {
        return pgOne<TokenUser>('SELECT role, status, token_version FROM users WHERE id = ?', userId);
    }
    return getRepositories().users.findById(userId) as TokenUser | undefined;
}

/**
 * Async token check on the configured driver (B2.2b), used by the auth gate
 * and the async route guards. Returns the user id and its row. Refusals throw
 * AuthTokenError; a database error is rethrown unchanged.
 */
export async function verifyRequestTokenAsync(
    request: FastifyRequest,
    opts: { requireActive?: boolean } = {}
): Promise<{ userId: string; user: TokenUser }> {
    const decoded = decodeRequestToken(request);
    const user = await findTokenUser(decoded.userId);
    checkTokenUser(decoded, user, opts.requireActive !== false);
    return { userId: decoded.userId, user: user! };
}

/**
 * Extract and verify user ID from JWT token in request headers
 * SECURITY: Validates token_version to invalidate old tokens (H-01)
 * @param request Fastify request object
 * @returns User ID if valid token, throws error if invalid/missing
 */
export function getUserIdFromRequest(request: FastifyRequest): string {
    return verifyRequestToken(request, { requireActive: true });
}

/**
 * Verify the bearer token (signature, expiry, token_version). With
 * `requireActive` (the default for getUserIdFromRequest) the user must also
 * have status 'active'. route-guards.ts passes false because it checks status
 * and role itself (and answers 403 for an inactive account).
 *
 * Synchronous form for the route handlers: when the auth gate already
 * verified this request (request.authUser, active user), that result is used.
 * Otherwise (route mounted without the gate, public routes) the check runs
 * here on SQLite; on PostgreSQL there is no synchronous lookup, so it fails
 * closed (401) instead of reading the SQLite file.
 */
export function verifyRequestToken(
    request: FastifyRequest,
    opts: { requireActive?: boolean } = {}
): string {
    const verified = gateVerifiedUser(request);
    if (verified) return verified.id;

    const decoded = decodeRequestToken(request);
    if (dbDriver() === 'postgres') {
        throw new AuthTokenError('Unauthorized: Token not verified by the auth gate');
    }
    const user = getRepositories().users.findById(decoded.userId) as TokenUser | undefined;
    checkTokenUser(decoded, user, opts.requireActive !== false);
    return decoded.userId;
}

/**
 * Extract user ID from request, returns null if invalid (non-throwing version)
 * @param request Fastify request object
 * @returns User ID if valid token, null otherwise
 */
export function getUserIdFromRequestSafe(request: FastifyRequest): string | null {
    try {
        return getUserIdFromRequest(request);
    } catch {
        return null;
    }
}

/**
 * Generate JWT token for user
 * SECURITY: Includes token_version for invalidation support (H-01)
 * @param userId User ID to encode in token
 * @param tokenVersion Token version number (from user.token_version)
 * @param expiresIn Token expiration time (default: 7 days)
 * @returns JWT token string
 */
export function generateToken(userId: string, tokenVersion: number = 1, expiresIn: string = '7d'): string {
    return jwt.sign({ userId, tokenVersion }, getJwtSecret(), { expiresIn: expiresIn as jwt.SignOptions['expiresIn'], jwtid: randomUUID() });
}

/**
 * Verify JWT token with schema validation
 * SECURITY: Validates JWT payload structure using Zod (M-13)
 * @param token JWT token to verify
 * @returns Decoded and validated payload if valid, throws error if invalid
 */
export function verifyToken(token: string): JwtPayload {
    const decoded = jwt.verify(token, getJwtSecret());

    // SECURITY: Validate payload structure with Zod schema (M-13)
    const validationResult = JwtPayloadSchema.safeParse(decoded);

    if (!validationResult.success) {
        throw new JwtPayloadError(`Invalid JWT payload structure: ${validationResult.error.message}`);
    }

    return validationResult.data;
}
