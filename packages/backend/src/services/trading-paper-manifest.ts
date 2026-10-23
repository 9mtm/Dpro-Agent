/** Immutable original bundled declaration. Digest covers declaration bytes, not executable artifacts. */
import {createHash} from 'node:crypto';
import {PAPER_BUNDLE_SCHEMA} from './trading-paper-bundle-schema.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const capabilities=Object.freeze(['paper.account.read','paper.bot.manage'] as const);
const declaration=Object.freeze({appId:'trading',implementationId:PAPER_BUNDLE_SCHEMA.implementationId,version:'1.0.0',kind:'builtin',mode:'paper',schemaVersion:1,schemaDigest:PAPER_BUNDLE_SCHEMA.digest,capabilities});
/** Declaration integrity only: this is not a signature or hash of executable artifact bytes. */
export const BUNDLED_PAPER_INSTALLATION=Object.freeze({...declaration,manifestDigest:sha(JSON.stringify(declaration))});
