const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const prefix = path.resolve(os.tmpdir(), 'evolution-session-update-');
assert.equal(path.dirname(prefix), path.resolve(os.tmpdir()));
const temporary = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = path.join(temporary, 'data');
const { inspectDeploymentImpact } = require('../src/services/evolution-deployment-impact');
const { requestParent, legacyHasNoLiveWx, prepareUpdatePreflight } = require('../src/services/wx-update-preflight');
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const head = 'a'.repeat(40);
function write(relative, body) {
  const file = path.resolve(temporary, relative);
  assert.equal(file.startsWith(temporary + path.sep), true);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}
function repo(name) {
  const dir = path.join(temporary, name);
  write(`${name}/core/src/runtime.js`, 'module.exports=1;');
  write(`${name}/core/test/example.test.js`, 'old test');
  write(`${name}/docs/guide.md`, 'old guide');
  write(`${name}/docs/CHANGELOG.md`, 'old release notes');
  write(`${name}/core/package.json`, '{}');
  const git = args => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git(['init', '-q']); git(['add', '.']);
  return dir;
}

test('exact production bytes and modes preserve connections for test/docs-only updates; runtime and dependencies require deployment', () => {
  const left = repo('prior'); const right = repo('next');
  write('next/core/test/example.test.js', 'new test'); write('next/docs/guide.md', 'new guide');
  assert.equal(inspectDeploymentImpact(left, right).equivalent, true);
  write('next/docs/CHANGELOG.md', 'new release notes');
  assert.equal(inspectDeploymentImpact(left, right).equivalent, false,
    '单改前端实际导入的更新记录必须重新交付资源，不能误报无需部署');
  write('next/docs/CHANGELOG.md', 'old release notes');
  for (const file of ['core/src/runtime.js', 'core/package.json']) {
    const original = fs.readFileSync(path.join(right, file));
    write(`next/${file}`, 'changed');
    assert.equal(inspectDeploymentImpact(left, right).equivalent, false);
    write(`next/${file}`, original);
  }
  const file = path.join(right, 'core/src/runtime.js'); const mode = fs.statSync(file).mode & 0o777;
  try { fs.chmodSync(file, mode ^ 0o100); assert.equal(inspectDeploymentImpact(left, right).equivalent, false); }
  finally { fs.chmodSync(file, mode); }
});

function evolverFixture() {
  const filename = path.resolve(__dirname, '../src/services/activity-evolver.js');
  const sourceRequire = createRequire(filename);
  const data = path.join(temporary, 'service-data');
  const taskRoot = path.join(temporary, 'validated-task');
  write('validated-task/README.md', 'fixture');
  const counters = { spawns: 0, runtimePreparations: 0 };
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, process, Buffer, URL, console,
    __filename: filename, __dirname: path.dirname(filename),
    require(name) {
      if (name === '../config/runtime-paths') return { getDataFile: file => path.join(data, file) };
      if (name === './evolution-deployment-impact') return { inspectDeploymentImpact: () => ({ equivalent: true, productionFingerprint: 'fixture-production' }) };
      if (name === './evolution-validation') return {
        logicSnapshot: () => ({ fingerprint: 'fixture-source' }),
        getValidationSummary: () => ({ state: 'passed', fingerprint: 'fixture-source', checks: ['backend'] }),
      };
      if (name === './evolution-publish') return { readProvenance: () => ({ taskRoot }),
        verifyTaskWorkspace: () => ({ ok: true }), prepareRuntimeWorkspace: () => { counters.runtimePreparations += 1; throw new Error('no_runtime_materialization_expected'); } };
      if (name === 'node:child_process') return { ...sourceRequire(name),
        execSync: command => command.startsWith('git rev-parse') ? head : '', execFileSync: () => head,
        spawn: () => { counters.spawns += 1; throw new Error('must_not_stop_or_spawn'); } };
      return sourceRequire(name);
    },
  });
  vm.runInContext(`${fs.readFileSync(filename, 'utf8')}\nmodule.exports.testAccess={writeState,readState, configure(value){deps=value;runningCommit='${head}';runningSourceFingerprint='fixture-source';}};`, context, { filename });
  const access = module.exports.testAccess;
  access.configure({});
  access.writeState({ status: 'pending_apply', commit: head, candidateTaskRoot: taskRoot });
  return { service: module.exports, access, counters, data };
}

