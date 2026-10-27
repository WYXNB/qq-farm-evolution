const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, { timeout: 10000 }, body);
test.after = nodeTest.after;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const tempRoot = fs.realpathSync(os.tmpdir());
function inside(file, directory) {
    const result = path.resolve(file);
    assert.ok(result.startsWith(`${directory}${path.sep}`));
    return result;
}
const fixture = fs.mkdtempSync(inside(path.join(tempRoot, 'farm-main-mcp-test-'), tempRoot));
const previousDataDir = process.env.FARM_DATA_DIR;
process.env.FARM_DATA_DIR = fixture;
const sources = ['core/src/services/evolution-main-mcp.js', 'core/scripts/run-evolution-main-mcp.js',
    'core/test/evolution-main-mcp.test.js'];
function fingerprint() {
    return sources.map(name => {
        const file = path.join(root, name); const stat = fs.lstatSync(file);
        assert.equal(stat.isSymbolicLink(), false);
        return [name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), stat.mode & 0o777];
    });
}
const original = fingerprint();
const resources = new Set();
test.after(async () => {
    try {
        const cleanup = await Promise.allSettled([...resources].map(close => close()));
        assert.ok(cleanup.every(item => item.status === 'fulfilled'));
    } finally {
        try { assert.deepEqual(fingerprint(), original, 'all source bytes and permissions are checked after the whole suite'); }
        finally {
            fs.rmSync(inside(fixture, tempRoot), { recursive: true, force: true });
            if (previousDataDir === undefined) delete process.env.FARM_DATA_DIR;
            else process.env.FARM_DATA_DIR = previousDataDir;
        }
    }
});
const { createMainToolBridge } = require('../src/services/evolution-main-mcp');
const tools = [{ name: 'delegate_implementation', description: 'Synthetic bounded worker task',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, additionalProperties: false } }];
const result = text => ({ content: [{ type: 'text', text }] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
    let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve };
}
async function bridge(t, handler, create = createMainToolBridge) {
    const value = await create({ tools, instructions: 'Main owns the result.', handler });
    const close = async () => { await value.close(); resources.delete(close); };
    resources.add(close); t.after(close);
    return { ...value, capFile: value.mcp.args[2], close };
}
async function client(t, value) {
    const child = spawn(value.mcp.command, value.mcp.args, {
        cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FARM_DATA_DIR: fixture },
    });
    const messages = [];
    const waiting = new Map();
    let buffer = ''; let stderr = '';
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        buffer += chunk;
        for (;;) {
            const end = buffer.indexOf('\n'); if (end < 0) break;
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            if (!line) continue;
            const message = JSON.parse(line); messages.push(message);
            if (waiting.has(message.id)) { const yes = waiting.get(message.id); waiting.delete(message.id); yes(message); }
        }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const close = async () => {
        child.stdin.end();
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        try { await exited; } finally { clearTimeout(timer); resources.delete(close); }
    };
    resources.add(close); t.after(close);
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    const response = id => {
        const existing = messages.find(message => message.id === id);
        if (existing) return Promise.resolve(existing);
        return Promise.race([new Promise(resolve => waiting.set(id, resolve)),
            delay(2500).then(() => { throw new Error(`No synthetic RPC response ${id}`); })]);
    };
    const request = async (id, method, params = {}) => { send({ jsonrpc: '2.0', id, method, params }); return response(id); };
    return { child, messages, send, request, response, exited, close, stderr: () => stderr };
}
async function initialize(c, id = 1, version = '2025-06-18') {
    const reply = await c.request(id, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } });
    assert.equal(reply.result.protocolVersion, version);
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return reply.result;
}
function socketRequest(cap, payload) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(cap.socketPath);
        let buffer = '';
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('Synthetic socket timeout')); }, 1500);
        socket.once('connect', () => socket.write(`${JSON.stringify({ token: cap.token, ...payload })}\n`));
        socket.on('data', chunk => { buffer += chunk; });
        socket.on('error', reject);
        socket.once('close', () => {
            clearTimeout(timer);
            try { resolve(buffer ? JSON.parse(buffer) : null); } catch (error) { reject(error); }
        });
    });
}

