const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'farm-main-progress-'));
process.env.FARM_DATA_DIR = root;
const { evolutionWatchDecision } = require('../src/services/activity-evolver');
const files = [__filename, require.resolve('../src/services/activity-evolver')];
const snapshot = () => files.map(file => ({ file, mode: fs.statSync(file).mode & 0o777,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const before = snapshot();
test.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); }
    finally { assert.deepEqual(snapshot(), before); }
});

test('a Main making progress continues beyond cumulative two-hour boundaries', () => {
    const hour = 60 * 60 * 1000;
    for (const elapsed of [3 * hour, 5 * hour, 9 * hour]) {
        assert.equal(evolutionWatchDecision({ now: 10 * hour, launchedAt: 10 * hour - elapsed,
            logMtimeMs: 10 * hour - 1000, mainOwned: true }), '');
    }
});

test('genuine inactivity and the legacy total deadline still end stalled executors', () => {
    const now = 10 * 60 * 60 * 1000;
    const active = { now, launchedAt: now - 4 * 60 * 60 * 1000, logMtimeMs: now - 1000 };
    assert.equal(evolutionWatchDecision({ ...active, mainOwned: false }), 'hard_timeout');
    assert.equal(evolutionWatchDecision({ ...active, mainOwned: true,
        logMtimeMs: now - 2 * 60 * 60 * 1000 }), 'hard_timeout');
    assert.equal(evolutionWatchDecision({ ...active, mainOwned: true,
        headChanged: true, worktreeDirty: false, logMtimeMs: now - 3 * 60 * 1000 }), 'committed_idle');
});
