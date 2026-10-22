/**
 * Accounts and sessions (B1.6, part of the identity repository): creating
 * accounts, signing in, ending sessions and changing the password.
 * Scope rules (scope.ts):
 *
 *   createAccount      owner or admin; owners create admin/user/guest,
 *                      admins user/guest; nobody creates another owner
 *                      (S0-Q.13: no open self-registration)
 *   signIn             no actor: this is how a user actor comes to exist.
 *                      Internal system accounts, inactive or unverified
 *                      accounts and published default passwords are refused
 *                      (S0-Q.2), but only after the password matched
 *                      (S0-Q.21); the token carries token_version (H-01)
 *   endSessions        the account itself (guests too): bumps token_version,
 *                      so every token of the account stops working (F-02)
 *   changePassword     the account itself; the current password must match
 *
 * Agent runs and channel turns have no access. Password hashes never leave
 * this layer. Rate limits and lockout stay in front (routes/auth.ts).
 */

import {createHash,randomBytes} from 'node:crypto';
import {sql,one,dialect,lockName} from './sql-steps.js';
import {forUpdate} from '../db/pg/dialect.js';
import {issueChallenge,VerificationChallengeLimitError} from '../auth/verification/challenges.js';
import {factorChallengeStep,revokeFactorStep,factorRevocationOperation} from '../auth/verification/enrollment.js';
import type { Actor } from './actor.js';
import { ScopeError, requireAccount, requireAdmin } from './scope.js';
import { generateToken } from '../auth/jwt.js';
import { isPublishedDefaultPassword, isSystemAccount } from '../auth/default-accounts.js';
import type { SafeUser } from './users-store.js';
import type { User } from '../db/repositories/users.js';
import { sqliteUsersStore, type UsersStore } from './users-store.js';

/** A refused account change with the route's `{ error, message }` body. */
export class AccountError extends Error {
  constructor(readonly status: 400 | 403 | 409, readonly error: string, message: string) { super(message); }
}

export type LoginVerification={challenge:unknown;nonce:unknown;code:unknown};
const loginHash=(value:string)=>createHash('sha256').update(value).digest('hex');
export type SignInResult =
  | { status: 'verification_required'; challenge:string; nonce:string; expiresAt:number; verificationMethod:'totp'|'recovery' }
  | {status:'recovered'}
  | {status:'verification_limited'}
  | { status: 'ok'; user: SafeUser; token: string }
  | { status: 'unknown' }
  | { status: 'system' | 'inactive' | 'unverified' | 'bad_password' | 'published_password'; userId: string; username: string };

export interface AccountInput {
  email?: unknown;
  username?: unknown;
  password?: unknown;
  full_name?: unknown;
  role?: unknown;
}

export interface IdentityAuthRepository {
  /** Roles the actor may give a new account. */
  creatableRoles(actor: Actor | null | undefined): Promise<string[]>;
  createAccount(actor: Actor | null | undefined, input: AccountInput, validatePassword: (p: string) => { valid: boolean; error?: string }): Promise<SafeUser>;
  signIn(email: string, password: string, verification?:LoginVerification, mode?:'totp'|'recovery'): Promise<SignInResult>;
  /** Ends every session of the account; returns its username. */
  endSessions(actor: Actor | null | undefined): Promise<{ username?: string }>;
  /** 'ok', or 'no_user' / 'wrong_password' (route answers 401). */
  changePassword(actor: Actor | null | undefined, currentPassword: string, newPassword: string): Promise<{ status: 'ok' | 'no_user' | 'wrong_password'; username?: string; userId?: string }>;
}

/**
 * S0-Q.20: bcrypt hash (cost 12, like real accounts) of a random value nobody
 * knows. Unknown emails are compared against it so sign-in takes about the
 * same time whether or not the account exists.
 */
const DUMMY_PASSWORD_HASH = '$2a$12$2oPz4tbkVDb30X0U83ZSR.MlvXmzxfLcNJ9k7rKMFjt8pHJy5IJvW';

function accountId(actor: Actor | null | undefined): string {
  const a = requireAccount(actor);
  if (!a.userId) throw new ScopeError(401, 'Authentication required');
  return a.userId;
}

/**
 * The accounts/sessions repository over a users store (B2.2a): the same code
 * runs on SQLite (sqliteUsersStore) and PostgreSQL (pgUsersStore).
 */