test('actual stdio handshake lists only whitelisted tools and returns parent handler result', async t => {
    const calls = [];
    const b = await bridge(t, async (name, args, context) => { calls.push({ name, args, signal: context.signal }); return result('parent verified'); });
    const directory = path.dirname(b.capFile);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(b.capFile).mode & 0o777, 0o600);
    const cap = JSON.parse(fs.readFileSync(b.capFile));
    assert.equal(fs.statSync(cap.socketPath).mode & 0o777, 0o600);
    const c = await client(t, b);
    const hello = await initialize(c);
    assert.equal(hello.instructions, 'Main owns the result.');
    assert.deepEqual(hello.capabilities, { tools: { listChanged: false } });
    assert.deepEqual((await c.request(2, 'tools/list')).result.tools, tools);
    assert.deepEqual((await c.request(3, 'ping')).result, {});
    assert.deepEqual((await c.request(4, 'tools/call', { name: tools[0].name, arguments: { task: 'synthetic change' } })).result, result('parent verified'));
    assert.equal(calls.length, 1); assert.equal(calls[0].signal.aborted, false);
    assert.deepEqual(calls[0].args, { task: 'synthetic change' });
    assert.equal(c.stderr(), '');
    assert.equal(JSON.stringify(c.messages).includes(cap.token), false);
    await c.close(); await b.close(); await b.close();
    assert.equal(fs.existsSync(directory), false);
});

test('a long isolated TMPDIR still supports a private socket and actual stdio calls', async t => {
    const longDirectory = inside(path.join(fixture, 'long-temp-'.repeat(12)), fixture);
    fs.mkdirSync(longDirectory, { mode: 0o700 });
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = longDirectory;
    let b;
    let c;
    try {
        b = await bridge(t, async () => result('long temp worked'));
        const cap = JSON.parse(fs.readFileSync(b.capFile));
        assert.ok(Buffer.byteLength(cap.socketPath) <= 100);
        assert.equal(fs.statSync(path.dirname(b.capFile)).mode & 0o777, 0o700);
        c = await client(t, b);
        await initialize(c);
        assert.deepEqual((await c.request(4, 'tools/call', {
            name: tools[0].name, arguments: {},
        })).result, result('long temp worked'));
    } finally {
        try { await c?.close(); await b?.close(); }
        finally {
            if (previous === undefined) delete process.env.TMPDIR;
            else process.env.TMPDIR = previous;
        }
    }
});

test('bad token, unknown socket method, unknown RPC and unknown tool never enter parent handler', async t => {
    let calls = 0; const b = await bridge(t, async () => { calls += 1; return result('should not run'); });
    const cap = JSON.parse(fs.readFileSync(b.capFile));
    const bad = await socketRequest(cap, { token: 'not-the-capability', method: 'call', name: tools[0].name, args: {} });
    assert.equal(bad.ok, false); assert.doesNotMatch(JSON.stringify(bad), /not-the-capability/);
    assert.equal((await socketRequest(cap, { method: 'execute-arbitrary' })).ok, false);
    const c = await client(t, b); await initialize(c);
    assert.equal((await c.request(2, 'execute-arbitrary')).error.code, -32601);
    assert.equal((await c.request(3, 'tools/call', { name: 'not_allowed', arguments: {} })).error.code, -32602);
    assert.equal((await c.request(4, 'tools/call', { name: tools[0].name, arguments: [] })).error.code, -32602);
    assert.equal(calls, 0);
});

