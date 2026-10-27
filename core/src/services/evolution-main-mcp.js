const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');

const MAX_CONNECTIONS = 32;
const MAX_REQUEST = 256 * 1024;
const MAX_RESPONSE = 512 * 1024;
const CALL_TIMEOUT_MS = 30 * 60 * 1000;
const AUTH_TIMEOUT_MS = 5000;
const PRIVATE_PREFIX = 'farm-evolution-mcp-';
const CAP_NAME = 'capability.json';
const SOCKET_NAME = 'bridge.sock';
const SCRIPT = path.resolve(__dirname, '../../scripts/run-evolution-main-mcp.js');

function bridgeError() { return new Error('Evolution tool bridge unavailable'); }
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}
function encode(value, limit) {
    let text;
    try { text = JSON.stringify(value); } catch { throw bridgeError(); }
    if (typeof text !== 'string' || Buffer.byteLength(text) > limit) throw bridgeError();
    return `${text}\n`;
}
function inside(value, root) {
    const target = path.resolve(value);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw bridgeError();
    return target;
}
function noSymlinkDirectories(target) {
    const resolved = path.resolve(target);
    let current = path.parse(resolved).root;
    for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw bridgeError();
    }
    return resolved;
}
function tmpRoot() {
    const preferred = noSymlinkDirectories(fs.realpathSync(os.tmpdir()));
    // Unix socket addresses have a small byte limit. Isolated test/runtime
    // TMPDIR paths can exceed it; use a fresh private directory on the canonical
    // short system temp root while keeping the same ownership and token checks.
    const address = path.join(preferred, `${PRIVATE_PREFIX}000000`, SOCKET_NAME);
    if (Buffer.byteLength(address) <= 100) return preferred;
    return noSymlinkDirectories(fs.realpathSync('/tmp'));
}
function directoryIdentity(directory, root, expected = null) {
    inside(directory, root);
    if (path.dirname(directory) !== root || !new RegExp(`^${PRIVATE_PREFIX}[a-zA-Z0-9]{6}$`).test(path.basename(directory))) throw bridgeError();
    noSymlinkDirectories(directory);
    const stat = fs.lstatSync(directory);
    if ((stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) throw bridgeError();
    if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)) throw bridgeError();
    return stat;
}
function absentPrivatePath(file, directory, root, identity) {
    directoryIdentity(directory, root, identity);
    inside(file, directory);
    if (path.dirname(file) !== directory) throw bridgeError();
    try { fs.lstatSync(file); } catch (error) {
        if (error.code === 'ENOENT') return;
        throw bridgeError();
    }
    throw bridgeError();
}
function cleanDirectory(directory, root, identity) {
    try { directoryIdentity(directory, root, identity); } catch { return; }
    for (const name of [CAP_NAME, SOCKET_NAME]) {
        const file = inside(path.join(directory, name), directory);
        try { fs.unlinkSync(file); } catch { /* Already removed, or unsafe to traverse. */ }
    }
    try { fs.rmdirSync(directory); } catch { /* Never recursively remove unknown entries. */ }
}
function normalizeTools(tools) {
    if (!Array.isArray(tools) || !tools.length || tools.length > 32) throw bridgeError();
    const names = new Set();
    const result = tools.map((tool) => {
        if (!object(tool) || typeof tool.name !== 'string' || !/^[\w.-]{1,64}$/.test(tool.name)
            || names.has(tool.name) || !object(tool.inputSchema)) throw bridgeError();
        names.add(tool.name);
        return JSON.parse(encode(tool, 32 * 1024));
    });
    encode(result, 128 * 1024);
    return result;
}
function toolResult(value) {
    if (!object(value) || !Array.isArray(value.content) || value.content.length > 128
        || value.content.some(item => !object(item) || typeof item.type !== 'string')
        || (value.isError !== undefined && typeof value.isError !== 'boolean')) throw bridgeError();
    encode(value, MAX_RESPONSE - 1024);
    return value;
}

