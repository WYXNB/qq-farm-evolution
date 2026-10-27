const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { test, after } = require('node:test');

function inside(root, target) {
    const resolved = path.resolve(root, target);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('fixture_escape');
    return resolved;
}
const tempRoot = path.resolve(os.tmpdir());
const fixture = fs.mkdtempSync(inside(tempRoot, 'farm-activity-events-'));
process.env.FARM_DATA_DIR = inside(fixture, 'import-data');
process.env.FARM_PRIVATE_CONFIG_FILE = inside(fixture, 'private-config.json');
const sourceFile = path.resolve(__dirname, '../src/services/activity-evolver.js');
const sourceRequire = createRequire(sourceFile);
const protectedFiles = [sourceFile, __filename, path.resolve(__dirname, './evolution-once-daily.test.js'),
    path.resolve(__dirname, '../src/controllers/admin-activity-update-routes.js')];
const snapshot = () => protectedFiles.map(file => ({ file, mode: fs.statSync(file).mode & 0o777,
    hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const original = snapshot();
after(() => {
    try { fs.rmSync(inside(tempRoot, fixture), { recursive: true, force: true }); }
    finally { assert.deepEqual(snapshot(), original, 'success/failure cleanup preserves candidate contents and modes'); }
});
function fixtureWriter(root, io = fs) {
    return {
        mkdir(target) { io.mkdirSync(inside(root, target), { recursive: true }); },
        write(target, content) { io.writeFileSync(inside(root, target), content); },
    };
}
const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-02-10T02:00:00Z');
const DAY = '2026-02-10';
const plain = value => JSON.parse(JSON.stringify(value));
const activityReport = (unknown = [71], ended = []) => ({ status: 'ok', unknownActivityIds: unknown,
    endedActivityIds: ended, online: { available: true, checkedActivityIds: unknown,
        activities: unknown.map(id => ({ id, name: '合成活动' })), groups: [] } });
let sequence = 0;
function harness(options = {}) {
    const dataDir = options.dataDir || inside(fixture, `case-${++sequence}`);
    fixtureWriter(fixture).mkdir(dataDir);
    const writer = fixtureWriter(dataDir);
    const slots = new Map();
    const launches = [];
    const clock = options.clock || { now: NOW };
    let report = options.report || activityReport();
    let handler;
    let realChild = false;
    const children = [];
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [clock.now])); }
        static now() { return clock.now; }
    }
    const fakeScheduler = {
        clear: name => slots.delete(name), clearAll: () => slots.clear(),
        setTimeoutTask: (name, delay, callback) => slots.set(name, { delay, callback }),
    };
    const noEffects = { info() {}, warn() {}, error() {} };
    const module = { exports: {} };
    const context = vm.createContext({ module, exports: module.exports, Buffer, URL, console, Date: Clock,
        __dirname: path.dirname(sourceFile), __filename: sourceFile,
        process: { ...process, env: { ...process.env, FARM_DATA_DIR: dataDir,
            FARM_PRIVATE_CONFIG_FILE: inside(dataDir, 'private-config.json') } },
        require: name => {
            if (name === '../config/runtime-paths') return { getDataFile: file => inside(dataDir, file) };
            if (name === './scheduler') return { createScheduler: () => fakeScheduler,
                getSchedulerRegistrySnapshot: () => ({ schedulers: [] }) };
            if (name === './logger') return { createModuleLogger: () => noEffects };
            if (name === './feishu-notify') return { sendFeishuText: async () => {}, isFeishuWebhook: () => false };
            if (name === './daily-feedback') return { getDailyFeedback: () => ({
                snapshot: () => ({}), captureBatch: () => ({ throughAt: clock.now }),
            }) };
            if (name === './evolution-sessions') return { ...sourceRequire(name),
                buildFreshHandoffContext: () => ({ directive: 'fixture bounded current handoff' }) };
            if (name === './evolution-github-feedback') return { ...sourceRequire(name),
                startGithubFeedbackCollector() {}, handlePublishedEvolution: async () => {} };
            if (name === './evolution-publish') return { ...sourceRequire(name),
                ensureHoldManifest() { throw new Error('isolated_fixture'); },
                createTaskWorkspace() { throw new Error('isolated_fixture'); }, ownerStorageRoot: (_dir, root) => root };
            if (name === 'node:child_process') return {
                execSync: command => command.includes('rev-parse') ? HEAD : '',
                execFileSync: (_file, _args, opts) => opts?.encoding ? '' : Buffer.alloc(0),
                execFile: () => { throw new Error('unexpected_async_command'); },
                spawn: () => {
                    if (!realChild) throw new Error('unexpected_process_spawn');
                    const child = new EventEmitter();
                    child.stdin = new EventEmitter(); child.stdin.end = () => {};
                    child.unref = () => {}; child.pid = 12345; children.push(child);
                    return child;
                },
            };
            return sourceRequire(name);
        },
    });
    // Only pre-existing production functions are exposed: the baseline can import and execute this fixture.
    vm.runInContext(`${fs.readFileSync(sourceFile, 'utf8')}
module.exports.testAccess = {readState,writeState,finalizeRecoveredEvolution,
 configure:value=>{deps=value;},setRunning:value=>{running=value;},
 missingCli:()=>{resolveClaudeBin=()=>'';resolveCodexBin=()=>'';},
 fakeCli:()=>{resolveClaudeBin=()=>'/fixture/claude';resolveCodexBin=()=>'/fixture/codex';}};`, context, { filename: sourceFile });
    const service = module.exports;
    const access = service.testAccess;
    const writeReport = value => {
        report = value;
        writer.write('activity-update-report.json', JSON.stringify(value));
    };
    writeReport(report);
    if (!options.dataDir) access.writeState({ status: 'no_change', autonomousEvolutionEnabled: true,
        evolutionEnabled: true, lastAutomaticEvolveDate: DAY, ...options.state });
    const config = {
        now: () => clock.now, readLatestReport: () => report, worktreeChanges: () => '',
        launchEvolution: (task, payload) => {
            launches.push({ task, payload: plain(payload), state: plain(access.readState()) });
            if (handler) return handler(task, payload);
            const state = access.readState();
            state.status = 'running'; state.lastTask = task; state.lastRunAutomatic = payload.automatic === true;
            access.writeState(state); access.setRunning(true);
            return { ok: true };
        },
    };
    access.configure(config);
    return { service, access, dataDir, slots, launches, clock, config, writeReport,
        children,
        realLaunch() { realChild = true; access.fakeCli(); access.configure({ ...config, launchEvolution: undefined }); },
        state: () => plain(access.readState()), save: value => access.writeState(value),
        setHandler: value => { handler = value; },
        async dispatch() {
            const entry = [...slots].find(([, task]) => task.delay === 0);
            assert.ok(entry, 'a new activity must schedule an immediate production callback');
            slots.delete(entry[0]); await entry[1].callback();
        },
    };
}

