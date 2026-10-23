/** Offline source declarations only. A declaration digest is neither executable integrity nor an execution grant. */
import {createHash} from 'node:crypto';
import {BUNDLED_PAPER_INSTALLATION} from './trading-paper-manifest.js';
const v1=BUNDLED_PAPER_INSTALLATION;
const declaration=Object.freeze({appId:v1.appId,implementationId:v1.implementationId,version:'1.1.0' as const,kind:v1.kind,mode:v1.mode,schemaVersion:v1.schemaVersion,schemaDigest:v1.schemaDigest,capabilities:Object.freeze([...v1.capabilities,'paper.runtime.execute'] as const)});
/** Future candidate only. Existing installer and reviewed grants intentionally continue accepting v1 only. */
export const PAPER_EXECUTION_UPGRADE_CANDIDATE=Object.freeze({...declaration,manifestDigest:createHash('sha256').update(JSON.stringify(declaration)).digest('hex')});
export const PAPER_MANIFEST_CATALOG=Object.freeze([
 Object.freeze({manifest:v1,candidate:false as const,installable:true as const,executable:false as const}),
 Object.freeze({manifest:PAPER_EXECUTION_UPGRADE_CANDIDATE,candidate:true as const,installable:false as const,executable:false as const}),
]);
/** Exact version AND digest; never latest-version fallback, aliases or optimistic compatibility. */
export function lookupPaperManifest(version:unknown,manifestDigest:unknown){
 if(typeof version!=='string'||typeof manifestDigest!=='string'||manifestDigest.length!==64||!/^[a-f0-9]{64}$/.test(manifestDigest))return null;
 return PAPER_MANIFEST_CATALOG.find(row=>row.manifest.version===version&&row.manifest.manifestDigest===manifestDigest)??null;
}

/** Explicit historical decoder support, deliberately narrower than catalog membership.
 * Candidate declarations are never admitted as installed history or provisioning authority.
 */
export function lookupSupportedPaperHistoryManifest(version:unknown,manifestDigest:unknown){
 const entry=lookupPaperManifest(version,manifestDigest);
 return entry?.manifest===v1&&entry.candidate===false? v1:null;
}