// Both the local socket and MCP stdio use newline-delimited JSON. Accumulation is
// bounded before parsing, including unterminated and multi-byte input.
function readLines(stream, limit, onLine, onInvalid) {
    let pending = Buffer.alloc(0);
    let stopped = false;
    const fail = () => { if (!stopped) { stopped = true; onInvalid(); } };
    const onData = (value) => {
        if (stopped) return;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        let offset = 0;
        while (offset < chunk.length) {
            if (stopped) return;
            const newline = chunk.indexOf(10, offset);
            const end = newline < 0 ? chunk.length : newline;
            const part = chunk.subarray(offset, end);
            if (pending.length + part.length > limit) { fail(); return; }
            const line = pending.length ? Buffer.concat([pending, part]) : part;
            if (newline < 0) { pending = Buffer.from(line); return; }
            pending = Buffer.alloc(0);
            if (line.length) onLine(line.toString('utf8'));
            offset = end + 1;
        }
    };
    const onEnd = () => { if (pending.length) fail(); };
    stream.on('data', onData);
    stream.on('end', onEnd);
    return () => {
        stopped = true;
        pending = Buffer.alloc(0);
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
    };
}

async function createMainToolBridge({ tools, instructions = '', handler } = {}) {
    const publicTools = normalizeTools(tools);
    if (typeof handler !== 'function' || typeof instructions !== 'string' || Buffer.byteLength(instructions) > 32 * 1024) throw bridgeError();
    const metadata = { tools: publicTools, instructions };
    encode(metadata, 160 * 1024);
    const whitelist = new Set(publicTools.map(tool => tool.name));
    const root = tmpRoot();
    // No caller-supplied destination: every creation stays below this fresh 0700 directory.
    noSymlinkDirectories(root);
    const directory = fs.mkdtempSync(inside(path.join(root, PRIVATE_PREFIX), root));
    const identity = directoryIdentity(directory, root);
    const socketPath = inside(path.join(directory, SOCKET_NAME), directory);
    const capFile = inside(path.join(directory, CAP_NAME), directory);
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest();
    const sockets = new Set();
    const controllers = new Set();
    let closed = false;
    let closing;
    const server = net.createServer((socket) => {
        if (closed || sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
        sockets.add(socket);
        let controller;
        let received = false;
        let finished = false;
        let timer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
        const finish = (value) => {
            if (finished || socket.destroyed) return;
            finished = true;
            clearTimeout(timer);
            try { socket.end(encode(value, MAX_RESPONSE)); } catch { socket.destroy(); }
        };
        const rejected = () => finish({ ok: false, error: 'Bridge request rejected' });
        const stopReading = readLines(socket, MAX_REQUEST, async (line) => {
            if (received || closed) { rejected(); socket.destroy(); return; }
            received = true;
            let request;
            try { request = JSON.parse(line); } catch { rejected(); return; }
            const incoming = crypto.createHash('sha256').update(typeof request?.token === 'string' ? request.token : '').digest();
            if (!object(request) || !crypto.timingSafeEqual(incoming, tokenHash)) { rejected(); return; }
            clearTimeout(timer);
            if (request.method === 'metadata') { finish({ ok: true, result: metadata }); return; }
            if (request.method !== 'call' || !whitelist.has(request.name) || !object(request.args)
                || controllers.size >= MAX_CONNECTIONS) { rejected(); return; }
            controller = new AbortController();
            controllers.add(controller);
            timer = setTimeout(() => { controller.abort(); finish({ ok: false, error: 'Tool call timed out' }); }, CALL_TIMEOUT_MS);
            try {
                const result = toolResult(await handler(request.name, request.args, { signal: controller.signal }));
                if (!controller.signal.aborted && !closed) finish({ ok: true, result });
            } catch { finish({ ok: false, error: 'Tool call failed' }); }
            finally { controllers.delete(controller); }
        }, () => { rejected(); socket.destroy(); });
        socket.on('error', () => {});
        socket.on('close', () => {
            stopReading();
            clearTimeout(timer);
            if (!finished) controller?.abort();
            sockets.delete(socket);
        });
    });
    // Listening errors after startup are handled without printing socket paths or tokens.
    server.on('error', () => {});
    const close = () => {
        if (closing) return closing;
        closed = true;
        for (const controller of controllers) controller.abort();
        for (const socket of sockets) socket.destroy();
        closing = new Promise((resolve) => {
            const done = () => { cleanDirectory(directory, root, identity); resolve(); };
            if (server.listening) server.close(done);
            else done();
        });
        return closing;
    };
    try {
        absentPrivatePath(socketPath, directory, root, identity);
        await new Promise((resolve, reject) => {
            const fail = () => { server.removeListener('listening', ready); reject(bridgeError()); };
            const ready = () => { server.removeListener('error', fail); resolve(); };
            server.once('error', fail);
            server.once('listening', ready);
            server.listen(socketPath);
        });
        directoryIdentity(directory, root, identity);
        const socketStat = fs.lstatSync(socketPath);
        if (!socketStat.isSocket() || socketStat.isSymbolicLink()) throw bridgeError();
        fs.chmodSync(socketPath, 0o600);
        absentPrivatePath(capFile, directory, root, identity);
        const fd = fs.openSync(capFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw bridgeError();
            fs.writeFileSync(fd, encode({ socketPath, token }, 4096));
        } finally { fs.closeSync(fd); }
        return { mcp: { command: process.execPath, args: [SCRIPT, '--cap-file', capFile] }, close };
    } catch {
        await close();
        throw bridgeError();
    }
}

function readCapability(capFile) {
    if (typeof capFile !== 'string' || !path.isAbsolute(capFile) || path.normalize(capFile) !== capFile) throw bridgeError();
    const root = tmpRoot();
    const directory = path.dirname(capFile);
    directoryIdentity(directory, root);
    if (path.basename(capFile) !== CAP_NAME) throw bridgeError();
    const stat = fs.lstatSync(inside(capFile, directory));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw bridgeError();
    const fd = fs.openSync(capFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let cap;
    try {
        const actual = fs.fstatSync(fd);
        if (actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size > 4096) throw bridgeError();
        cap = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
    if (!object(cap) || typeof cap.token !== 'string' || !/^[a-f0-9]{64}$/.test(cap.token)
        || cap.socketPath !== path.join(directory, SOCKET_NAME)) throw bridgeError();
    const socketStat = fs.lstatSync(cap.socketPath);
    if (!socketStat.isSocket() || socketStat.isSymbolicLink() || (socketStat.mode & 0o777) !== 0o600) throw bridgeError();
    return cap;
}

function remoteRequest(cap, payload, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(bridgeError()); return; }
        let wire;
        try { wire = encode({ ...payload, token: cap.token }, MAX_REQUEST); } catch { reject(bridgeError()); return; }
        const socket = net.createConnection(cap.socketPath);
        let settled = false;
        const timer = setTimeout(() => done(bridgeError()), CALL_TIMEOUT_MS + AUTH_TIMEOUT_MS);
        const abort = () => done(bridgeError());
        const done = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            stopReading();
            socket.destroy();
            if (error) reject(bridgeError());
            else resolve(value);
        };
        const stopReading = readLines(socket, MAX_RESPONSE, (line) => {
            let value;
            try { value = JSON.parse(line); } catch { done(bridgeError()); return; }
            if (!object(value) || value.ok !== true) done(bridgeError());
            else done(null, value.result);
        }, () => done(bridgeError()));
        socket.once('connect', () => socket.write(wire));
        socket.on('error', () => done(bridgeError()));
        socket.once('close', () => done(bridgeError()));
        signal?.addEventListener('abort', abort, { once: true });
    });
}