test('cancellation and closing stdin abort exactly the active parent operation', async t => {
    const started = [deferred(), deferred()]; const aborted = [deferred(), deferred()]; let index = 0;
    const b = await bridge(t, async (_name, _args, { signal }) => {
        const current = index++; started[current].resolve();
        await new Promise(resolve => signal.addEventListener('abort', () => { aborted[current].resolve(); resolve(); }, { once: true }));
        return result('cancelled result must not become success');
    });
    const c = await client(t, b); await initialize(c);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tools[0].name, arguments: {} } });
    await started[0].promise;
    c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    assert.equal((await c.response(2)).error.code, -32800);
    await aborted[0].promise;
    c.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tools[0].name, arguments: {} } });
    await started[1].promise;
    await c.close(); await aborted[1].promise;
    assert.equal(c.messages.some(message => message.id === 3 && message.result), false);
});

test('bridge close aborts active operation, rejects new requests, removes its private paths', async t => {
    const started = deferred(); const aborted = deferred();
    const b = await bridge(t, async (_name, _args, { signal }) => {
        started.resolve(); await new Promise(resolve => signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
        return result('late');
    });
    const cap = JSON.parse(fs.readFileSync(b.capFile)); const c = await client(t, b); await initialize(c);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tools[0].name } });
    await started.promise; await b.close(); await aborted.promise;
    assert.equal((await c.response(2)).error.code, -32603);
    assert.equal(fs.existsSync(path.dirname(b.capFile)), false);
    await assert.rejects(socketRequest(cap, { method: 'metadata' }));
});

test('oversized stdin and socket requests are bounded before any handler call', async t => {
    let calls = 0; const b = await bridge(t, async () => { calls += 1; return result('never'); });
    const cap = JSON.parse(fs.readFileSync(b.capFile));
    const large = 'x'.repeat(300 * 1024);
    await socketRequest(cap, { method: 'call', name: tools[0].name, args: { large } });
    const c = await client(t, b); await initialize(c);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tools[0].name, arguments: { large } } });
    await c.exited;
    assert.equal(calls, 0);
    assert.ok(c.messages.some(message => message.error?.message === 'Message exceeds limit'));
});

test('handler exceptions and huge returns become fixed errors without leaking raw exceptions or killing stdio', async t => {
    let count = 0;
    const b = await bridge(t, async () => {
        count += 1;
        if (count === 1) throw new Error('synthetic credential must remain hidden');
        if (count === 2) return result('x'.repeat(600 * 1024));
        return result('recovered');
    });
    const c = await client(t, b); await initialize(c);
    assert.equal((await c.request(2, 'tools/call', { name: tools[0].name })).error.code, -32603);
    assert.equal((await c.request(3, 'tools/call', { name: tools[0].name })).error.code, -32603);
    assert.deepEqual((await c.request(4, 'tools/call', { name: tools[0].name })).result, result('recovered'));
    assert.doesNotMatch(JSON.stringify(c.messages) + c.stderr(), /synthetic credential/);
});

test('cancelled handlers that ignore AbortSignal still occupy the fixed 32-operation limit until settled', async t => {
    const release = deferred(); const entered = []; let calls = 0;
    const b = await bridge(t, async () => {
        entered[calls]?.resolve(); calls += 1;
        await release.promise; return result('settled');
    });
    t.after(() => release.resolve());
    const cap = JSON.parse(fs.readFileSync(b.capFile));
    for (let index = 0; index < 32; index += 1) {
        const started = deferred(); entered.push(started);
        const socket = net.createConnection(cap.socketPath);
        t.after(() => socket.destroy());
        socket.on('error', () => {});
        socket.once('connect', () => socket.write(`${JSON.stringify({ token: cap.token, method: 'call', name: tools[0].name, args: {} })}\n`));
        await started.promise;
        const closed = new Promise(resolve => socket.once('close', resolve));
        socket.destroy(); await closed;
    }
    assert.equal((await socketRequest(cap, { method: 'call', name: tools[0].name, args: {} })).ok, false);
    assert.equal(calls, 32);
    release.resolve(); await delay(10);
    assert.deepEqual((await socketRequest(cap, { method: 'call', name: tools[0].name, args: {} })).result, result('settled'));
    assert.equal(calls, 33);
});

