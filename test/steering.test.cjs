const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');
const { test } = require('node:test');
const { checkQuality, checkSteering, parseQualityRules } = require('../dist/quality-rules');
const { applyPack, previewPack } = require('../dist/steering-pack');

const config = JSON.stringify({
    hooks: [
        { id: 'no-debug', fileTypes: ['*.ts'], severity: 'error',
            validation: { type: 'regex', pattern: 'DEBUG', message: 'Remove debug marker.' } },
        { id: 'naming', fileTypes: ['ts'],
            validation: { type: 'filename', pattern: '^[a-z-]+\\.ts$', message: 'Use kebab-case.' } },
        { id: 'size', fileTypes: ['.ts'],
            validation: { type: 'filesize', maxSize: 0.01, message: 'Size: {size} KiB.' } },
    ],
});

test('validates steering front matter without requiring it for ordinary Markdown', () => {
    assert.deepEqual(checkSteering('# Coding guide\nUse TypeScript.'), []);
    assert.deepEqual(checkSteering('---\r\ninclusion: fileMatch\r\nfileMatchPattern: ["**/*.ts"]\r\n---\r\n# Rule'), []);
    assert.match(checkSteering('---\ninclusion: fileMatch\n---')[0].message, /fileMatchPattern/);
    assert.match(checkSteering('---\ninclusion: auto\n---')[0].message, /description/);
    assert.match(checkSteering('---\ninclusion: manual')[0].message, /Close the YAML/);
});

test('reports regex, filename and filesize rules with UTF-16 offsets', () => {
    const { rules, problems } = parseQualityRules(config);
    assert.deepEqual(problems, []);
    const issues = checkQuality('src/BadName.ts', 'a😀DEBUG\n😀DEBUG', rules);
    assert.deepEqual(issues.map(issue => [issue.code, issue.severity, issue.offset]), [
        ['no-debug', 'error', 3], ['no-debug', 'error', 11], ['naming', 'warning', 0], ['size', 'warning', 0],
    ]);
    assert.deepEqual(checkQuality('src/file.js', 'DEBUG', rules), []);
});

test('surfaces unsupported rules while keeping valid rules active', () => {
    const { rules, problems } = parseQualityRules(JSON.stringify({ hooks: [
        ...JSON.parse(config).hooks,
        { id: 'lookahead', fileTypes: ['*'],
            validation: { type: 'regex', pattern: '(?=x)', message: 'Unsupported.' } },
        { id: 'shell', trigger: 'onCommit', fileTypes: ['*'],
            validation: { type: 'command', message: 'Unsupported.' } },
    ] }));
    assert.equal(rules.length, 3);
    assert.match(problems[0].message, /RE2/);
    assert.match(problems[1].message, /onFileSave/);
});

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'rpa-steering-test-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
    const workspace = join(root, 'workspace');
    const pack = join(root, 'pack');
    await Promise.all([
        mkdir(join(workspace, '.kiro', 'steering'), { recursive: true }),
        mkdir(join(pack, 'steering'), { recursive: true }),
    ]);
    return { workspace, pack };
}

test('previews adds and replacements, then applies exactly the reviewed snapshot', async t => {
    const { workspace, pack } = await fixture(t);
    const target = join(workspace, '.kiro/steering/team.md');
    await writeFile(target, '# Before\r\n');
    await writeFile(join(pack, 'steering/team.md'), '# After\n');
    await writeFile(join(pack, 'quality.json'), config);
    const changes = await previewPack(pack, workspace);
    assert.deepEqual(changes, [
        { path: '.kiro/steering/team.md', before: '# Before\r\n', after: '# After\n' },
        { path: '.kiro/rpa-quality.json', before: undefined, after: config },
    ]);
    assert.equal(await readFile(target, 'utf8'), '# Before\r\n');
    await writeFile(join(pack, 'steering/team.md'), '# Unreviewed\n');
    await applyPack(workspace, changes, () => false);
    assert.equal(await readFile(target, 'utf8'), '# After\n');
    assert.equal(await readFile(join(workspace, '.kiro/rpa-quality.json'), 'utf8'), config);
});

test('rejects stale or dirty targets and rolls back a partially applied pack', async t => {
    const { workspace, pack } = await fixture(t);
    await writeFile(join(pack, 'steering/a.md'), '# A');
    await writeFile(join(pack, 'steering/b.md'), '# B');
    const changes = await previewPack(pack, workspace);
    const first = join(workspace, '.kiro/steering/a.md');
    const second = join(workspace, '.kiro/steering/b.md');
    await writeFile(second, '# Changed outside preview');
    await assert.rejects(applyPack(workspace, changes, () => false), /changed since preview/);
    assert.equal(existsSync(first), false);
    assert.equal(await readFile(second, 'utf8'), '# Changed outside preview');
    const fresh = await previewPack(pack, workspace);
    await assert.rejects(applyPack(workspace, fresh, file => basename(file) === 'b.md' && existsSync(first)), /unsaved edits/);
    assert.equal(existsSync(first), false);
    assert.equal(await readFile(second, 'utf8'), '# Changed outside preview');
});
