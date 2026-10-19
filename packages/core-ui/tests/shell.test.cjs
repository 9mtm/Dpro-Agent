require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { App } = require('../src/App.tsx');
const { catalogs } = require('../src/catalogs.ts');
const { destinations, initialState, reducer, filterDestinations, isPaletteShortcut, nextResult } = require('../src/model.ts');
const root = path.resolve(__dirname, '..');
const render = (patch = {}) => renderToStaticMarkup(React.createElement(App, { seed: { ...initialState(), ...patch } }));

test('only six core destinations; invalid navigation cannot expose product panes', () => {
  assert.deepEqual(destinations, ['chat', 'agents', 'memory', 'tasks', 'settings', 'channels']);
  for (const destination of destinations) assert.equal(reducer(initialState(), { type: 'navigate', destination }).destination, destination);
  for (const destination of ['apps', 'worlds', 'trading', '__proto__', 'waf']) assert.equal(reducer(initialState(), { type: 'navigate', destination }).destination, 'chat');
});
test('Generate edits draft only; explicit Save updates in-memory name and retires previous name', () => {
  const start = initialState();
  const draft = reducer(start, { type: 'generate', entropy: 0 });
  assert.equal(draft.name, start.name); assert.notEqual(draft.draft, start.name);
  const saved = reducer(draft, { type: 'save' });
  assert.equal(saved.name, draft.draft); assert.equal(saved.notice, 'saved'); assert.ok(saved.retired.includes(start.name));
  assert.equal(initialState().name, 'Mira');
});
test('Cancel restores last saved name after typing or Generate, including navigation', () => {
  let state = reducer(initialState(), { type: 'draft', value: 'New name' });
  state = reducer(state, { type: 'save' });
  state = reducer(state, { type: 'generate', entropy: 0 });
  state = reducer(state, { type: 'navigate', destination: 'chat' });
  state = reducer(state, { type: 'cancel' });
  assert.equal(state.name, 'New name'); assert.equal(state.draft, 'New name'); assert.equal(state.notice, '');
});
test('empty, banned control and over-60-code-point names are refused without changing saved value', () => {
  for (const value of ['', ' ', 'a\u202Eb', 'a\0name', 'a'.repeat(61), '😀'.repeat(61)]) {
    const saved = reducer(reducer(initialState(), { type: 'draft', value }), { type: 'save' });
    assert.equal(saved.notice, 'invalid'); assert.equal(saved.name, 'Mira');
  }
});
test('own retired names can be reclaimed; no-op saves do not retire the current name', () => {
  const saved = reducer({ ...initialState(), draft: ' ＡＴＬＡＳ ' }, { type: 'save' });
  assert.equal(saved.notice, 'saved'); assert.equal(saved.name, 'ATLAS'); assert.deepEqual(saved.retired, ['Atlas', 'Mira']);
  const same = reducer({ ...initialState(), draft: ' mira ' }, { type: 'save' });
  assert.deepEqual(same.retired, ['Atlas']); assert.equal(same.draft, 'Mira');
});
test('suggestion exhaustion is explicit and preserves draft; locale-specific names', () => {
  const state = { ...initialState(), retired: ['Nora', 'Lumen', 'Aster'] };
  const result = reducer(state, { type: 'generate', entropy: 0 });
  assert.equal(result.notice, 'exhausted'); assert.equal(result.draft, state.draft);
  assert.match(reducer({ ...initialState(), locale: 'ar' }, { type: 'generate', entropy: 0 }).draft, /[\u0600-\u06ff]/);
});
test('all fixture scenarios and theme changes preserve draft and identity', () => {
  for (const value of ['empty', 'error', 'stale']) {
    const state = reducer(initialState(), { type: 'scenario', value });
    assert.equal(state.scenario, value); assert.equal(state.name, 'Mira');
    assert.match(render({ scenario: value }), new RegExp(catalogs.en[`${value}Title`]));
  }
  assert.equal(reducer(reducer(initialState(), { type: 'theme' }), { type: 'theme' }).theme, 'light');
});
test('palette localized filtering and keyboard wrap, empty results and composition safety', () => {
  assert.deepEqual(filterDestinations('  MEMORY ', catalogs.en), ['memory']);
  assert.deepEqual(filterDestinations('الذاكرة', catalogs.ar), ['memory']);
  assert.deepEqual(filterDestinations('trading', catalogs.en), []);
  assert.equal(nextResult(5, 6, 'ArrowDown'), 0); assert.equal(nextResult(0, 6, 'ArrowUp'), 5); assert.equal(nextResult(0, 0, 'ArrowDown'), -1);
  const key = { key: 'K', ctrlKey: true, metaKey: false, altKey: false, isComposing: false };
  assert.equal(isPaletteShortcut(key), true); assert.equal(isPaletteShortcut({ ...key, isComposing: true }), false);
  assert.equal(isPaletteShortcut({ ...key, altKey: true }), false); assert.equal(isPaletteShortcut({ ...key, ctrlKey: false, metaKey: true }), true);
});
test('rendered shell semantics: landmarks, current page, labels, disabled send and persistent fixture status', () => {
  for (const destination of destinations) {
    const html = render({ destination });
    assert.match(html, /<nav aria-label=/); assert.match(html, /<main id="content" tabindex="-1">/);
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
    assert.match(html, /<footer class="statusbar">/); assert.match(html, /fictional data/);
    assert.match(html, /<dialog[^>]+aria-labelledby="commands-title"/);
    assert.match(html, /role="combobox"/); assert.match(html, /aria-controls="command-results"/);
    assert.match(html, /role="listbox"/); assert.match(html, /aria-keyshortcuts="Meta\+K Control\+K"/);
  }
  assert.match(render(), /<textarea[^>]+disabled=""[^>]+aria-describedby="chat-help"/);
  assert.match(render(), /<button disabled="">Send unavailable/);
});
test('name form associates help and errors, escapes untrusted draft, and labels local Save', () => {
  const html = render({ destination: 'agents', draft: '<img src=x>', notice: 'invalid' });
  assert.match(html, /for="agent-name"/); assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="name-help name-notice"/); assert.match(html, /role="status"/);
  assert.match(html, /&lt;img src=x&gt;/); assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /Save local fixture/);
});
test('catalogs are complete, Arabic has RTL root, and identity is bidi-isolated', () => {
  for (const locale of ['en', 'ar', 'de']) {
    assert.deepEqual(Object.keys(catalogs[locale]).sort(), Object.keys(catalogs.en).sort());
    for (const value of Object.values(catalogs[locale])) assert.ok(value.length > 0);
    const html = render({ locale }); assert.match(html, new RegExp(`lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`)); assert.match(html, /<bdi>Mira<\/bdi>/);
  }
});
test('security surfaces remain read-only and make no identity or connectivity claim', () => {
  const settings = render({ destination: 'settings' });
  for (const key of ['auth', 'execution', 'sandbox', 'remote', 'credentials']) assert.ok(settings.includes(catalogs.en[key]));
  const channels = render({ destination: 'channels' });
  for (const key of ['restricted', 'channelHelp', 'tools', 'never', 'scope']) assert.ok(channels.includes(catalogs.en[key]));
  assert.doesNotMatch(settings + channels, /type="(?:password|checkbox)"|role="switch"/);
  assert.ok(render({ destination: 'tasks' }).includes(catalogs.en.taskHelp));
});
function assertEntryBinding(source) {
  assert.match(source, /if \(enabled === false\) return undefined;/);
  assert.match(source, /const origin = browser\.location\.origin;/);
  assert.match(source, /if \(enabled !== true \|\| !isAppOrigin\(origin\)\) \{\s*throw new Error\('Live candidate requires its loopback application origin'\);\s*\}/);
  assert.match(source, /return new SessionClient\(\{ live: createSameOriginTransport\(origin, browser\.fetch\.bind\(browser\)\) \}\);/);
  assert.doesNotMatch(source, /\bfetch\s*(?:\?\.)?\s*\(|\bfetch\s*\.\s*(?:call|apply)\s*\(/);
  // Only the declared fetch capability and this exact binding may mention fetch.
  const remainder = source
    .replace("Pick<Window, 'location' | 'fetch'>", '')
    .replace('browser.fetch.bind(browser)', '');
  assert.doesNotMatch(remainder, /\bfetch\b|https?:\/\//);
  assert.equal((source.match(/new SessionClient\s*\(/g) ?? []).length, 1);
  assert.doesNotMatch(source, /\bmock\s*:/);
}
test('entry source exception rejects direct calls, alternate origins, missing guard and mock fallback', () => {
  const source = fs.readFileSync(path.join(root, 'src/entry-client.ts'), 'utf8');
  assertEntryBinding(source);
  for (const changed of [
    source + '\nbrowser.fetch("/api/setup/status");',
    source + '\nconst send = browser.fetch;',
    source.replace('browser.fetch.bind(browser)', 'browser.fetch.bind(window)'),
    source.replace('!isAppOrigin(origin)', 'false'),
    source.replace('createSameOriginTransport(origin,', 'createSameOriginTransport(String(browser.location),'),
    source.replace('enabled !== true || ', ''),
    source.replace('throw new Error', 'return new Error'),
    source.replace('{ live:', '{ mock: offline, live:'),
  ]) assert.throws(() => assertEntryBinding(changed));
});
test('source boundary: only injected session transport may network; no browser storage or HTML sinks', () => {
  for (const name of fs.readdirSync(path.join(root, 'src'))) {
    let source = fs.readFileSync(path.join(root, 'src', name), 'utf8');
    // Only a validated, non-sensitive theme preference may persist in browser storage.
    if (name === 'app-navigation.ts') source = source.replace("localStorage.getItem('dpro.theme')", 'undefined').replace("localStorage.setItem('dpro.theme', value)", 'undefined');
    // dev-session-keep.ts alone may use session storage, and only for the local test build.
    if (name === 'dev-session-keep.ts') assert.doesNotMatch(source, /\b(XMLHttpRequest|WebSocket|EventSource|localStorage|indexedDB|dangerouslySetInnerHTML)\b|document\.cookie/, name);
    else assert.doesNotMatch(source, /\b(XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|dangerouslySetInnerHTML)\b|document\.cookie/, name);
    if (name === 'entry-client.ts') assertEntryBinding(source);
    else if (name !== 'session.ts') assert.doesNotMatch(source, /\bfetch\b|https?:\/\//, name);
    else { assert.match(source, /fetcher: typeof fetch/); assert.doesNotMatch(source, /\bfetch\s*\(/); }
  }
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  assert.match(css, /:focus-visible/); assert.match(css, /prefers-reduced-motion/); assert.match(css, /forced-colors/);
  assert.doesNotMatch(css, /(?:margin|padding|border)-(?:left|right)\s*:/);
});
test('bundled Tabler originals and exact LICENSE match pinned provenance hashes', () => {
  const folder = path.join(root, 'assets/tabler'); const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'provenance.json')));
  assert.equal(manifest.files.length, 8);
  for (const file of [...manifest.files, manifest.license]) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, file.file))).digest('hex'), file.sha256);
  }
  assert.equal(manifest.revision, 'e8fcec66034d15fa893d4d3c740e584f8518ed44');
});

