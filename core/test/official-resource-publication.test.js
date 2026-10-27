const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto'), zlib = require('node:zlib'), vm = require('node:vm');
const temp = fs.realpathSync(os.tmpdir()), prefix = path.resolve(temp, 'farm-official-resources-'); assert.equal(path.dirname(prefix), temp);
const data = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = data;
const guard = require('../src/services/privacy-guard');
const sources = [__filename, '../src/services/privacy-guard.js', '../src/services/activity-evolver.js'].map(f => path.resolve(__dirname, f));
const fingerprint = () => sources.map(file => ({ mode: fs.statSync(file).mode & 0o777, hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const before = fingerprint();
test.after(() => { try { assert.deepEqual(fingerprint(), before); } finally { assert.equal(path.dirname(data), temp); fs.rmSync(data, { recursive: true, force: true }); } });
function inside(base, relative) { const file = path.resolve(base, relative); if (file !== base && !file.startsWith(base + path.sep)) throw new Error('fixture_escape'); return file; }
function write(base, relative, bytes) { const file = inside(base, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function crc32(bytes) { let crc = 0xFFFFFFFF; for (const value of bytes) { crc ^= value; for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0); } return (crc ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, bytes) { const b = Buffer.alloc(12 + bytes.length); b.writeUInt32BE(bytes.length); b.write(type, 4); bytes.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + bytes.length)), 8 + bytes.length); return b; }
function png(metadata) { const h = Buffer.alloc(13); h.writeUInt32BE(1); h.writeUInt32BE(1, 4); h[8] = 8; h[9] = 6; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', h), ...(metadata ? [chunk('tEXt', Buffer.from(metadata))] : []), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]))), chunk('IEND', Buffer.alloc(0))]); }
const resource = 'core/src/gameConfig/seed_images_named/990001_Crop_1_Seed.png';
function fixture(t, bytes = png()) {
  const repo = inside(data, `repo-${crypto.randomUUID()}`); fs.mkdirSync(repo); t.after(() => fs.rmSync(inside(data, path.basename(repo)), { recursive: true, force: true }));
  const git = args => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@users.noreply.github.com']);
  write(repo, 'README.md', 'fixture\n'); git(['add', '.']); git(['commit', '-qm', 'fixture baseline']); const base = git(['rev-parse', 'HEAD']).trim();
  const row = { itemId: 990001, file: path.basename(resource), sourceGrade: 'reviewed_public_client_snapshot', repositoryAlias: 'public-reference-fixture', sourceCommit: 'a'.repeat(40), sourcePath: 'public/seed_images_named/990001_Crop_1_Seed.png', gitBlob: crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), width: 1, height: 1 };
  const registry = { references: [{ repositoryAlias: row.repositoryAlias, commit: row.sourceCommit }], reviewedResources: [row] };
  const save = () => write(repo, 'core/src/gameConfig/seed_images_named/event-seed-sources.json', JSON.stringify(registry));
  write(repo, resource, bytes); save(); git(['add', '.']); git(['commit', '-qm', 'fixture resource']);
  return { repo, git, base, row, registry, save, head: () => git(['rev-parse', 'HEAD']).trim() };
}
function audit(f, proofs) { return guard.auditGitRange(f.repo, f.base, f.head(), { runtimeTerms: [], reviewedOfficialResources: proofs }); }
test('ordinary binary changes remain blocked; only the exact registered PNG proof passes', t => {
  const f = fixture(t); assert.equal(audit(f).ok, false);
  const proofs = guard.getReviewedOfficialResources(f.repo, f.head(), { runtimeTerms: [] }); assert.equal(proofs.length, 1);
  assert.equal(audit(f, proofs).ok, true);
  assert.equal(audit(f, [{ ...proofs[0], sha256: '0'.repeat(64) }]).ok, false);
  assert.equal(audit(f, [{ ...proofs[0], commit: f.base }]).ok, false);
});
test('a registered PNG cannot waive an unrelated binary, an earlier unregistered commit, or metadata secrets', t => {
  const f = fixture(t); write(f.repo, 'other.bin', Buffer.from([0, 1, 2, 3])); f.git(['add', '.']); f.git(['commit', '-qm', 'fixture unrelated binary']);
  const proofs = guard.getReviewedOfficialResources(f.repo, f.head(), { runtimeTerms: [] }); const result = audit(f, proofs);
  assert.equal(result.ok, false); assert.ok(result.findings.some(x => x.rule === 'binary-change' && x.file === 'other.bin'));
  const hidden = ['Bearer', 'synthetic-value-1234567890'].join(' ');
  assert.equal(guard.pngResourceInfo(png('Comment\0' + hidden), { runtimeTerms: [] }), null);
});
for (const mode of ['hash', 'source', 'dimensions', 'reference', 'path']) {
  test(`resource proof rejects changed ${mode} evidence`, t => {
    const f = fixture(t);
    if (mode === 'hash') f.row.sha256 = '0'.repeat(64);
    if (mode === 'source') f.row.sourceGrade = 'worker_claim';
    if (mode === 'dimensions') f.row.width = 2;
    if (mode === 'reference') f.registry.references = [];
    if (mode === 'path') f.row.file = '../escape.png';
    f.save(); f.git(['add', '.']); f.git(['commit', '-qm', 'fixture invalid evidence']);
    assert.deepEqual(guard.getReviewedOfficialResources(f.repo, f.head(), { runtimeTerms: [] }), []);
    assert.equal(audit(f, [{ file: resource, commit: f.head(), sha256: f.row.sha256 }]).ok, false);
  });
}
test('PNG structural verification rejects bad CRC, trailing bytes and malformed image data', () => {
  const bytes = png(); assert.deepEqual(guard.pngResourceInfo(bytes, { runtimeTerms: [] }), { width: 1, height: 1 });
  const corrupt = Buffer.from(bytes); corrupt[20] ^= 1; assert.equal(guard.pngResourceInfo(corrupt), null);
  assert.equal(guard.pngResourceInfo(Buffer.concat([bytes, Buffer.from('extra')])), null);
  assert.equal(guard.pngResourceInfo(Buffer.from('<svg/>')), null);
});
test('the actual parent publication entry uses resource proofs only after Main completion approval', async t => {
  const f = fixture(t), ts = require(path.resolve(__dirname, '../../web/node_modules/typescript'));
  const source = fs.readFileSync(sources[2], 'utf8'); const ast = ts.createSourceFile('activity-evolver.js', source, ts.ScriptTarget.Latest);
  const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'ensureHeadPushed'); assert.ok(declaration);
  let remote = f.base, pushes = 0, approvals = 0;
  const context = { REPO_ROOT: f.repo, process: { env: {} }, remoteMainHead: async () => remote,
    isTeamResultApproved: (j, head) => !!j && j.status === 'completed' && j.phase === 'complete' && j.head === head && ['approve', 'no_change'].includes(j.decision),
    normalizeOrchestrationFiles: () => [], getReviewedOfficialResources: (...args) => { approvals++; return guard.getReviewedOfficialResources(...args, { runtimeTerms: [] }); },
    auditGitRange: (repo, base, head, options) => guard.auditGitRange(repo, base, head, { ...options, runtimeTerms: [] }), formatPrivacyFindings: guard.formatPrivacyFindings,
    execFileAsync: async (bin, args) => { assert.equal(bin, 'git'); assert.deepEqual(Array.from(args), ['push', 'origin', 'HEAD:main']); pushes++; remote = f.head(); }, redactExternalText: x => x };
  const publish = vm.runInNewContext('(' + declaration.getText(ast) + ')', context);
  const blocked = await publish(f.head(), f.base, null, f.repo, f.base); assert.equal(blocked.privacyBlocked, true); assert.equal(approvals, 0); assert.equal(pushes, 0);
  for (const extra of [{ decision: 'no_change' }, { repairOnly: true }]) {
    const partial = await publish(f.head(), f.base, { status: 'completed', phase: 'complete', head: f.head(), decision: 'approve', ...extra }, f.repo, f.base);
    assert.equal(partial.privacyBlocked, true); assert.equal(approvals, 0); assert.equal(pushes, 0);
  }
  const approved = await publish(f.head(), f.base, { status: 'completed', phase: 'complete', head: f.head(), decision: 'approve' }, f.repo, f.base);
  assert.equal(approved.ok, true); assert.equal(approvals, 1); assert.equal(pushes, 1);
});
test('compressed PNG text is inspected and standard public metadata remains usable', () => {
  const bytes = png(), withText = (type, content) => Buffer.concat([bytes.subarray(0, 33), chunk(type, content), bytes.subarray(33)]);
  const hidden = Buffer.from(['Bearer', 'synthetic-value-1234567890'].join(' '));
  const ztxt = Buffer.concat([Buffer.from('Comment\0\0'), zlib.deflateSync(hidden)]);
  const itxt = Buffer.concat([Buffer.from('Comment\0\x01\0\0\0'), zlib.deflateSync(hidden)]);
  assert.equal(guard.pngResourceInfo(withText('zTXt', ztxt), { runtimeTerms: [] }), null);
  assert.equal(guard.pngResourceInfo(withText('iCCP', ztxt), { runtimeTerms: [] }), null);
  assert.equal(guard.pngResourceInfo(withText('iTXt', itxt), { runtimeTerms: [] }), null);
  assert.deepEqual(guard.pngResourceInfo(withText('tEXt', Buffer.from('Software\0Image exporter')), { runtimeTerms: [] }), { width: 1, height: 1 });
});
test('registered symlink targets and duplicate resource records are never publication proofs', t => {
  const f = fixture(t); f.registry.reviewedResources.push({ ...f.row }); f.save(); f.git(['add', '.']); f.git(['commit', '-qm', 'fixture duplicate']);
  assert.deepEqual(guard.getReviewedOfficialResources(f.repo, f.head(), { runtimeTerms: [] }), []);
  f.registry.reviewedResources.pop(); f.save(); fs.unlinkSync(inside(f.repo, resource)); fs.symlinkSync('other.png', inside(f.repo, resource)); f.git(['add', '.']); f.git(['commit', '-qm', 'fixture link']);
  assert.deepEqual(guard.getReviewedOfficialResources(f.repo, f.head(), { runtimeTerms: [] }), []);
  assert.equal(audit(f).ok, false);
});
