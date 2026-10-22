// B2.2d-5: one skills-marketplace scenario for both drivers: the Anthropic
// skills service (legacy installation refused without remote access,
// search, installed list, usage log, enabled content, uninstall) and the
// marketplace DB routes (sources, installed, stats, toggle). The caller
// sets up a temp cwd (the skills directory is relative to it), the driver,
// the routes behind the auth gate, and passes { app, q, auth, svc }.
// Used by test/skills-marketplace.test.mjs (SQLite) and
// test/pg-skills.integration.test.mjs (PostgreSQL).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function skillsScenario(test, getM, { tag, skip = false }) {
  const m = () => getM();
  const owner = `sk-owner-${tag}`;
  const name = `pdf-tools-${tag}`;
  const call = async (method, url) => m().app.inject({ method, url, headers: m().auth(owner) });
  let skill;let fetches=0;

  test('seed owner; stub the GitHub fetch', { skip }, async () => {
    const { q, svc } = m();
    await q.run(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', 'owner', 'active')`, owner, `${owner}@example.test`, owner);
    svc.fetchSkillContent = async (p) => {fetches++;return `---\nname: PDF Tools ${tag}\ndescription: Works with PDF files (${p})\n---\n# Body ${tag}\n`;}
  });

  test('legacy service, tool and route refuse installation without fetching or writing', { skip }, async () => {
    const { q, svc, app } = m();
    const before=await q.one('SELECT COUNT(*) AS n FROM installed_skills');
    await assert.rejects(svc.installSkill(name, `skills/documents/${name}`),e=>e.code==='reviewed_install_required');
    await assert.rejects(svc.installSkill('../evil', 'skills/x/y'), /Invalid/);
    const originalInstall=svc.installSkill;let reached=0;svc.installSkill=async()=>{reached++;throw Error('Legacy writer must not be reached');};
    const {skillInstallTool}=await import('../../src/tools/skill-install.ts');
    try {
    const tool=await skillInstallTool.execute({action:'install',query:name,skillPath:`skills/documents/${name}`});
    assert.equal(JSON.parse(tool.content[0].text).code,'reviewed_install_required');assert.ok(tool.error);
    const response=await app.inject({method:'POST',url:'/api/skills/marketplace/install',headers:m().auth(owner),payload:{skillName:name,skillPath:`skills/documents/${name}`,receipt:'forged',reviewHash:'forged'}});
    assert.equal(response.statusCode,409,response.body);assert.equal(response.json().code,'reviewed_install_required');
    assert.equal(reached,0);assert.equal(fetches,0);assert.equal((await q.one('SELECT COUNT(*) AS n FROM installed_skills')).n,before.n);
    const {dataPathOr}=await import('../../src/config/data-root.ts');assert.equal(existsSync(path.join(dataPathOr('.data/skills','skills'),name+'.md')),false);
    } finally {svc.installSkill=originalInstall;}
  });

  test('existing legacy records remain readable without reopening an installer', { skip }, async () => {
    const {q}=m();const {dataPathOr}=await import('../../src/config/data-root.ts');
    const folder=dataPathOr('.data/skills','skills'),file=path.join(folder,name+'.md');mkdirSync(folder,{recursive:true});
    // Explicit historical fixture, not a service installation or grant.
    writeFileSync(file,`# Body ${tag}\n`);
    const source=await q.one("SELECT id FROM skill_sources WHERE name='Anthropic Official'");
    await q.run('INSERT INTO installed_skills(source_id,skill_name,display_name,description,category,file_path,metadata,is_enabled) VALUES(?,?,?,?,?,?,?,1)',source.id,name,`PDF Tools ${tag}`,'Fictional legacy record','documents',file,'{}');
    skill=await q.one('SELECT * FROM installed_skills WHERE skill_name=?',name);
    assert.ok(existsSync(file));assert.equal(skill.is_enabled,1);
  });

  test('search is case-insensitive; installed list joins the source', { skip }, async () => {
    const { svc } = m();
    assert.deepEqual((await svc.searchSkills(`PDF-TOOLS-${tag.toUpperCase()}`)).map((s) => s.id), [skill.id]);
    const installed = await svc.getInstalledSkills();
    const mine = installed.find((s) => s.id === skill.id);
    assert.equal(mine.source_name, 'Anthropic Official');
    assert.match(await svc.getEnabledSkillsContent(), new RegExp(`# Body ${tag}`));
  });

  test('usage log counts and stamps last_used as TEXT', { skip }, async () => {
    const { q, svc } = m();
    await svc.logSkillUsage(skill.id, owner, undefined, true);
    await svc.logSkillUsage(skill.id, undefined, undefined, false);
    const row = await q.one('SELECT usage_count, last_used FROM installed_skills WHERE id = ?', skill.id);
    assert.equal(row.usage_count, 2);
    assert.match(row.last_used, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal((await q.one('SELECT COUNT(*) AS n FROM skill_usage_log WHERE skill_id = ?', skill.id)).n, 2);
  });

  test('routes: sources, installed, stats, toggle (one statement), bad id', { skip }, async () => {
    const src = await call('GET', '/api/skills/marketplace/sources');
    assert.equal(src.statusCode, 200, src.body);
    assert.ok(src.json().sources.some((s) => s.name === 'Anthropic Official'));
    const inst = await call('GET', '/api/skills/marketplace/installed');
    assert.ok(inst.json().skills.some((s) => s.id === skill.id));
    const st = (await call('GET', '/api/skills/marketplace/stats')).json().stats;
    assert.equal(typeof st.totalInstalled.count, 'number');
    assert.ok(st.enabled.count >= 1);
    assert.ok(st.byCategory.some((c) => c.category === 'documents'));
    assert.ok(st.mostUsed.some((s) => s.skill_name === name));
    const off = await call('PUT', `/api/skills/marketplace/${skill.id}/toggle`);
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(off.json().enabled, false);
    assert.equal((await call('PUT', `/api/skills/marketplace/${skill.id}/toggle`)).json().enabled, true);
    assert.equal((await call('PUT', '/api/skills/marketplace/not-an-id/toggle')).statusCode, 400);
  });

  test('uninstall deletes the row and the file', { skip }, async () => {
    const { q, svc } = m();
    await svc.uninstallSkill(skill.id);
    assert.equal(await q.one('SELECT id FROM installed_skills WHERE id = ?', skill.id), undefined);
    assert.equal(existsSync(skill.file_path), false);
    await assert.rejects(svc.uninstallSkill(skill.id), /not found/);
  });
}
