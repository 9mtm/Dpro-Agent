// Shared browser/bridge contract for the existing owner-only approval API.
const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export function approvalPath(path) {
  if (path === '/api/approvals?status=pending') return { kind: 'list' };
  const m = /^\/api\/approvals\/([^/?#]+)(?:\/(approve|deny))?$/.exec(path);
  return m && uuid(m[1]) ? { kind: m[2] || 'detail', id: m[1] } : null;
}
export function allowedApproval(method, path, body) {
  const p = approvalPath(path); if (!p) return false;
  if (method === 'GET') return body === undefined && ['list', 'detail'].includes(p.kind);
  if (method !== 'POST') return false;
  if (p.kind === 'deny') return body === undefined;
  return p.kind === 'approve' && record(body) && Object.keys(body).length === 1 && hash(body.paramsHash);
}
function project(a, detail) {
  if (!record(a) || !uuid(a.id) || !['pending', 'approved', 'denied', 'executed', 'failed', 'expired'].includes(a.status)
    || typeof a.toolName !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(a.toolName)) throw Error('Invalid approval');
  const safe = { id: a.id, status: a.status, toolName: a.toolName, sessionId: uuid(a.sessionId) ? a.sessionId : null };
  if (!detail) return safe;
  // Parameters must be complete, never a truncated list preview. The backend
  // masks secrets; the hash binds approval to the exact hidden + shown values.
  if (!Object.hasOwn(a, 'params') || JSON.stringify(a.params).length > 32000) throw Error('Approval too large to review');
  return { ...safe, params: a.params, paramsHash: hash(a.paramsHash) ? a.paramsHash : null,
    maskedFields: Array.isArray(a.maskedFields) ? a.maskedFields.filter(x => typeof x === 'string').slice(0, 200) : [] };
}
export function approvalResponse(path, status, body) {
  const p = approvalPath(path); if (!p) throw Error('Invalid approval route');
  if (status !== 200) return null;
  if (!record(body)) throw Error('Invalid approval response');
  if (p.kind === 'list') {
    if (!Array.isArray(body.approvals) || body.approvals.length > 500) throw Error('Invalid approval list');
    return { approvals: body.approvals.map(a => project(a, false)) };
  }
  const approval = project(body.approval, p.kind === 'detail');
  if (approval.id !== p.id) throw Error('Approval identity mismatch');
  return { approval };
}
