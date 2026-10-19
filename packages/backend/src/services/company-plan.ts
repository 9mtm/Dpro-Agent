/**
 * Company plan for first-run setup (ONBOARD-TEAM-01, decision D-ONBOARD-TEAM).
 *
 * The owner gives a company size and picks departments; this module proposes
 * a team: per department a headcount from the size, and per hire a role, a
 * job title, a persona preset and an unused name. It only proposes. Nothing is
 * created here; the owner reviews every hire and creates them with
 * POST /api/agents, one by one.
 *
 * ONBOARD-TEAM-02: for a bigger company the owner gives a total headcount
 * instead of a size. planDistribution() splits it over the departments by
 * catalogue weight (at least one lead each, reviewers in proportion); the
 * owner edits the per-department counts and personas, and the batch hire
 * (services/team-batch.ts) creates the agents and picks their names.
 *
 * This file is the single reviewed source for the department catalogue and the
 * headcount rules, so the web UI and later installers share them.
 */

import { defaultPresetForRole, normalizeDepartment, type AgentRole } from './personality.js';
import { isNameLanguage, suggestAgentNames, DEFAULT_NAME_LANGUAGE, type NameLanguage } from './agent-names.js';

export const COMPANY_SIZES = ['solo', 'small', 'medium', 'large'] as const;
export type CompanySize = (typeof COMPANY_SIZES)[number];

export const COMPANY_SIZE_LABELS: Readonly<Record<CompanySize, string>> = Object.freeze({
  solo: 'Just me',
  small: '2–10 agents',
  medium: '11–50 agents',
  large: 'More than 50 agents',
});

/**
 * Roles per department by company size, in hiring order. A manager appears
 * once there is more than one agent in the department; a reviewer
 * (evaluator) is added for medium and large companies.
 */
const HEADCOUNT: Readonly<Record<CompanySize, readonly AgentRole[]>> = Object.freeze({
  solo: ['specialist'],
  small: ['manager', 'specialist'],
  medium: ['manager', 'specialist', 'specialist', 'evaluator'],
  large: ['manager', 'specialist', 'specialist', 'specialist', 'evaluator'],
});

export interface DepartmentInfo {
  id: string;
  label: string;
  /** What the department does, shown when choosing departments. */
  summary: string;
  /** Job title per role (falls back to a generic title). */
  titles: Partial<Record<AgentRole, string>>;
  /** Relative share of a total headcount (ONBOARD-TEAM-02). */
  weight: number;
}

