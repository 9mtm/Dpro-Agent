// Wire projection for the bounded memory review routes. Text is never sanitized.
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const bad = () => { throw Error('Invalid memory response'); };
const obj = x => record(x) ? x : bad();
const text = (x, max = 50000) => typeof x === 'string' && x.length <= max ? x : bad();
const int = x => Number.isSafeInteger(x) && x >= 0 ? x : bad();
const nullable = (x, fn = text) => x === null ? null : fn(x);
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x) ? x : bad();
const id = x => typeof x === 'string' && /^[A-Za-z0-9_.@-]{1,200}$/.test(x) && !x.includes('..') ? x : bad();
const proposalId = x => typeof x === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(x) ? x : bad();
const timestamp = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(x) && Number.isFinite(Date.parse(x)) ? x : bad();
const list = (x, fn, max = 500) => Array.isArray(x) && x.length <= max ? x.map(v => fn(v)) : bad();
const exact = (x, keys) => { obj(x); if (Object.keys(x).length !== keys.length || keys.some(k => !Object.hasOwn(x, k))) bad(); };
function drawer(x, drawerId) {
  obj(x);
  const kind = text(x.kind, 20);
  const key = x.key === undefined ? undefined : text(x.key, 128);
  const d = key === undefined ? kind : `${kind}:${key}`;
  if (d !== drawerId || !(d === 'owner' || d === 'experience' || /^project:[a-z0-9][a-z0-9_-]{0,63}$/.test(d) || (/^(task|people):[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(d) && !d.includes('..')))) bad();
  return { kind, ...(key === undefined ? {} : { key }) };
}
function entry(x) {
  exact(x, ['type', 'importance', 'content']);
  if (typeof x.type !== 'string' || !/^[a-z][a-z_-]{0,31}$/.test(x.type) || int(x.importance) < 1 || x.importance > 10) bad();
  return { type: x.type, importance: x.importance, content: text(x.content) };
}
function change(x) {
  obj(x);
  if (x.op === 'add') { exact(x, ['op', 'after']); return { op: 'add', after: entry(x.after) }; }
  if (x.op === 'update') { exact(x, ['op', 'id', 'before', 'after']); return { op: 'update', id: id(x.id), before: entry(x.before), after: entry(x.after) }; }
  if (x.op === 'delete') { exact(x, ['op', 'id', 'before']); return { op: 'delete', id: id(x.id), before: entry(x.before) }; }
  return bad();
}
function summary(x) {
  obj(x);
  if (!['pending', 'approved', 'rejected', 'stale', 'cancelled'].includes(x.status) || !['file', 'upload', 'learning', 'agent', 'import'].includes(x.source)) bad();
  return {
    id: proposalId(x.id), userId: id(x.userId), agentId: id(x.agentId), drawerId: text(x.drawerId, 150), drawer: drawer(x.drawer, x.drawerId),
    reviewHash: hash(x.reviewHash), baseHash: hash(x.baseHash), baseRevision: int(x.baseRevision), status: x.status, source: x.source,
    note: nullable(x.note), createdBy: text(x.createdBy), createdAt: timestamp(x.createdAt), decidedBy: nullable(x.decidedBy),
    decidedAt: nullable(x.decidedAt, timestamp), appliedRevision: nullable(x.appliedRevision, int),
    reasons: list(x.reasons, text), importBatchId: nullable(x.importBatchId),
    // CORE-MEM-CONFLICT: only on a conflict proposal.
    ...(x.conflictWith ? { conflictWith: id(x.conflictWith) } : {}),
    ...(x.decision ? { decision: ['keep_new', 'keep_old', 'keep_both'].includes(x.decision) ? x.decision : bad() } : {}),
  };
}
function proposal(x) {
  const s = summary(x), changes = list(x.changes, change);
  if (s.status === 'pending' && !changes.length) bad();
  return { ...s, changes };
}
function memoryResponse(target, body) {
  obj(body);
  if (target.startsWith('/api/memory/files/')) {
    return { drawer: drawer(body.drawer, body.drawerId), drawerId: text(body.drawerId, 150), agentId: id(body.agentId), revision: int(body.revision), hash: hash(body.hash), count: int(body.count), content: text(body.content, 2000000) };
  }
  if (target === '/api/memory/proposals' || target === '/api/memory/proposals?status=pending') {
    return { proposals: list(body.proposals, x => {
      const s = summary(x); const c = obj(x.counts);
      return { ...s, counts: { add: int(c.add), update: int(c.update), delete: int(c.delete) } };
    }, 200) };
  }
  if (/\/approve$/.test(target)) {
    const p = proposal(body.proposal), a = obj(body.applied);
    return { proposal: p, revision: int(body.revision), applied: { added: list(a.added, id), updated: list(a.updated, id), deleted: list(a.deleted, id) } };
  }
  if (/^\/api\/memory\/proposals\/[A-Za-z0-9-]{1,64}(?:\/reject)?$/.test(target)) return proposal(body);
  return bad();
}
module.exports = { memoryResponse };