test('consumed daily quota does not block one immediate new/ended activity event', async () => {
    for (const report of [activityReport([71]), activityReport([], [81])]) {
        const f = harness({ report });
        f.service.checkAndMaybeEvolve(report);
        assert.equal(f.launches.length, 0, 'scan callback queues asynchronously');
        f.service.checkAndMaybeEvolve(report);
        assert.equal(f.slots.size, 1, 'repeated scan uses one scheduler slot');
        await f.dispatch();
        assert.equal(f.launches.length, 1);
        assert.equal(f.launches[0].task, 'activity');
        assert.equal(f.launches[0].payload.automatic, true);
        assert.deepEqual(f.launches[0].payload.newUnknown, report.unknownActivityIds);
        assert.deepEqual(f.launches[0].payload.newEnded, report.endedActivityIds);
        assert.equal(f.launches[0].state.activityEventFingerprints.length, 1, 'dedupe persists before launch');
        assert.equal(f.state().lastAutomaticEvolveDate, DAY);
        assert.equal(f.state().lastManualRunDate, '');
    }
});

test('busy scans only queue; an old task finishing releases the new activity immediately', async () => {
    const f = harness({ state: { status: 'running' } });
    f.access.setRunning(true);
    f.service.checkAndMaybeEvolve(activityReport());
    assert.equal(f.slots.size, 0);
    assert.equal(f.launches.length, 0);
    assert.deepEqual(f.state().pendingActivity.newUnknown, [71]);
    f.access.setRunning(false);
    f.save({ ...f.state(), status: 'no_change' });
    f.service.scheduleAutonomyFromState();
    await f.dispatch();
    assert.equal(f.launches.length, 1);
});

