// Safe Markdown display for chat replies (src/markdown.tsx).
require('./load.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { Markdown, parseBlocks, safeHref } = require('../src/markdown.tsx');
const html = (t) => renderToStaticMarkup(createElement(Markdown, { text: t }));

test('blocks: headings, lists, quotes, code, breaks, paragraphs', () => {
  const b = parseBlocks('# Title\n\nPara one\nline two\n\n- a\n- b\n\n2. x\n3. y\n\n> quote\n\n```js\nconst a = 1;\n```\n\n---\ntail');
  assert.deepEqual(b.map((x) => x.kind), ['h', 'p', 'ul', 'ol', 'quote', 'code', 'hr', 'p']);
  assert.equal(b[3].start, 2);
  assert.equal(b[5].lang, 'js');
  assert.equal(b[5].text, 'const a = 1;');
});

test('an unterminated fence (a reply still streaming) shows as code', () => {
  const b = parseBlocks('Here:\n```python\nprint(1)');
  assert.equal(b.at(-1).kind, 'code');
  assert.equal(b.at(-1).text, 'print(1)');
});

test('inline: bold, italic, code and links render as elements', () => {
  const out = html('A **bold** and *it* with `x<y` and [site](https://example.com/a?b=1).');
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>it<\/em>/);
  assert.match(out, /<code class="md-inline">x&lt;y<\/code>/);
  assert.match(out, /<a href="https:\/\/example.com\/a\?b=1" target="_blank" rel="noopener noreferrer">site<\/a>/);
});

test('inline: underscores inside a word stay text (model names, snake_case)', () => {
  const out = html('I use **qwen3.5:9b-q4_K_M** and my_var_name, but _this_ is italic and __this__ bold.');
  assert.match(out, /<strong>qwen3\.5:9b-q4_K_M<\/strong>/);
  assert.match(out, /my_var_name/);
  assert.match(out, /<em>this<\/em> is italic/);
  assert.match(out, /<strong>this<\/strong> bold/);
});

test('never HTML: tags in a reply stay text', () => {
  const out = html('<img src=x onerror=alert(1)> <script>alert(1)</script>\n\n```\n<b>x</b>\n```');
  assert.ok(!/<img|<script|<b>/.test(out), out);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('links: only http(s) and mailto; others stay plain text', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'vbscript:x', 'file:///etc/passwd']) {
    assert.equal(safeHref(bad), null, bad);
    const out = html(`[x](${bad})`);
    assert.ok(!/<a /.test(out), `${bad}: ${out}`);
  }
  assert.equal(safeHref('mailto:a@example.com'), 'mailto:a@example.com');
});

test('the chat screen renders a reply as Markdown, escaped', () => {
  const { ChatScreen } = require('../src/ChatScreen.tsx');
  const controller = {
    subscribe: () => () => {},
    getSnapshot: () => ({ phase: 'complete', draft: '', agentId: '', sessionId: 's', notice: undefined,
      turns: [{ key: 'k', prompt: '<i>hi</i>', content: '## Plan\n- **one**\n- <img src=x>', events: 0, replayed: false, partial: false, terminal: 'done' }] }),
    edit() {}, send() {}, cancel() {}, selectAgent() {},
  };
  const out = renderToStaticMarkup(createElement(ChatScreen, { controller, mode: 'mock' }));
  assert.match(out, /<h4 class="md-h md-h2" dir="auto">Plan<\/h4>/);
  assert.match(out, /<li><strong>one<\/strong><\/li>/);
  assert.ok(!/<img|<i>hi/.test(out));
  assert.match(out, /&lt;i&gt;hi&lt;\/i&gt;/);
});

test('tables, task lists and code blocks with language, copy and folding', () => {
  const b = parseBlocks('| Name | Score |\n|:---|---:|\n| A | 1 |\n| B | 2 |\n\n- [x] done\n- [ ] todo');
  assert.equal(b[0].kind, 'table');
  assert.deepEqual(b[0].header, ['Name', 'Score']);
  assert.deepEqual(b[0].align, ['left', 'right']);
  assert.deepEqual(b[0].rows, [['A', '1'], ['B', '2']]);
  const out = html('| Name | Score |\n|---|---|\n| <b>A</b> | **1** |\n\n- [x] done\n- [ ] todo');
  assert.match(out, /<table class="md-table">/);
  assert.match(out, /<td dir="auto">&lt;b&gt;A&lt;\/b&gt;<\/td>/);
  assert.match(out, /<li class="md-task" data-done="true">/);
  const code = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const folded = html('```python\n' + code + '\n```');
  assert.match(folded, /<span class="md-code-lang">python<\/span>/);
  assert.match(folded, /Show 16 more lines/);
  assert.ok(!folded.includes('line 29'));
  const streaming = html('```python\n' + code);
  assert.ok(streaming.includes('line 29'), 'an open fence (still streaming) is not folded');
  assert.match(streaming, /data-streaming="true"/);
  assert.match(html('مرحبا بكم'), /<p dir="auto">/);
});