test('handler deadline propagates AbortSignal and frees the connection using the real socket path', async t => {
    // Only shorten the fixed deadline in this module instance; all socket/stdio behavior stays real.
    const filename = path.join(root, sources[0]); const module = { exports: {} };
    const load = vm.runInThisContext(`(function(require,module,exports,__dirname,setTimeout){${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    load(createRequire(filename), module, module.exports, path.dirname(filename),
        (callback, milliseconds, ...args) => setTimeout(callback, milliseconds === 1800000 ? 30 : milliseconds, ...args));
    const started = deferred(); const aborted = deferred();
    const b = await bridge(t, async (_name, _args, { signal }) => {
        started.resolve(); await new Promise(resolve => signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
        return result('too late');
    }, module.exports.createMainToolBridge);
    const c = await client(t, b); await initialize(c);
    const reply = c.request(2, 'tools/call', { name: tools[0].name });
    await started.promise; await aborted.promise;
    assert.equal((await reply).error.code, -32603);
    assert.deepEqual((await c.request(3, 'ping')).result, {});
});

test('capability path and symlink guards reject before creation or write and preserve outside bytes/mode', async t => {
    const b = await bridge(t, async () => result('legal'));
    const outside = inside(path.join(fixture, 'untouched.json'), fixture);
    fs.writeFileSync(outside, 'outside synthetic evidence', { mode: 0o600 });
    const stat = fs.statSync(outside); const bytes = fs.readFileSync(outside);
    const cap = fs.readFileSync(b.capFile);
    fs.unlinkSync(b.capFile); fs.symlinkSync(outside, b.capFile);
    const c = await client(t, b); assert.equal((await c.exited).code, 1);
    assert.equal(c.messages.length, 0); assert.equal(c.stderr(), 'Evolution tool bridge unavailable\n');
    assert.deepEqual(fs.readFileSync(outside), bytes); assert.equal(fs.statSync(outside).mode, stat.mode);
    fs.unlinkSync(b.capFile); fs.writeFileSync(b.capFile, cap, { mode: 0o600 });
    const legal = await client(t, b); await initialize(legal);
    assert.deepEqual((await legal.request(2, 'tools/call', { name: tools[0].name })).result, result('legal'));

    const filename = path.join(root, sources[0]); const module = { exports: {} };
    const counts = { create: 0, write: 0 };
    const guardedFs = new Proxy(fs, { get(target, key) {
        if (['mkdtempSync', 'mkdirSync', 'openSync', 'writeFileSync', 'chmodSync'].includes(key)) return (...args) => {
            if (['mkdtempSync', 'mkdirSync', 'openSync'].includes(key)) counts.create += 1;
            else counts.write += 1;
            return target[key](...args);
        };
        return target[key];
    } });
    const localRequire = createRequire(filename);
    const load = vm.runInThisContext(`(function(require,module,exports,__dirname){${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    load(name => name === 'node:fs' ? guardedFs : localRequire(name), module, module.exports, path.dirname(filename));
    await assert.rejects(module.exports.runStdioBridge(path.join(fixture, '../outside-capability.json')));
    assert.deepEqual(counts, { create: 0, write: 0 }, 'actual entry rejects the invalid destination before filesystem primitives');
    const counted = await bridge(t, async () => result('counted legal target'), module.exports.createMainToolBridge);
    assert.ok(counts.create >= 2 && counts.write >= 1, 'legal creation and writing use the real guarded primitives');
    const countedClient = await client(t, counted); await initialize(countedClient);
    assert.deepEqual((await countedClient.request(2, 'tools/call', { name: tools[0].name })).result, result('counted legal target'));
    assert.deepEqual(fs.readFileSync(outside), bytes); assert.equal(fs.statSync(outside).mode, stat.mode);
});
