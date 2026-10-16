export type RecoveryApproval = { id: string; status: string; toolName: string; sessionId: string | null; params?: unknown; paramsHash?: string | null; maskedFields?: string[] };
export function approvalPath(path: string): { kind: string; id?: string } | null;
export function allowedApproval(method: string, path: string, body?: unknown): boolean;
export function approvalResponse(path: string, status: number, body: unknown): { approvals?: RecoveryApproval[]; approval?: RecoveryApproval } | null;
