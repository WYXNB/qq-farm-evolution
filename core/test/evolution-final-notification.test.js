const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function bounded(root, relative) {
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('fixture_escape');
    return target;
}
const temporary = fs.mkdtempSync(bounded(path.resolve(os.tmpdir()), 'farm-final-notification-'));
process.env.FARM_DATA_DIR = temporary;
process.env.FARM_PRIVATE_CONFIG_FILE = bounded(temporary, 'private-config.json');
const file = path.resolve(__dirname, '../src/services/activity-evolver.js');
const sourceRequire = createRequire(file);
const fingerprint = () => [file, __filename].map(name => ({ name,
    mode: fs.statSync(name).mode & 0o777,
    hash: crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex') }));
const before = fingerprint();
test.after(() => {
    try { fs.rmSync(temporary, { recursive: true, force: true }); }
    finally { assert.deepEqual(fingerprint(), before); }
});
const HEAD = 'a'.repeat(40);
const approved = { status: 'completed', phase: 'complete', head: HEAD, decision: 'approve' };

function fixture() {
    const sent = [];
    const local = [];
    const module = { exports: {} };
    const context = vm.createContext({ module, exports: module.exports,
        __dirname: path.dirname(file), __filename: file, process, Buffer, URL, console,
        require(name) {
            if (name === '../config/runtime-paths') return { getDataFile: relative => bounded(temporary, relative) };
            if (name === './logger') return { createModuleLogger: () => ({
                info: message => local.push(message), warn: message => local.push(message), error() {} }) };
            if (name === './feishu-notify') return { sendFeishuText: async (...args) => sent.push(args), isFeishuWebhook: () => true };
            if (name === 'node:child_process') return { ...sourceRequire(name),
                execSync: () => HEAD, execFileSync: () => { throw new Error('unexpected_command'); },
                spawn: () => { throw new Error('unexpected_process'); } };
            return sourceRequire(name);
        },
    });
    // notify/readState/writeState already exist in the old implementation too.
    vm.runInContext(`${fs.readFileSync(file, 'utf8')}\nmodule.exports.testAccess={notify,writeState,evolutionNotificationTitle};`, context, { filename: file });
    return { ...module.exports.testAccess, sent, local };
}

test('worker failures and intermediate events remain local until the Main approves the complete result', async () => {
    const f = fixture();
    for (const status of ['running', 'failed', 'review_blocked', 'deferred', 'push_failed']) {
        f.writeState({ status, dualAgentEnabled: true, commit: HEAD });
        await f.notify('活动进化状态', '子工具执行异常');
    }
    assert.equal(f.sent.length, 0);
    assert.equal(f.local.length, 5, 'suppression must retain diagnostic evidence');
});

test('even an approved state cannot send an intermediate notification', async () => {
    const f = fixture();
    f.writeState({ status: 'no_change', dualAgentEnabled: true, commit: HEAD, collaboration: approved });
    await f.notify('执行器恢复', '内部阶段');
    assert.equal(f.sent.length, 0);
    await f.notify('活动进化完成', '主 Agent 已验收', { finalApproved: true });
    assert.equal(f.sent.length, 1);
});

test('approved collaboration notifies before automatic application and confirms readiness afterward', async () => {
    const f = fixture();
    for (const autonomous of [true, false]) {
        f.writeState({ status: 'pending_apply', dualAgentEnabled: true, commit: HEAD,
            autonomousEvolutionEnabled: autonomous, collaboration: approved });
        await f.notify('活动进化结果', '已验收待应用', { finalApproved: true });
        assert.equal(f.sent.length, autonomous ? 1 : 2);
    }
    f.writeState({ status: 'applied', dualAgentEnabled: true, commit: HEAD,
        autonomousEvolutionEnabled: true, collaboration: approved });
    await f.notify('活动进化已应用', '真实运行已就绪', { finalApproved: true });
    assert.equal(f.sent.length, 3);
    assert.equal(f.evolutionNotificationTitle('activity', 'pending_apply', true), '农场 bot 活动进化协作完成');
    assert.equal(f.evolutionNotificationTitle('activity', 'pending_apply', false), '农场 bot 活动进化待确认');
});

test('repairOnly, wrong head, unapproved and failed records cannot masquerade as a final result', async () => {
    const f = fixture();
    for (const collaboration of [null, { ...approved, repairOnly: true },
        { ...approved, head: 'b'.repeat(40) }, { ...approved, status: 'failed' }]) {
        f.writeState({ status: 'applied', dualAgentEnabled: true, commit: HEAD, collaboration });
        await f.notify('活动进化结果', '候选', { finalApproved: true });
    }
    assert.equal(f.sent.length, 0);
});

test('single Agent notification behavior remains available', async () => {
    const f = fixture();
    f.writeState({ status: 'failed', dualAgentEnabled: false });
    await f.notify('执行状态', '真实异常');
    assert.equal(f.sent.length, 1);
});
