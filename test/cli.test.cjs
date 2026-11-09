const assert = require('node:assert/strict');
const { copyFile, mkdtemp, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { KiroCli } = require('../dist/cli');

async function fixture(t, { oldCli = false, ...overrides } = {}) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'kiro-acp-test-'));
    await copyFile(path.join(__dirname, 'fixture', 'acp'), path.join(cwd, 'acp'));
    if (oldCli) {
        await writeFile(path.join(cwd, '.legacy-acp'), '');
    }
    const events = [];
    const sessions = [];
    const logs = [];
    const cli = new KiroCli({
        executable: process.execPath,
        cwd,
        log: text => logs.push(text),
        session: (id, state) => {
            events.push(id);
            sessions.push(state);
        },
        update: ({ update }) => events.push(update.content?.text ?? update.status),
        disconnected: reason => events.push(reason),
        permission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
        ...overrides,
    });
    t.after(async () => {
        cli.dispose();
        await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
        if (logs.length) {
            t.diagnostic(logs.join(''));
        }
    });
    return { cli, events, sessions };
}

test('negotiates ACP v1 and streams chat and tool updates through a permission request', { timeout: 10_000 }, async t => {
    const { cli, events } = await fixture(t);
    assert.equal((await cli.connect()).loadSession, true);
    await cli.openSession();
    assert.equal((await cli.setConfig('model', 'model-b')).configOptions[0].currentValue, 'model-b');
    assert.equal((await cli.prompt('Say hello')).stopReason, 'end_turn');
    assert.deepEqual(events, ['live', 'Xin ', 'pending', 'completed', 'chào!']);
});

test('loads a paginated session and replays only its updates after the session is adopted', { timeout: 10_000 }, async t => {
    const { cli, events } = await fixture(t);
    await cli.connect();
    const first = await cli.list();
    assert.equal(first.sessions[0].sessionId, 'past');
    assert.deepEqual((await cli.list(first.nextCursor)).sessions, []);
    await cli.openSession('past');
    assert.equal(cli.sessionId, 'past');
    assert.deepEqual(events, ['past', 'Previous question', 'Previous answer']);
});

test('cancels the active turn and releases its pending permission', { timeout: 10_000 }, async t => {
    const started = Promise.withResolvers();
    const { cli } = await fixture(t, {
        permission: (_, signal) => new Promise(resolve => {
            signal.addEventListener('abort', () => resolve({ outcome: { outcome: 'cancelled' } }), { once: true });
            started.resolve();
        }),
    });
    await cli.connect();
    await cli.openSession();
    const result = cli.prompt('Cancel me');
    await started.promise;
    await cli.cancel();
    assert.equal((await result).stopReason, 'cancelled');
});

test('rejects pending requests when the CLI exits', { timeout: 10_000 }, async t => {
    const { cli, events } = await fixture(t);
    await cli.connect();
    await cli.openSession();
    await assert.rejects(cli.prompt('Exit'));
    assert.equal(cli.sessionId, undefined);
    assert.match(events.at(-1), /Kiro CLI (closed|exited)/);
});

test('reports a missing executable and resets the connection', { timeout: 10_000 }, async t => {
    const { cli, events } = await fixture(t, { executable: path.join(os.tmpdir(), 'nonexistent-kiro-cli.exe') });
    await assert.rejects(cli.connect());
    assert.match(events.at(-1), /Could not run .*rpaKiro\.cliPath/);
});

test('selects V2 explicitly and uses the advertised legacy model API', { timeout: 10_000 }, async t => {
    const { cli, events, sessions } = await fixture(t, {
        engine: 'v2',
        args: ['--agent-engine=v3', '--agent-engine', 'v3', '--agent', 'example-agent'],
    });
    const capabilities = await cli.connect();
    assert.equal(capabilities.loadSession, true);
    assert.equal(capabilities.sessionCapabilities?.list, undefined);
    await cli.openSession();
    const [model] = sessions[0].configOptions;
    assert.equal(model.currentValue, 'model-a');
    assert.deepEqual(model.options.map(option => option.value), ['model-a', 'model-b']);
    await assert.rejects(cli.setConfig(model.id, 'unadvertised'), /did not advertise/);
    const result = await cli.setConfig(model.id, 'model-b');
    assert.equal(result.configOptions[0].currentValue, 'model-b');
    assert.equal((await cli.prompt('Say hello')).stopReason, 'end_turn');
    assert.deepEqual(events, ['live', 'Xin ', 'pending', 'completed', 'chào!']);
});

test('starts an older V2 CLI without the engine flag and loads history by ID', { timeout: 10_000 }, async t => {
    const { cli, events, sessions } = await fixture(t, { engine: 'v2', oldCli: true });
    assert.equal((await cli.connect()).loadSession, true);
    await cli.openSession('past');
    assert.equal(sessions[0].configOptions[0].currentValue, 'model-b');
    assert.deepEqual(events, ['past', 'Previous question', 'Previous answer']);
});

test('keeps an existing empty ACP argument list as a legacy launch override', { timeout: 10_000 }, async t => {
    const { cli } = await fixture(t, { args: [], oldCli: true });
    assert.equal((await cli.connect()).loadSession, true);
});