export const DEPARTMENTS: readonly DepartmentInfo[] = Object.freeze([
  { id: 'development', label: 'Development', summary: 'Builds and maintains your software.', titles: { manager: 'Engineering lead', specialist: 'Software developer', evaluator: 'Code reviewer' }, weight: 5 },
  { id: 'marketing', label: 'Marketing', summary: 'Campaigns, content and social media.', titles: { manager: 'Marketing lead', specialist: 'Marketing specialist', evaluator: 'Brand reviewer' }, weight: 3 },
  { id: 'sales', label: 'Sales', summary: 'Leads, offers and follow-ups.', titles: { manager: 'Sales lead', specialist: 'Sales representative', evaluator: 'Deal reviewer' }, weight: 3 },
  { id: 'support', label: 'Customer support', summary: 'Answers customers and solves their problems.', titles: { manager: 'Support lead', specialist: 'Support agent', evaluator: 'Quality reviewer' }, weight: 4 },
  { id: 'finance', label: 'Finance', summary: 'Invoices, budgets and reports.', titles: { manager: 'Finance lead', specialist: 'Accountant', evaluator: 'Financial auditor' }, weight: 2 },
  { id: 'security', label: 'Security', summary: 'Checks risks, access and incidents.', titles: { manager: 'Security lead', specialist: 'Security analyst', evaluator: 'Security auditor' }, weight: 2 },
  { id: 'operations', label: 'Operations', summary: 'Keeps daily work, tools and schedules running.', titles: { manager: 'Operations lead', specialist: 'Operations coordinator', evaluator: 'Process reviewer' }, weight: 2 },
  { id: 'hr', label: 'People and hiring', summary: 'Hiring, onboarding and team questions.', titles: { manager: 'People lead', specialist: 'Recruiter', evaluator: 'Policy reviewer' }, weight: 1 },
  { id: 'research', label: 'Research', summary: 'Finds and summarises information.', titles: { manager: 'Research lead', specialist: 'Researcher', evaluator: 'Fact checker' }, weight: 2 },
  { id: 'design', label: 'Design', summary: 'Visuals, layouts and brand assets.', titles: { manager: 'Design lead', specialist: 'Designer', evaluator: 'Design reviewer' }, weight: 2 },
  { id: 'legal', label: 'Legal', summary: 'Contracts and compliance questions.', titles: { manager: 'Legal lead', specialist: 'Legal assistant', evaluator: 'Compliance reviewer' }, weight: 1 },
  { id: 'infrastructure', label: 'Infrastructure', summary: 'Servers, networks, cloud platforms and reliable operations.', titles: { manager: 'Infrastructure lead', specialist: 'Infrastructure specialist', evaluator: 'Infrastructure reviewer' }, weight: 2 },
  { id: 'data', label: 'Data', summary: 'Data pipelines, databases, analytics and governance.', titles: { manager: 'Data lead', specialist: 'Data specialist', evaluator: 'Data reviewer' }, weight: 2 },
  { id: 'education', label: 'Education and languages', summary: 'Teaching, tutoring, language learning and course design.', titles: { manager: 'Education and languages lead', specialist: 'Education and languages specialist', evaluator: 'Education and languages reviewer' }, weight: 2 },
  { id: 'production', label: 'Creative production', summary: 'Virtual performance, video, voice and media production.', titles: { manager: 'Creative production lead', specialist: 'Creative production specialist', evaluator: 'Creative production reviewer' }, weight: 2 },
  { id: 'wellness', label: 'Fitness and wellness', summary: 'Exercise, mobility, activity and habit coaching.', titles: { manager: 'Fitness and wellness lead', specialist: 'Fitness and wellness specialist', evaluator: 'Fitness and wellness reviewer' }, weight: 2 },

].map((d) => Object.freeze(d)));

const GENERIC_TITLE: Readonly<Record<AgentRole, string>> = Object.freeze({
  main: 'Company lead', manager: 'Team lead', specialist: 'Specialist', evaluator: 'Reviewer',
});

export const MAX_DEPARTMENTS = 12;
export const MAX_CUSTOM_DEPARTMENTS = 4;
export const MAX_PLANNED_HIRES = 60;
/** Share of a custom department when a total is split (ONBOARD-TEAM-02). */
export const CUSTOM_DEPARTMENT_WEIGHT = 2;
export const MAX_TOTAL_HEADCOUNT = 1000;

export class CompanyPlanInputError extends Error {}

export interface PlannedHire {
  department: string;
  departmentLabel: string;
  role: AgentRole;
  title: string;
  description: string;
  preset: string;
  name: string;
}

export interface CompanyPlan {
  size: CompanySize;
  language: NameLanguage;
  hires: PlannedHire[];
}

export interface CompanyPlanInput {
  size?: unknown;
  departments?: unknown;
  language?: unknown;
}

function catalogueEntry(id: string): DepartmentInfo | undefined {
  return DEPARTMENTS.find((d) => d.id === id);
}