test('crash after durable event preparation resumes its original activity before first Agent launch', async () => {
    const f = harness();
    let prepared;
    f.setHandler(() => { prepared = f.state(); return { ok: true }; });
    f.service.checkAndMaybeEvolve(activityReport());
    await f.dispatch();
    assert.equal(prepared.status, 'interrupted');
    assert.equal(prepared.activeRun, null);
    assert.equal(prepared.autonomy.originalPrompt, '');
    const restarted = harness({ dataDir: f.dataDir });
    restarted.service.startActivityEvolver(restarted.config);
    assert.equal(restarted.slots.has('activity_evolution_event'), false, 'existing autonomy owns the interrupted preparation');
    await restarted.dispatch();
    assert.equal(restarted.launches.length, 1);
    assert.equal(restarted.launches[0].task, 'activity');
    assert.equal(restarted.launches[0].payload.preserveFeedbackBatch, false);
    assert.deepEqual(restarted.launches[0].payload.newUnknown, [71]);
    assert.equal(restarted.launches[0].payload.activityPlan.fingerprint, prepared.autonomy.activityPlan.fingerprint);
    assert.equal(restarted.state().lastAutomaticEvolveDate, DAY);
    assert.deepEqual(restarted.state().activityEventFingerprints, prepared.activityEventFingerprints);
});

test('event callback rereads both switches, enable and restart resume only an unattempted event', async () => {
    for (const key of ['evolutionEnabled', 'autonomousEvolutionEnabled']) {
        const f = harness();
        f.service.checkAndMaybeEvolve(activityReport());
        const callback = [...f.slots.values()][0]?.callback;
        assert.ok(callback, 'new event is queued before maintenance pause');
        f.save({ ...f.state(), [key]: false });
        await callback();
        assert.equal(f.launches.length, 0, 'stale scheduled callback observes pause');
        const restarted = harness({ dataDir: f.dataDir });
        restarted.service.startActivityEvolver(restarted.config);
        assert.equal(restarted.launches.length, 0);
        assert.equal([...restarted.slots.values()].some(item => item.delay === 0), false);
        restarted.service.setAutonomousEvolution(true);
        if (key === 'evolutionEnabled') {
            assert.equal([...restarted.slots.values()].some(item => item.delay === 0), false);
            restarted.service.setEvolutionEnabled(true);
        }
        await restarted.dispatch();
        assert.equal(restarted.launches.length, 1);
    }
});

test('startup failure keeps pending and original activity ownership with persistent backoff', async () => {
    for (const mode of ['failure', 'exception', 'missing_cli']) {
        const f = harness({ state: { lastTask: 'safety', lastRunAutomatic: true,
            autonomy: { originalPrompt: 'old safety task' }, collaboration: { checkpoint: { old: true } } } });
        if (mode === 'missing_cli') {
            f.access.missingCli();
            f.access.configure({ ...f.config, launchEvolution: undefined });
        } else f.setHandler(() => {
            if (mode === 'exception') throw new Error('fixture startup failure');
            return { ok: false, reason: 'fixture_failure' };
        });
        f.service.checkAndMaybeEvolve(activityReport());
        await f.dispatch();
        const failed = f.state();
        assert.equal(failed.status, 'failed');
        assert.equal(failed.lastTask, 'activity');
        assert.equal(failed.lastRunAutomatic, true);
        assert.deepEqual(failed.autonomy.activityPlan.newUnknown, [71]);
        assert.equal(failed.autonomy.originalPrompt, '');
        assert.equal(failed.collaboration, null, 'a new event cannot resume the previous safety checkpoint');
        assert.deepEqual(failed.pendingActivity.newUnknown, [71]);
        assert.ok(failed.autonomy.nextReworkAt >= NOW + 600000);
        f.service.checkAndMaybeEvolve(activityReport());
        assert.equal(f.state().autonomy.nextReworkAt, failed.autonomy.nextReworkAt);
        assert.equal([...f.slots.values()].some(item => item.delay === 0), false);
        const restarted = harness({ dataDir: f.dataDir });
        restarted.service.scheduleAutonomyFromState();
        assert.equal([...restarted.slots.values()].some(item => item.delay === 0), false);
        restarted.clock.now = failed.autonomy.nextReworkAt;
        await restarted.service.runAutonomyStep();
        const resumed = restarted.launches.at(-1);
        assert.ok(resumed);
        assert.equal(resumed.task, 'activity');
        assert.equal(resumed.payload.preserveFeedbackBatch, false, 'no prompt/batches were captured before the real first launch');
        assert.deepEqual(resumed.payload.newUnknown, [71]);
        assert.deepEqual(resumed.payload.report, activityReport());
    }
});