async function runStdioBridge(capFile) {
    let cap;
    try { cap = readCapability(capFile); } catch { throw bridgeError(); }
    const lifecycle = new AbortController();
    const metadata = await remoteRequest(cap, { method: 'metadata' }, lifecycle.signal);
    const tools = normalizeTools(metadata?.tools);
    const whitelist = new Set(tools.map(tool => tool.name));
    if (typeof metadata.instructions !== 'string') throw bridgeError();
    const pending = new Map();
    let initialized = false;
    let closed = false;
    let stopReading = () => {};
    let resolveClosed;
    const completion = new Promise(resolve => { resolveClosed = resolve; });
    const cleanup = () => {
        if (closed) return;
        closed = true;
        lifecycle.abort();
        for (const controller of pending.values()) controller.abort();
        pending.clear();
        stopReading();
        process.stdin.removeListener('end', cleanup);
        process.stdin.removeListener('close', cleanup);
        process.stdin.removeListener('error', cleanup);
        process.stdout.removeListener('error', cleanup);
        process.removeListener('SIGTERM', cleanup);
        process.removeListener('SIGINT', cleanup);
        process.stdin.destroy();
        resolveClosed();
    };
    const send = (value) => {
        if (closed) return;
        if (process.stdout.writableLength > MAX_RESPONSE * 2) { cleanup(); return; }
        try { process.stdout.write(encode(value, MAX_RESPONSE)); } catch { cleanup(); }
    };
    const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
    const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
    const validId = id => typeof id === 'string' && id.length <= 128 || Number.isSafeInteger(id);
    const handle = async (line) => {
        let message;
        try { message = JSON.parse(line); } catch { error(null, -32700, 'Parse error'); return; }
        if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { error(null, -32600, 'Invalid request'); return; }
        const notification = !Object.hasOwn(message, 'id');
        if (notification) {
            if (message.method === 'notifications/cancelled') pending.get(message.params?.requestId)?.abort();
            return;
        }
        const id = message.id;
        if (!validId(id)) { error(null, -32600, 'Invalid request'); return; }
        if (pending.has(id)) { error(id, -32600, 'Duplicate request'); return; }
        if (message.method === 'initialize') {
            const version = message.params?.protocolVersion;
            if (typeof version !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(version)) { error(id, -32602, 'Invalid initialize parameters'); return; }
            initialized = true;
            reply(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'farm-evolution-main', version: '1.0.0' }, instructions: metadata.instructions });
        } else if (message.method === 'ping') reply(id, {});
        else if (!initialized) error(id, -32000, 'Initialize first');
        else if (message.method === 'tools/list') reply(id, { tools });
        else if (message.method !== 'tools/call') error(id, -32601, 'Method not found');
        else if (!whitelist.has(message.params?.name) || (message.params.arguments !== undefined && !object(message.params.arguments))) error(id, -32602, 'Unknown tool or invalid arguments');
        else if (pending.size >= MAX_CONNECTIONS) error(id, -32000, 'Too many active requests');
        else {
            const controller = new AbortController();
            pending.set(id, controller);
            try {
                const result = toolResult(await remoteRequest(cap, { method: 'call', name: message.params.name,
                    args: message.params.arguments || {} }, controller.signal));
                if (!controller.signal.aborted) reply(id, result);
                else error(id, -32800, 'Request cancelled');
            } catch { error(id, controller.signal.aborted ? -32800 : -32603,
                controller.signal.aborted ? 'Request cancelled' : 'Tool call failed'); }
            finally { pending.delete(id); }
        }
    };
    stopReading = readLines(process.stdin, MAX_REQUEST, line => { void handle(line).catch(() => error(null, -32603, 'Request failed')); }, () => {
        error(null, -32600, 'Message exceeds limit');
        cleanup();
    });
    process.stdin.on('end', cleanup);
    process.stdin.on('close', cleanup);
    process.stdin.on('error', cleanup);
    process.stdout.on('error', cleanup);
    process.once('SIGTERM', cleanup);
    process.once('SIGINT', cleanup);
    if (process.stdin.readableEnded || process.stdin.destroyed) cleanup();
    await completion;
}

module.exports = { createMainToolBridge, runStdioBridge };