/** Validated, de-duplicated department ids (catalogue ids or custom names). */
export function parseDepartments(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new CompanyPlanInputError('Pick at least one department');
  if (value.length > MAX_DEPARTMENTS) throw new CompanyPlanInputError(`At most ${MAX_DEPARTMENTS} departments`);
  const out: string[] = [];
  let custom = 0;
  for (const raw of value) {
    let dep: string | null;
    try { dep = normalizeDepartment(raw); } catch { throw new CompanyPlanInputError('Each department must be a name of at most 64 characters'); }
    if (!dep) throw new CompanyPlanInputError('Department names cannot be empty');
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(dep)) throw new CompanyPlanInputError('Department names may use letters, numbers, spaces, - and _');
    if (out.includes(dep)) continue;
    if (!catalogueEntry(dep) && ++custom > MAX_CUSTOM_DEPARTMENTS) throw new CompanyPlanInputError(`At most ${MAX_CUSTOM_DEPARTMENTS} custom departments`);
    out.push(dep);
  }
  return out;
}

export function parseSize(value: unknown): CompanySize {
  if (typeof value !== 'string' || !(COMPANY_SIZES as readonly string[]).includes(value)) {
    throw new CompanyPlanInputError(`size must be one of ${COMPANY_SIZES.join(', ')}`);
  }
  return value as CompanySize;
}

/**
 * Persona preset for a role in a department. Leads get the department's own
 * persona (a marketing lead is creative, a finance lead careful); the others
 * follow the role rule in services/personality.ts.
 */
export function presetFor(role: AgentRole, department: string): string {
  const asRole = role === 'manager' ? 'specialist' : role;
  return defaultPresetForRole({ role: asRole, department }) ?? 'balanced-assistant';
}

function departmentLabel(dep: string): string {
  return catalogueEntry(dep)?.label ?? dep.replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase());
}

function titleFor(role: AgentRole, dep: string): string {
  return catalogueEntry(dep)?.titles[role] ?? `${departmentLabel(dep)} ${GENERIC_TITLE[role].toLowerCase()}`;
}

/** Roles, titles and presets for a plan, without names (pure). */
export function planRoles(size: CompanySize, departments: readonly string[]): Omit<PlannedHire, 'name'>[] {
  const hires: Omit<PlannedHire, 'name'>[] = [];
  for (const dep of departments) {
    const label = departmentLabel(dep);
    for (const role of HEADCOUNT[size]) {
      const title = titleFor(role, dep);
      hires.push({
        department: dep,
        departmentLabel: label,
        role,
        title,
        description: `${title} in ${label}.`,
        preset: presetFor(role, dep),
      });
    }
  }
  if (hires.length > MAX_PLANNED_HIRES) throw new CompanyPlanInputError(`A plan can hold at most ${MAX_PLANNED_HIRES} hires`);
  return hires;
}

/** The proposed team with unused names. Reads only; reserves nothing. */
export async function planCompany(input: CompanyPlanInput): Promise<CompanyPlan> {
  const size = parseSize(input.size);
  const departments = parseDepartments(input.departments);
  if (input.language !== undefined && !isNameLanguage(input.language)) throw new CompanyPlanInputError('Unsupported language');
  const language: NameLanguage = input.language === undefined ? DEFAULT_NAME_LANGUAGE : (input.language as NameLanguage);
  const roles = planRoles(size, departments);
  const names = await suggestAgentNames(language, roles.length);
  return { size, language, hires: roles.map((h, i) => ({ ...h, name: names[i].name })) };
}

// ---------------------------------------------------------------------------
// Total headcount (ONBOARD-TEAM-02)
// ---------------------------------------------------------------------------

export type RoleCounts = Record<'manager' | 'specialist' | 'evaluator', number>;
export const TEAM_ROLES = ['manager', 'specialist', 'evaluator'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * Roles inside one department of `count` agents: one lead per 20 agents (at
 * least one), from 4 agents one reviewer per 10 (at least one), the rest
 * specialists. 1 -> 1 lead; 2 -> lead + specialist; 4 -> 1/2/1; 100 -> 5/85/10.
 */
export function departmentRoles(count: number): RoleCounts {
  if (!Number.isInteger(count) || count < 1) throw new CompanyPlanInputError('Each department needs at least one agent');
  const manager = Math.max(1, Math.round(count / 20));
  const evaluator = count >= 4 ? Math.max(1, Math.round(count / 10)) : 0;
  return { manager, specialist: count - manager - evaluator, evaluator };
}

export function parseTotal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_TOTAL_HEADCOUNT) {
    throw new CompanyPlanInputError(`total must be a whole number from 1 to ${MAX_TOTAL_HEADCOUNT}`);
  }
  return value;
}