test('pending apply, privacy and an older failed task keep exclusive ownership', () => {
    for (const status of ['pending_apply', 'privacy_blocked', 'privacy_blocked_local', 'review_blocked', 'failed']) {
        const f = harness({ state: { status, lastTask: 'safety', lastRunAutomatic: true,
            autonomy: { originalPrompt: 'existing task', nextReworkAt: NOW + 600000 } } });
        f.service.checkAndMaybeEvolve(activityReport());
        assert.equal(f.launches.length, 0);
        assert.equal(f.state().lastTask, 'safety');
        assert.equal(f.state().autonomy.originalPrompt, 'existing task');
        assert.equal(f.slots.has('activity_evolution_event'), false);
    }
});

test('checkpoint, fresh and repairOnly continuation keep activity task, report and original plan identity', async () => {
    for (const kind of ['resume', 'fresh', 'continue']) {
        const plan = { shouldRun: true, newUnknown: [71], newEnded: [81], reviewIds: [91], fingerprint: 'b'.repeat(64) };
        const checkpoint = { version: 1, kind: 'in_run', baselineHead: HEAD,
            allowedFiles: [], fileFingerprints: {}, completed: [{ phase: 'research', decision: 'researched' }] };
        const f = harness({ state: {
            status: kind === 'continue' ? 'applied' : 'failed', lastTask: 'activity', lastRunAutomatic: true,
            combinedDaily: false, ...(kind === 'continue' ? { commit: HEAD } : {}),
            collaboration: kind === 'fresh' ? null : { checkpoint, ...(kind === 'continue' ? { repairOnly: true } : {}) },
            autonomy: { originalPrompt: 'original activity prompt', activityPlan: plan,
                ...(kind === 'continue' ? { continuation: { task: 'activity', automatic: true,
                    combinedDaily: false, activityPlan: plan } } : {}) },
        } });
        await f.service.runAutonomyStep();
        const launch = f.launches[0];
        assert.ok(launch, `${kind} must reach the existing Parent launch entry`);
        assert.equal(launch.task, 'activity');
        assert.equal(launch.payload.combinedDaily, false);
        assert.equal(launch.payload.preserveFeedbackBatch, true);
        assert.deepEqual(launch.payload.report, activityReport());
        assert.deepEqual(launch.payload.newUnknown, [71]);
        assert.deepEqual(launch.payload.newEnded, [81]);
        assert.deepEqual(launch.payload.reviewIds, [91]);
        assert.equal(launch.payload.activityPlan.fingerprint, plan.fingerprint);
        if (kind !== 'fresh') assert.equal(launch.payload.resume, kind === 'continue' ? 'continuation' : 'checkpoint');
    }
});

async function until(check) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (check()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('real Parent completion did not settle');
}

