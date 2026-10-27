const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'farm-repair-memory-'));
process.env.FARM_DATA_DIR = root;
const { createRepairMemory } = require('../src/services/evolution-main-workflow');
const { readVerificationFailureDetails, executeStreaming } = require('../scripts/run-evolution-team');
const sources = [__filename, '../src/services/evolution-main-workflow.js', '../scripts/run-evolution-team.js']
    .map(file => path.resolve(__dirname, file));
const snapshot = () => sources.map(file => ({ file, mode: fs.statSync(file).mode & 0o777,
    digest: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const before = snapshot();
const target = name => {
    const file = path.resolve(root, name);
    if (file !== root && !file.startsWith(root + path.sep)) throw new Error('fixture_escape');
    return file;
};
test.after(() => {
    try { fs.rmSync(target('.'), { recursive: true, force: true }); }
    finally { assert.deepEqual(snapshot(), before); }
});

test('all repair events stay readable while only eight summaries are injected into the next session', () => {
    const dir = target('history'); fs.mkdirSync(dir);
    const identity = { task: 'activity', promptDigest: 'a'.repeat(64) };
    const memory = createRepairMemory({ dataDir: dir, logDir: path.join(dir, 'logs-one'), identity });
    const first = memory.append('main_repair', { summary: 'first precise cause', remainingIssues: ['first actual gap'] });
    for (let i = 0; i < 12; i += 1) memory.append('main_repair', { summary: `repair ${i}`, nextStep: `verify ${i}` });
    const checkpoint = memory.checkpoint();
    assert.equal(checkpoint.recent.length, 8);
    const next = createRepairMemory({ dataDir: dir, logDir: path.join(dir, 'another-native-session'), identity, inherited: checkpoint });
    assert.equal(next.location().sequence, checkpoint.sequence + 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(first)).remainingIssues, ['first actual gap']);
    assert.equal(fs.statSync(next.location().directory).mode & 0o777, 0o700);
    for (const name of fs.readdirSync(next.location().directory)) {
        assert.equal(fs.statSync(path.join(next.location().directory, name)).mode & 0o777, 0o600);
    }
    fs.unlinkSync(next.location().indexFile);
    const recovered = createRepairMemory({ dataDir: dir, logDir: path.join(dir, 'third-session'), identity,
        inherited: next.checkpoint() });
    assert.equal(recovered.location().sequence, next.location().sequence + 1);
    assert.ok(fs.existsSync(first), 'checkpoint recovery does not discard older full records');
});

test('symlink memory roots are rejected before filesystem mutation; a valid root writes normally', () => {
    const dir = target('boundary'); const outside = target('outside');
    fs.mkdirSync(dir); fs.mkdirSync(outside);
    const marker = path.join(outside, 'marker'); fs.writeFileSync(marker, 'unchanged');
    const priorMode = fs.statSync(marker).mode & 0o777;
    const link = path.join(dir, 'evolution-task-memory'); fs.symlinkSync(outside, link);
    const originals = Object.fromEntries(['mkdirSync', 'writeFileSync', 'renameSync', 'chmodSync'].map(name => [name, fs[name]]));
    let mutations = 0;
    try {
        for (const [name, original] of Object.entries(originals)) fs[name] = (...args) => { mutations += 1; return original(...args); };
        assert.throws(() => createRepairMemory({ dataDir: dir, logDir: path.join(dir, 'logs'), identity: { task: 'synthetic' } }),
            { code: 'unsafe_worktree' });
        assert.equal(mutations, 0);
        fs.unlinkSync(link);
        createRepairMemory({ dataDir: dir, logDir: path.join(dir, 'logs'), identity: { task: 'synthetic' } });
        assert.ok(mutations > 0, 'the guarded legitimate write path really executes');
    } finally {
        for (const [name, original] of Object.entries(originals)) fs[name] = original;
        assert.equal(fs.readFileSync(marker, 'utf8'), 'unchanged');
        assert.equal(fs.statSync(marker).mode & 0o777, priorMode);
    }
});

test('failure details include early failures beyond the old tail window and preserve Unicode across buffers', () => {
    const file = target('verification.log');
    const name = 'ordinary returned failure retains deadline · 截止证据';
    const log = `not ok 1 - ${name}\n  error: expected preserved cutoff\n${'unrelated passing output\n'.repeat(7000)}# tests 90\n# pass 89\n# fail 1\n# skipped 0\n`;
    fs.writeFileSync(file, log);
    const details = readVerificationFailureDetails(file);
    assert.deepEqual(details.counts, { tests: 90, pass: 89, fail: 1, skipped: 0 });
    assert.deepEqual(details.failedTests, [name]);
    assert.deepEqual(details.errors, ['error: expected preserved cutoff']);
});

test('the native idle deadline resets on progress and still cancels an actually silent CLI', async () => {
    await executeStreaming(process.execPath, ['-e', 'let n=0;const t=setInterval(()=>{process.stdout.write("progress\\n");if(++n===12)clearInterval(t)},250)'],
        { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 0, idleTimeoutMs: 2500 });
    await assert.rejects(executeStreaming(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
        { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 0, idleTimeoutMs: 80 }), { code: 'cli_exit' });
});
