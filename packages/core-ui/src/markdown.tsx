import { useState } from 'react';
import type { ReactNode } from 'react';
import { SpecView, parseSpec } from './spec';

/**
 * A small, safe Markdown display for chat replies. Text becomes React
 * elements only (React escapes every string; no HTML is ever parsed or
 * injected). Supported: paragraphs, #-####### headings, > quotes, - * +
 * and 1. lists (with [ ] / [x] task items), | tables |, ``` fenced code
 * (an unterminated fence while a reply streams shows as code) with its
 * language, Copy, line wrap and long-code folding, --- breaks, `inline code`,
 * **bold**, *italic* / _italic_, and [links](address) for http(s) and mailto
 * only; anything else stays plain text. Text blocks take their direction
 * from their own first letters (Arabic paragraphs align right on their own).
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text)}</div>;
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'ul' | 'ol'; items: string[]; start: number }
  | { kind: 'code'; lang: string; text: string; open: boolean }
  | { kind: 'table'; header: string[]; align: ('left' | 'right' | 'center' | undefined)[]; rows: string[][] }
  | { kind: 'hr' };

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i])) body.push(lines[i++]);
      const open = i >= lines.length; // no closing fence yet (a reply still streaming)
      i++;
      out.push({ kind: 'code', lang: fence[2], text: body.join('\n'), open });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = cells(line);
      const align = cells(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push({ kind: 'table', header, align, rows });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push({ kind: 'h', level: h[1].length, text: h[2].replace(/\s+#+\s*$/, '') }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ kind: 'hr' }); i++; continue; }
    if (/^\s*>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push({ kind: 'quote', lines: q });
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/, ol = /^\s*(\d{1,9})[.)]\s+(.*)$/;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line);
      const re = ordered ? ol : ul;
      const items: string[] = [];
      const start = ordered ? Number(ol.exec(line)![1]) : 1;
      while (i < lines.length && (re.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = re.exec(lines[i]);
        if (m) items.push(ordered ? m[2] : m[1]);
        else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      out.push({ kind: ordered ? 'ol' : 'ul', items, start });
      continue;
    }
    const p: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s|^\s*>|^\s*[-*+]\s|^\s*\d{1,9}[.)]\s|^\s*(```|~~~)/.test(lines[i])) p.push(lines[i++]);
    if (p.length === 0) { p.push(lines[i++]); }
    out.push({ kind: 'p', lines: p });
  }
  return out;
}

function blocks(source: string): ReactNode[] {
  return parseBlocks(source).map((b, k) => {
    switch (b.kind) {
      case 'h': { const H = (`h${Math.min(b.level + 2, 6)}`) as 'h3'; return <H key={k} className={`md-h md-h${b.level}`} dir="auto">{inline(b.text)}</H>; }
      case 'hr': return <div key={k} className="md-hr" role="separator"/>;
      case 'quote': return <blockquote key={k} dir="auto">{withBreaks(b.lines)}</blockquote>;
      case 'ul': return <ul key={k} dir="auto">{b.items.map((t, j) => listItem(t, j))}</ul>;
      case 'ol': return <ol key={k} start={b.start} dir="auto">{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ol>;
      case 'code': return b.lang === 'spec' ? (b.open ? <p key={k} className="spec-pending">Preparing a view…</p> : <SpecBlock key={k} text={b.text}/>) : <CodeBlock key={k} lang={b.lang} text={b.text} open={b.open}/>;
      case 'table': return <div key={k} className="md-table-wrap"><table className="md-table">
        <thead><tr>{b.header.map((c, j) => <th key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined} dir="auto">{inline(c)}</th>)}</tr></thead>
        <tbody>{b.rows.map((r, ri) => <tr key={ri}>{b.header.map((_, j) => <td key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined} dir="auto">{inline(r[j] ?? '')}</td>)}</tr>)}</tbody>
      </table></div>;
      default: return <p key={k} dir="auto">{withBreaks(b.lines)}</p>;
    }
  });
}

function listItem(t: string, j: number) {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(t);
  if (!task) return <li key={j}>{inline(t)}</li>;
  const done = task[1] !== ' ';
  return <li key={j} className="md-task" data-done={done || undefined}><span className="md-check" role="img" aria-label={done ? 'Done' : 'Not done'}/>{inline(task[2])}</li>;
}

/** Code shown long lines past this are folded behind "Show N more lines". */
export const CODE_FOLD_LINES = 14;

/** A ```spec block drawn as a rich view; one that does not parse stays visible as code. */
function SpecBlock({ text }: { text: string }) { return parseSpec(text) ? <SpecView text={text}/> : <CodeBlock lang="spec" text={text}/>; }

/** A fenced code block: language, Copy, wrap for long lines, and folding for long code. */
export function CodeBlock({ lang, text, open = false }: { lang: string; text: string; open?: boolean }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const [wrap, setWrap] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const lines = text.split('\n');
  const fold = !open && lines.length > CODE_FOLD_LINES + 2 && !expanded;
  const wide = lines.some(l => l.length > 90);
  const copy = () => {
    const done = (state: 'done' | 'failed') => { setCopied(state); setTimeout(() => setCopied('idle'), state === 'done' ? 1500 : 2000); };
    if (!navigator.clipboard) { done('failed'); return; }
    navigator.clipboard.writeText(text).then(() => done('done'), () => done('failed'));
  };
  return <div className="md-codeblock" data-streaming={open || undefined}>
    <div className="md-code-head">
      <span className="md-code-lang">{lang || 'code'}</span>
      <span className="md-code-actions">
        {wide && <button type="button" className="md-code-btn" aria-pressed={wrap} onClick={() => setWrap(v => !v)}>{wrap ? 'No wrap' : 'Wrap'}</button>}
        <button type="button" className="md-code-btn" onClick={copy} aria-label={copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy code'}>{copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}</button>
      </span>
    </div>
    <pre className="md-code" dir="ltr" data-lang={lang || undefined} data-wrap={wrap || undefined}><code>{fold ? lines.slice(0, CODE_FOLD_LINES).join('\n') : text}</code></pre>
    {fold && <button type="button" className="md-code-more" onClick={() => setExpanded(true)}>Show {lines.length - CODE_FOLD_LINES} more lines</button>}
  </div>;
}

function withBreaks(lines: string[]): ReactNode[] {
  return lines.flatMap((l, j) => (j ? [<br key={`b${j}`}/>, ...inline(l, `l${j}`)] : inline(l, `l${j}`)));
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\s][^*\n]*\*)|(_[^_\s][^_\n]*_)/;

const WORD = /[\p{L}\p{N}]/u;

/** Inline markup to React nodes; plain strings stay strings (escaped by React). */
export function inline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  let before = '';
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    // Underscores inside a word (snake_case, qwen3.5:9b-q4_K_M) are text, not emphasis.
    if ((m[3] || m[6]) && (WORD.test(m.index > 0 ? rest[m.index - 1] : before) || WORD.test(rest[m.index + tok.length] ?? ''))) {
      out.push(rest[m.index]);
      before = rest[m.index];
      rest = rest.slice(m.index + 1);
      continue;
    }
    const key = `${keyPrefix}-${n++}`;
    if (m[1]) out.push(<code key={key} className="md-inline">{tok.slice(1, -1)}</code>);
    else if (m[2] || m[3]) out.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>);
    else if (m[4]) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const href = safeHref(lm[2]);
      out.push(href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{lm[1]}</a> : tok);
    } else out.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>);
    before = tok[tok.length - 1];
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

/** Only http(s) and mailto links; everything else (javascript:, data:, relative) is refused. */
export function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}