test('actual application settles equivalent changes without helper, new process identity, runtime certificate or second application', () => {
  const f = evolverFixture();
  const certificate = write('service-data/evolution-approved-runtime.json', '{"previous":true}');
  const result = f.service.applyEvolution();
  assert.equal(result.ok, true, result.error); assert.equal(result.restarted, false);
  assert.equal(f.counters.spawns, 0); assert.equal(f.counters.runtimePreparations, 0);
  assert.equal(fs.readFileSync(certificate, 'utf8'), '{"previous":true}');
  const state = f.access.readState();
  assert.equal(state.status, 'applied_no_restart');
  assert.equal(state.deployment.runningPid, process.pid);
  assert.equal(state.deployment.runningCommit, head);
  assert.equal(f.service.applyEvolution().ok, false);
});

test('parent preflight ownership is single-flight and stale preparation cannot authorize stopping', async () => {
  const f = evolverFixture();
  let resolve;
  let calls = 0;
  f.access.configure({ prepareWxRestart: () => { calls += 1; return new Promise(done => { resolve = done; }); }, validateWxRestart: () => true });
  f.access.writeState({ status: 'applying', commit: head });
  const child = new EventEmitter(); child.connected = true; const replies = []; child.send = message => replies.push(message);
  assert.equal(typeof f.service.bindWxRestartIpc, 'function');
  f.service.bindWxRestartIpc(child, { targetCommit: head, oldPid: 123, oldStartTicks: '456' });
  const request = { type: 'wx_restart_request', action: 'prepare', nonce: 'fixture-restart-nonce', targetCommit: head, oldPid: 123, oldStartTicks: '456', requestId: 'first' };
  child.emit('message', request); child.emit('message', { ...request, requestId: 'duplicate' });
  assert.equal(calls, 1);
  f.access.writeState({ status: 'pending_apply', commit: head });
  resolve({ ok: true, handoff: { code: 'must-not-be-delivered' } });
  await new Promise(done => setImmediate(done));
  assert.equal(replies.every(reply => reply.ok === false && !reply.handoff), true);
});

test('helper preparation timeout/disconnect/rejection never grants stopping permission', async () => {
  for (const event of ['timeout', 'disconnect', 'reject']) {
    const peer = new EventEmitter(); peer.send = (message, cb) => {
      cb?.();
      if (event === 'disconnect') queueMicrotask(() => peer.emit('disconnect'));
      if (event === 'reject') queueMicrotask(() => peer.emit('message', { ...message, type: 'wx_restart_response', ok: false }));
    };
    await assert.rejects(requestParent(peer, { action: 'prepare', requestId: 'fixture', nonce: 'fixture', targetCommit: head }, 5));
    assert.equal(peer.listenerCount('message'), 0); assert.equal(peer.listenerCount('disconnect'), 0);
  }
});

test('helper cancellation and exit revoke the preparation guard before delayed work can continue', async () => {
  for (const event of ['exit', 'disconnect', 'cancel']) {
    const f = evolverFixture(); let resolve; let guard;
    f.access.configure({ prepareWxRestart: input => {
      guard = input.guard; return new Promise(done => { resolve = done; });
    } });
    f.access.writeState({ status: 'applying', commit: head });
    const child = new EventEmitter(); child.connected = true; const replies = []; child.send = reply => replies.push(reply);
    assert.equal(typeof f.service.bindWxRestartIpc, 'function');
    f.service.bindWxRestartIpc(child, { targetCommit: head, oldPid: 123, oldStartTicks: '456' });
    const message = { type: 'wx_restart_request', action: 'prepare', nonce: 'fixture-restart-nonce',
      targetCommit: head, oldPid: 123, oldStartTicks: '456', requestId: 'fixture' };
    child.emit('message', message);
    assert.equal(guard(), true);
    if (event === 'cancel') child.emit('message', { ...message, type: 'wx_restart_cancel' });
    else child.emit(event);
    assert.equal(guard(), false);
    resolve({ ok: true, handoff: { code: 'undelivered' } });
    await new Promise(done => setImmediate(done));
    assert.equal(replies.every(r => r.ok === false && !r.handoff), true);
  }
});

test('legacy migration requires explicit offline evidence for every WX account', async () => {
  const dataDir = path.join(temporary, 'legacy-data');
  write('legacy-data/accounts.json', JSON.stringify({ accounts: [{ id: 'fixture-wx', platform: 'wx' }] }));
  write('legacy-data/admin-sessions.json', JSON.stringify([{ token: 'fixture-only', user: { role: 'admin' } }]));
  for (const connected of [true, null, false]) {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, data: { connection: { connected } } }) });
    assert.equal(await legacyHasNoLiveWx({ dataDir, adminPort: 0, fetchImpl }), connected === false);
  }
  const processRef = { connected: false };
  await assert.rejects(prepareUpdatePreflight({ processRef, dataDir, adminPort: 1 }));
});