export function createIdentityAuth(users: UsersStore): IdentityAuthRepository {
  const repo: IdentityAuthRepository = {
    async creatableRoles(actor) {
      const a = requireAdmin(actor);
      return a.kind === 'system' || a.role === 'owner' ? ['admin', 'user', 'guest'] : ['user', 'guest'];
    },

    async createAccount(actor, input, validatePassword) {
      const allowedRoles = await repo.creatableRoles(actor);
      const role = input.role ?? 'user';
      if (typeof role !== 'string' || !allowedRoles.includes(role)) {
        throw new AccountError(403, 'Forbidden', `You can create these roles: ${allowedRoles.join(', ')}`);
      }
      const { email, username, password, full_name } = input as Record<string, any>;
      if (!email || !username || !password) {
        throw new AccountError(400, 'Missing required fields', 'email, username, and password are required');
      }
      const strength = validatePassword(password);
      if (!strength.valid) throw new AccountError(400, 'Weak password', strength.error ?? 'Weak password');
      if (await users.findByEmail(email)) throw new AccountError(409, 'Email already exists', 'A user with this email already exists');
      if (await users.findByUsername(username)) throw new AccountError(409, 'Username already exists', 'A user with this username already exists');

      const created = await users.create({ email, username, password, full_name, role: role as 'admin' | 'user' | 'guest' });
      // The account is created by an owner/admin, who vouches for the address
      // (there is no e-mail verification flow); login requires email_verified.
      await users.markEmailVerified(created.id);
      return users.safeUser((await users.findById(created.id)) ?? created);
    },

    async signIn(email, password, verification,mode='totp') {
      // S0-Q.21: the password is checked first, for every account. A caller
      // without the right password gets 'unknown' / 'bad_password' (the route
      // answers both with the same 401 and records a failure), so account state
      // (system, inactive, unverified, published password) is only revealed to
      // someone who already knows the password. bcrypt runs once on every path.
      const given = String(password ?? '');
      const user = await users.findByEmail(email);
      if (!user) {
        await users.verifyPassword({ password_hash: DUMMY_PASSWORD_HASH } as User, given);
        return { status: 'unknown' };
      }
      const who = { userId: user.id, username: user.username };
      const hasHash = typeof user.password_hash === 'string' && user.password_hash.length > 0;
      const matches = await users.verifyPassword(hasHash ? user : ({ password_hash: DUMMY_PASSWORD_HASH } as User), given);
      if (!hasHash || !matches) return { status: 'bad_password', ...who };
      if (isSystemAccount(user.id)) return { status: 'system', ...who };
      if (user.status !== 'active') return { status: 'inactive', ...who };
      if (!user.email_verified) return { status: 'unverified', ...who };
      if (isPublishedDefaultPassword(given)) return { status: 'published_password', ...who };
      if(!['totp','recovery'].includes(mode))return {status:'bad_password',...who};
      const tokenVersion=(user as {token_version?:number}).token_version||1;
      const outcome=await sql().tx(function*(){
        yield* lockName('verification-enrollment:'+user.id);
        const d=yield* dialect();
        const current=yield* one<{token_version:number;status:string;email_verified:number}>(`SELECT token_version,status,email_verified FROM users WHERE id=?${forUpdate(d)}`,user.id);
        if(!current||Number(current.token_version)!==tokenVersion||current.status!=='active'||!Number(current.email_verified))return {kind:'refused'} as const;
        const factor=yield* one<{version:number;enabled:number}>('SELECT version,enabled FROM verification_factors WHERE user_id=?',user.id);
        if(factor&&Number(factor.enabled)===1){
          if(!verification)return {kind:'challenge',version:Number(factor.version)} as const;
          if(typeof verification.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(verification.nonce))return {kind:'refused'} as const;
          const binding={userId:user.id,purpose:mode==='recovery'?'recovery' as const:'login' as const,sessionHash:loginHash(verification.nonce),operationHash:mode==='recovery'?factorRevocationOperation(user.id,Number(factor.version),'recovery'):loginHash(JSON.stringify(['login-v1',user.id])),tokenVersion,factorVersion:Number(factor.version)};
          if(mode==='recovery')return (yield* revokeFactorStep(verification.challenge,binding,verification.code,'recovery',Date.now()))?{kind:'recovered'} as const:{kind:'refused'} as const;
          if(!(yield* factorChallengeStep(verification.challenge,binding,verification.code,'totp',Date.now())))return {kind:'refused'} as const;
        }else if(verification||mode==='recovery')return {kind:'refused'} as const;
        return {kind:'ok',token:generateToken(user.id,tokenVersion)} as const;
      });
      if(outcome.kind==='recovered')return {status:'recovered'};
      if(outcome.kind==='refused')return {status:'bad_password',...who};
      if(outcome.kind==='challenge'){
        const nonce=randomBytes(32).toString('base64url');
        try{
          const issued=await issueChallenge({userId:user.id,purpose:mode==='recovery'?'recovery':'login',sessionHash:loginHash(nonce),operationHash:mode==='recovery'?factorRevocationOperation(user.id,outcome.version,'recovery'):loginHash(JSON.stringify(['login-v1',user.id])),tokenVersion,factorVersion:outcome.version});
          return {status:'verification_required',challenge:issued.token,nonce,expiresAt:issued.expiresAt,verificationMethod:mode};
        }catch(error){if(error instanceof VerificationChallengeLimitError)return {status:'verification_limited'};throw error;}
      }
      await users.updateLastLogin(user.id);
      return {status:'ok',user:users.safeUser(user),token:outcome.token};
    },

    async endSessions(actor) {
      const id = accountId(actor);
      const user = await users.findById(id);
      await users.incrementTokenVersion(id);
      return { username: user?.username };
    },

    async changePassword(actor, currentPassword, newPassword) {
      const id = accountId(actor);
      const user = await users.findById(id);
      if (!user) return { status: 'no_user' };
      if (!(await users.verifyPassword(user, currentPassword))) return { status: 'wrong_password' };
      await users.updatePassword(user.id, newPassword);
      return { status: 'ok', userId: user.id, username: user.username };
    },
  };
  return repo;
}

export const sqliteIdentityAuth: IdentityAuthRepository = createIdentityAuth(sqliteUsersStore);
