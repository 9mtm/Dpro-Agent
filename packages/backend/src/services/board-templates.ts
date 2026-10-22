/**
 * Board templates and colours (BOARD-03 step A). The single reviewed
 * catalogue: the web UI lists it, and a new board starts with the template's
 * columns (the owner can rename or add columns later).
 *
 * Every template ends with the column only the owner moves cards into
 * (agents never move a card into the last column, services/task-board.ts).
 */

export interface BoardTemplate {
  id: string;
  name: string;
  description: string;
  columns: readonly string[];
}

export const BOARD_TEMPLATES: readonly BoardTemplate[] = Object.freeze([
  { id: 'kanban', name: 'Team workflow', description: 'Collect ideas, plan the work and follow it to done.', columns: ['Ideas', 'Backlog', 'To do', 'In progress', 'Review', 'Done'] },
  { id: 'content', name: 'Content calendar', description: 'Posts, articles and videos from idea to published.', columns: ['Ideas', 'Writing', 'Editing', 'Scheduled', 'Published'] },
  { id: 'sales', name: 'Sales pipeline', description: 'Leads and deals through each stage.', columns: ['Leads', 'Contacted', 'Proposal', 'Negotiation', 'Closed'] },
  { id: 'hiring', name: 'Hiring pipeline', description: 'New agents or people from request to onboarded.', columns: ['Requests', 'Screening', 'Interview', 'Offer', 'Onboarded'] },
  { id: 'bugs', name: 'Bug tracking', description: 'Problems from report to fix.', columns: ['Reported', 'Confirmed', 'Fixing', 'Testing', 'Fixed'] },
  { id: 'sprint', name: 'Sprint', description: 'A short cycle of planned work.', columns: ['Sprint backlog', 'To do', 'In progress', 'Review', 'Done'] },
  {id:'education',name:'Education delivery',description:'Prepare, teach and assess courses.',columns:['Planning','Preparing','Teaching','Assessment','Completed']},
  {id:'integration',name:'Integration and employment',description:'Follow participant support from intake to an outcome.',columns:['Intake','Assessment','Support plan','In progress','Outcome review','Completed']},
  {id:'support',name:'Customer support',description:'Triage requests and resolve them with review.',columns:['New','Triage','In progress','Waiting','Resolved']},
  {id:'finance',name:'Finance review',description:'Prepare records and review them before completion.',columns:['Received','Preparing','Review','Approval','Completed']},
  {id:'security',name:'Security response',description:'Assess and remediate security work.',columns:['Reported','Assessing','Investigating','Remediating','Verified']},
  {id:'legal',name:'Legal and compliance',description:'Research, draft and review legal work.',columns:['Intake','Research','Drafting','Review','Approved']},
  { id: 'simple', name: 'Simple list', description: 'Just to do and done.', columns: ['To do', 'Doing', 'Done'] },
].map((t) => Object.freeze({ ...t, columns: Object.freeze([...t.columns]) })));

export const DEFAULT_TEMPLATE = 'kanban';

/** Board colour palette ids (the UI maps them to its own colour tokens). */
export const BOARD_COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'pink', 'teal', 'gray'] as const;
export type BoardColor = (typeof BOARD_COLORS)[number];

export function boardTemplate(id: string): BoardTemplate | undefined {
  return BOARD_TEMPLATES.find((t) => t.id === id);
}

/** Initial workflows only; syncing never replaces a board's customised columns. */
export function templateForDepartment(name:string):string {
 const n=name.toLowerCase();
 if(/recruit|human|people|\bhr\b|موارد|توظيف|personal/.test(n))return 'hiring';
 if(/sales|مبيعات|vertrieb/.test(n))return 'sales';
 if(/marketing|content|تسويق|محتوى|media|creative/.test(n))return 'content';
 if(/support|customer|دعم|خدمة|call.center/.test(n))return 'support';
 if(/secur|cyber|حماية|امن|أمن/.test(n))return 'security';
 if(/financ|account|محاسب|مالي|buchhalt/.test(n))return 'finance';
 if(/legal|compliance|قانون|امتثال|recht/.test(n))return 'legal';
 if(/integration|employment|اندماج|تأهيل|تاهيل|vermittlung/.test(n))return 'integration';
 if(/educat|teach|language|training|تعليم|تدريب|لغات|bildung|sprach/.test(n))return 'education';
 if(/develop|engineer|software|\bit\b|تطوير|برمج|تقني/.test(n))return 'sprint';
 return DEFAULT_TEMPLATE;
}
