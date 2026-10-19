// Wire contract for importing memories from other agents on this computer
// (MEM-IMPORT-01/02), shared by the browser client and the local bridge. Owner only.

const ID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : null);
const n = x => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
export const LOCAL_IMPORT_PATH = '/api/memory/import/local';
export const MAX_IMPORT_SESSIONS = 400;
export const LOCAL_SOURCES = ['claude-code', 'codex', 'antigravity', 'gemini-cli'];

export function localImportPath(path) {
  if (path === LOCAL_IMPORT_PATH) return { kind: 'local' };
  if (path === LOCAL_IMPORT_PATH + '/automatic') return { kind: 'automatic' };
  if (path === LOCAL_IMPORT_PATH + '/documents') return { kind: 'documents' };
  const document = /^\/api\/memory\/import\/local\/documents\/([a-f0-9]{32})$/.exec(path);
  if (document) return { kind: 'document', id: document[1] };
  const preview = /^\/api\/memory\/import\/local\/sessions\/([^/?#]+)$/.exec(path);
  if (preview) return ID.test(preview[1]) ? { kind: 'preview', id: preview[1] } : null;
  const m = /^\/api\/memory\/import\/local\/jobs\/([^/?#]+)(\/(resume|pause))?$/.exec(path);
  return m && UUID.test(m[1]) ? { kind: m[3] ?? 'job', id: m[1] } : null;
}
export function localImportRoute(path) { return localImportPath(path) !== null; }

export function allowedLocalImport(method, path, body) {
  const p = localImportPath(path);
  if (!p) return false;
  if(p.kind==='automatic')return (method==='GET'&&body===undefined)||(method==='PUT'&&record(body)&&Object.keys(body).length===2&&typeof body.enabled==='boolean'&&[15,30,60].includes(body.intervalMinutes));
  if (p.kind === 'documents' && method === 'POST' && record(body) && Object.keys(body).every(k=>k==='auto'||k==='cursor') && body.auto === true && (body.cursor===undefined||(typeof body.cursor==='string'&&ID.test(body.cursor)))) return true;
  if (p.kind === 'documents') return method === 'POST' && record(body) && Object.keys(body).length === 1 && Array.isArray(body.roots) && body.roots.length > 0 && body.roots.length <= 8 && body.roots.every(r => typeof r === 'string' && r.startsWith('/') && r.length <= 2048 && !r.includes('\0'));
  if (method === 'GET') return !['resume', 'pause'].includes(p.kind) && body === undefined;
  if (p.kind === 'resume' || p.kind === 'pause') return method === 'POST' && body === undefined;
  return p.kind === 'local' && method === 'POST' && record(body) && Object.keys(body).length === 1 && Array.isArray(body.sessionIds)
    && body.sessionIds.length >= 1 && body.sessionIds.length <= MAX_IMPORT_SESSIONS && body.sessionIds.every(x => typeof x === 'string' && ID.test(x)) && new Set(body.sessionIds).size === body.sessionIds.length;
}

function job(x) {
  if (!record(x) || typeof x.id !== 'string' || !UUID.test(x.id)) return null;
  return { id: x.id, total: n(x.total), done: n(x.done), proposed: n(x.proposed), errors: n(x.errors), status: ['running', 'done', 'error', 'paused'].includes(x.status) ? x.status : 'error', notice: str(x.notice, 300), ...(x.automatic === true ? { automatic: true } : {}) };
}
const CODES = { 400: ['invalid_input'], 403: ['not_loopback', 'forbidden'], 404: ['not_found'], 409: ['import_running', 'document_changed'] };
/** Reviewed fields only (stable when applied twice). */
export function localImportResponse(path, status, body) {
  const p = localImportPath(path);
  if (!p) throw Error('protocol');
  if (status !== 200 && status !== 202) { const code = record(body) ? body.code : undefined; return (CODES[status] ?? []).includes(code) ? { code } : null; }
  if (!record(body)) throw Error('protocol');
  if(p.kind==='automatic'){
    const s=body.settings;if(status!==200||!record(s)||typeof s.enabled!=='boolean'||![15,30,60].includes(s.intervalMinutes)||!['idle','scanning','importing','review','error'].includes(s.status))throw Error('protocol');
    return {settings:{enabled:s.enabled,intervalMinutes:s.intervalMinutes,nextRun:n(s.nextRun),lastRun:s.lastRun===null?null:n(s.lastRun),status:s.status,lastImported:n(s.lastImported),lastProposed:n(s.lastProposed),notice:str(s.notice,300)??''}};
  }
  if (p.kind === 'documents') {
    if (status !== 200 || !Array.isArray(body.documents) || body.documents.length > 400) throw Error('protocol');
    if(body.nextCursor!==undefined&&body.nextCursor!==null&&(typeof body.nextCursor!=='string'||!ID.test(body.nextCursor)))throw Error('protocol');
    return {limited:body.limited===true,scanned:n(body.scanned),nextCursor:body.nextCursor??null,documents:body.documents.map(d=>{
      if(!record(d)||!ID.test(d.id)||typeof d.root!=='string'||d.root.length>2048||typeof d.relative!=='string'||d.relative.length>2048)throw Error('protocol');
      return {id:d.id,root:d.root,relative:d.relative,bytes:n(d.bytes),updatedAt:str(d.updatedAt,40)??'',imported:d.imported===true};
    })};
  }
  if(p.kind==='document') {
    if(status!==200||body.id!==p.id||typeof body.name!=='string'||body.name.length>2048||typeof body.text!=='string'||body.text.length>20000)throw Error('protocol');
    return {id:p.id,name:body.name,text:body.text,truncated:body.truncated===true};
  }
  if (p.kind === 'preview') {
    if (status !== 200 || body.id !== p.id || !LOCAL_SOURCES.includes(body.source) || !Array.isArray(body.messages) || body.messages.length > 20) throw Error('protocol');
    const messages = body.messages.map(m => { if (!record(m) || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string' || m.text.length > 2000) throw Error('protocol'); return { role: m.role, text: m.text }; });
    if (messages.reduce((n,m) => n + m.text.length, 0) > 20000) throw Error('protocol');
    return { id: p.id, source: body.source, messages, truncated: body.truncated === true };
  }
  if (p.kind === 'job' || p.kind === 'resume' || p.kind === 'pause' || status === 202) { const j = job(body.job); if (!j) throw Error('protocol'); return { job: j }; }
  if (!Array.isArray(body.sessions)) throw Error('protocol');
  const j = job(body.job);
  return { archive: str(body.archive, 200) ?? '', ...(j ? { job: j } : {}),
    sessions: body.sessions.slice(0, 400).filter(s => record(s) && typeof s.id === 'string' && ID.test(s.id) && LOCAL_SOURCES.includes(s.source)).map(s => ({
      id: s.id, source: s.source, cwd: str(s.cwd, 1024), title: str(s.title, 200) ?? '', startedAt: str(s.startedAt, 40), updatedAt: str(s.updatedAt, 40) ?? '', bytes: n(s.bytes), turns: n(s.turns),
      imported: record(s.imported) ? { importedAt: str(s.imported.importedAt, 40) ?? '', proposed: n(s.imported.proposed) } : null })) };
}