test('real launch after missing CLI captures a fresh batch and normal completion leaves newer pending activity', async () => {
    const f = harness({ state: { defaultAgent: 'codex', mainAgent: 'codex',
        feedbackBatch: { throughAt: NOW - 1000 }, lastTask: 'safety' } });
    f.access.missingCli();
    f.access.configure({ ...f.config, launchEvolution: undefined });
    f.service.checkAndMaybeEvolve(activityReport());
    await f.dispatch();
    assert.equal(f.state().status, 'failed');
    const originalFingerprint = f.state().autonomy.activityPlan.fingerprint;
    f.clock.now = f.state().autonomy.nextReworkAt;
    f.realLaunch();
    await f.service.runAutonomyStep();
    const active = f.state().activeRun;
    assert.ok(active, 'the actual Parent records the real synthetic child, not a mocked launch result');
    assert.equal(active.task, 'activity');
    assert.equal(active.evidenceFingerprint, originalFingerprint);
    assert.equal(f.state().feedbackBatch.throughAt, f.clock.now, 'first real launch must not reuse the previous safety batch');
    f.writeReport(activityReport([71, 72]));
    f.service.checkAndMaybeEvolve(activityReport([71, 72]));
    assert.deepEqual(f.state().pendingActivity.newUnknown, [71, 72]);
    f.children[0].emit('exit', 0, '');
    await until(() => f.state().status === 'no_change' && [...f.slots.values()].some(item => item.delay === 0));
    assert.deepEqual(f.state().handledUnknownIds, [71]);
    assert.deepEqual(f.state().pendingActivity.newUnknown, [72]);
    assert.equal(f.state().lastAutomaticEvolveDate, DAY);
    assert.ok([...f.slots.values()].some(item => item.delay === 0), 'the newer event is released by actual finalize');
});

test('actual recovered completion settles only its captured batch and schedules the newer pending event', async () => {
    const active = { runId: 'recovered-activity', task: 'activity', agent: 'codex', subAgent: 'claude', dualAgentEnabled: true,
        baseCommit: HEAD, newUnknown: [71], newEnded: [81], reviewIds: [],
        evidenceFingerprint: 'c'.repeat(64), launchedAt: NOW - 1000 };
    const f = harness({ report: activityReport([71, 72], [81, 82]), state: {
        status: 'running', activeRun: active, lastTask: 'activity', lastRunAutomatic: true,
        pendingActivity: { newUnknown: [71, 72], newEnded: [81, 82], updatedAt: NOW },
    } });
    const writer = fixtureWriter(f.dataDir);
    writer.mkdir('logs');
    writer.write(`logs/evolve-team-${active.runId}.json`, JSON.stringify({
        runId: active.runId, baseCommit: HEAD, mainAgent: 'codex', subAgent: 'claude',
        phase: 'complete', status: 'completed', decision: 'no_change', head: HEAD,
        lessons: [], feedbackReviewed: false,
    }));
    await f.access.finalizeRecoveredEvolution(active);
    assert.equal(f.state().status, 'no_change');
    assert.deepEqual(f.state().handledUnknownIds, [71]);
    assert.deepEqual(f.state().handledEndedIds, [81]);
    assert.deepEqual(f.state().pendingActivity.newUnknown, [72]);
    assert.deepEqual(f.state().pendingActivity.newEnded, [82]);
    await f.dispatch();
    assert.deepEqual(f.launches[0].payload.newUnknown, [72]);
    assert.deepEqual(f.launches[0].payload.newEnded, [82]);
});

test('fixture guard rejects actual mkdir/write primitives before effects and permits valid targets', () => {
    const counts = { mkdir: 0, write: 0 };
    const writer = fixtureWriter(fixture, {
        mkdirSync() { counts.mkdir += 1; }, writeFileSync() { counts.write += 1; },
    });
    for (const target of ['../outside', `${fixture}-outside/file`]) {
        assert.throws(() => writer.mkdir(target), /fixture_escape/);
        assert.throws(() => writer.write(target, ''), /fixture_escape/);
    }
    assert.deepEqual(counts, { mkdir: 0, write: 0 });
    writer.mkdir('valid'); writer.write('valid/data', 'synthetic');
    assert.deepEqual(counts, { mkdir: 1, write: 1 });
});