/**
 * Split `total` over the departments by weight with at least one agent each
 * (largest remainder, ties in the given order). The result always sums to
 * `total`. Pure.
 */
export function distributeHeadcount(total: number, departments: readonly string[]): Record<string, number> {
  if (departments.length === 0) throw new CompanyPlanInputError('Pick at least one department');
  if (total < departments.length) throw new CompanyPlanInputError(`A total of ${total} cannot give each of ${departments.length} departments one agent`);
  const weights = departments.map((d) => catalogueEntry(d)?.weight ?? CUSTOM_DEPARTMENT_WEIGHT);
  const sum = weights.reduce((a, b) => a + b, 0);
  const free = total - departments.length; // everyone gets 1 first
  const exact = weights.map((w) => (free * w) / sum);
  const counts = exact.map((x) => 1 + Math.floor(x));
  let left = total - counts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) counts[order[k % order.length].i]++;
  return Object.fromEntries(departments.map((d, i) => [d, counts[i]]));
}

export interface DepartmentShare {
  department: string;
  departmentLabel: string;
  count: number;
  roles: RoleCounts;
  titles: Record<TeamRole, string>;
  presets: Record<TeamRole, string>;
}

export interface CompanyDistribution {
  total: number;
  departments: DepartmentShare[];
}

export interface DistributionInput {
  total?: unknown;
  departments?: unknown;
  counts?: unknown;
}

/** Per-department count edits from the owner: { [department]: n }, one per chosen department. */
export function parseCounts(value: unknown, departments: readonly string[]): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CompanyPlanInputError('counts must be an object of department -> number');
  const raw = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    let dep: string | null;
    try { dep = normalizeDepartment(k); } catch { dep = null; }
    if (!dep || !departments.includes(dep)) throw new CompanyPlanInputError(`counts names a department that was not chosen`);
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_TOTAL_HEADCOUNT) throw new CompanyPlanInputError(`Each department count must be a whole number from 1 to ${MAX_TOTAL_HEADCOUNT}`);
    out[dep] = v;
  }
  for (const d of departments) if (out[d] === undefined) throw new CompanyPlanInputError('counts must give a number for every chosen department');
  return out;
}

/** One department of `count` agents: role split, titles and personas. Pure. */
export function departmentShare(department: string, count: number): DepartmentShare {
  return {
    department,
    departmentLabel: departmentLabel(department),
    count,
    roles: departmentRoles(count),
    titles: { manager: titleFor('manager', department), specialist: titleFor('specialist', department), evaluator: titleFor('evaluator', department) },
    presets: { manager: presetFor('manager', department), specialist: presetFor('specialist', department), evaluator: presetFor('evaluator', department) },
  };
}

/**
 * A total split over departments, or the owner's own per-department counts
 * (then `total` is their sum, and a given `total` must match). Reads nothing.
 */
export function planDistribution(input: DistributionInput): CompanyDistribution {
  const departments = parseDepartments(input.departments);
  let counts: Record<string, number>;
  if (input.counts !== undefined) {
    counts = parseCounts(input.counts, departments);
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    if (sum > MAX_TOTAL_HEADCOUNT) throw new CompanyPlanInputError(`At most ${MAX_TOTAL_HEADCOUNT} agents in total`);
    if (input.total !== undefined && parseTotal(input.total) !== sum) throw new CompanyPlanInputError('total does not match the department counts');
  } else {
    counts = distributeHeadcount(parseTotal(input.total), departments);
  }
  const shares = departments.map((d) => departmentShare(d, counts[d]));
  return { total: shares.reduce((a, s) => a + s.count, 0), departments: shares };
}