test('injected entropy selects every localized candidate at bucket boundaries', () => {
  const pools = { en: ['Nora', 'Lumen', 'Aster'], ar: ['نور', 'سنا', 'مدى'], de: ['Linde', 'Morgen', 'Stern'] };
  for (const [locale, pool] of Object.entries(pools)) {
    const state = Object.freeze({ ...initialState(), locale, retired: Object.freeze(['Atlas']) });
    for (const [entropy, index] of [[0, 0], [-0, 0], [Number.MIN_VALUE, 0], [1 / 3 - Number.EPSILON, 0], [1 / 3, 1], [0.5, 1], [2 / 3, 2], [1 - Number.EPSILON / 2, 2]]) {
      const action = Object.freeze({ type: 'generate', entropy });
      const result = reducer(state, action);
      assert.equal(result.draft, pool[index]);
      assert.deepEqual(result, { ...state, draft: pool[index], notice: '' });
      assert.strictEqual(result.retired, state.retired);
      assert.deepEqual(reducer(state, action), result, 'replaying entropy is deterministic');
    }
  }
});
test('invalid or missing entropy is a safe exact no-op, without coercion', () => {
  const state = Object.freeze({ ...initialState(), notice: 'saved', retired: Object.freeze(['Atlas']) });
  for (const entropy of [NaN, Infinity, -Infinity, -Number.MIN_VALUE, -1, 1, 1 + Number.EPSILON, undefined, null, '0.5', false, {}, 0n]) {
    assert.strictEqual(reducer(state, { type: 'generate', entropy }), state);
  }
  assert.strictEqual(reducer(state, { type: 'generate' }), state);
});
test('eligibility excludes normalized saved, draft and retired names before sampling', () => {
  for (const patch of [{ name: ' ＮＯＲＡ ' }, { draft: ' nOrA ' }, { retired: [' Ｎｏｒａ '] }]) {
    const state = { ...initialState(), ...patch };
    assert.equal(reducer(state, { type: 'generate', entropy: 0 }).draft, 'Lumen');
    assert.equal(reducer(state, { type: 'generate', entropy: 0.5 }).draft, 'Aster');
    assert.equal(reducer(state, { type: 'generate', entropy: 1 - Number.EPSILON / 2 }).draft, 'Aster');
  }
  const state = Object.freeze({ ...initialState(), name: ' ＮＯＲＡ ', draft: ' lumen ', retired: Object.freeze([' aStEr ']) });
  for (const entropy of [0, 0.5, 1 - Number.EPSILON / 2]) {
    const result = reducer(state, { type: 'generate', entropy });
    assert.deepEqual(result, { ...state, notice: 'exhausted' });
    assert.strictEqual(result.retired, state.retired);
  }
  const single = { ...state, retired: ['Atlas'] };
  for (const entropy of [0, 0.5, 1 - Number.EPSILON / 2]) assert.equal(reducer(single, { type: 'generate', entropy }).draft, 'Aster');
});
test('repeated Generate never retires drafts; Cancel and Save preserve fixture semantics', () => {
  const start = Object.freeze({ ...initialState(), retired: Object.freeze(['Atlas']) });
  let state = start;
  for (const entropy of [0, 0.75, 0.5, 0]) {
    const previous = state;
    state = reducer(state, { type: 'generate', entropy });
    assert.notEqual(state.draft, previous.draft);
    assert.equal(state.name, start.name);
    assert.strictEqual(state.retired, start.retired);
  }
  assert.deepEqual(reducer(state, { type: 'cancel' }), start);
  const saved = reducer(state, { type: 'save' });
  assert.equal(saved.name, state.draft);
  assert.deepEqual(saved.retired, ['Atlas', 'Mira']);
  assert.deepEqual(initialState(), start, 'no persistence or fixture identity mutation');
});
test('randomness is sampled only in the Generate event handler, never inside the reducer', () => {
  const model = fs.readFileSync(path.join(root, 'src/model.ts'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
  assert.doesNotMatch(model, /Math\.random|crypto\.|Date\./);
  assert.ok(app.includes("entropy: crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32"));
  assert.doesNotMatch(app, /Math\.random/);
});

test('fixture uses shared Unicode display normalization and Arabic uniqueness key', () => {
  for (const value of ['😀'.repeat(60), '<script>', '-name', 'a'.repeat(60)]) {
    const saved = reducer({ ...initialState(), draft: value }, { type: 'save' });
    assert.equal(saved.name, value); assert.equal(saved.notice, 'saved');
  }
  assert.equal(reducer({ ...initialState(), draft: ' Ｎｏｖａ\n Helper ' }, { type: 'save' }).name, 'Nova Helper');
  const same = reducer({ ...initialState(), name: 'أمـــلٌ', draft: 'امل' }, { type: 'save' });
  assert.equal(same.name, 'أمـــلٌ'); assert.deepEqual(same.retired, ['Atlas']);
  const generated = reducer({ ...initialState(), locale: 'ar', draft: 'نُور', retired: ['سنا'] }, { type: 'generate', entropy: 0 });
  assert.equal(generated.draft, 'مدى');
  assert.equal(reducer({ ...initialState(), draft: 'هدي', retired: ['هدى'] }, { type: 'save' }).notice, 'saved');
  assert.match(render({ name: '<script>', draft: '<script>' }), /&lt;script&gt;/);
});
