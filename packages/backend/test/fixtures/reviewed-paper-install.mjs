import assert from 'node:assert/strict';
import {beginEnrollment,activateEnrollment} from '../../src/auth/verification/enrollment.ts';
import {decodeSecret,hotp} from '../../src/auth/verification/totp.ts';
import * as reviews from '../../src/services/trading-paper-install-review.ts';
import {BUNDLED_PAPER_INSTALLATION} from '../../src/services/trading-paper-installation.ts';

// Explicit temporary-main-database fixture: this performs the real human proof flow.
export async function enrollInstallOwner(userId, now = Date.now() - 60000) {
 const initial={userId,sessionHash:'a'.repeat(64),tokenVersion:1};
 const setup=await beginEnrollment(initial,now);
 assert.ok(setup);
 const otp=time=>hotp(decodeSecret(setup.secret),BigInt(Math.floor(time/30000)));
 const activated=await activateEnrollment(initial,otp(now),now);
 assert.equal(activated?.factorVersion,1);
 return {context:{...initial,tokenVersion:2,factorVersion:1},actor:{kind:'user',role:'owner',userId},otp};
}
export async function reviewedInstall(db, person, {now=Date.now()-30000,action='install',expectedRevision=0,capabilities=action==='install'?['paper.account.read','paper.bot.manage']:[]}={}) {
 reviews.initializePaperInstallReviews(db);
 const input={action,expectedRevision,manifestDigest:BUNDLED_PAPER_INSTALLATION.manifestDigest,capabilities};
 const staged=await reviews.stagePaperInstallReview(db,person.context,person.actor,input,now);
 assert.equal(staged.ok,true,'fixture installation review');
 const challenge=await reviews.issuePaperInstallProof(db,person.context,person.actor,staged.id,now);
 assert.ok(challenge?.token,'fixture installation challenge');
 const proof=await reviews.completePaperInstallProof(db,person.context,person.actor,staged.id,challenge.token,person.otp(now),now);
 assert.ok(proof?.receipt,'fixture installation proof');
 const applied=await reviews.applyPaperInstallReview(db,person.context,person.actor,staged.id,proof.receipt,now);
 assert.equal(applied.ok,true,'fixture reviewed installation apply');
 return {staged,proof,applied};
}
