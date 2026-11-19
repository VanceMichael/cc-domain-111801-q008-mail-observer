import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export class Archive {
  constructor(directory) { this.directory = directory; }
  async start() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    this.database = new DatabaseSync(join(this.directory, 'receipts.sqlite'));
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
    this.database.exec(`CREATE TABLE IF NOT EXISTS evidence (
      digest TEXT PRIMARY KEY, location TEXT NOT NULL, observed_at TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (
      scope TEXT NOT NULL, business_key TEXT NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL,
      decision TEXT NOT NULL, PRIMARY KEY(scope,business_key,digest));
      CREATE TABLE IF NOT EXISTS sessions (
      folder TEXT PRIMARY KEY, epoch TEXT NOT NULL, observed_sequence INTEGER NOT NULL,
      window TEXT NOT NULL, basis TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (
      folder TEXT NOT NULL, epoch TEXT NOT NULL, id TEXT NOT NULL, uid TEXT,
      record TEXT, state TEXT NOT NULL, work_state TEXT NOT NULL, basis TEXT,
      first_seen TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(folder, epoch, id));
      CREATE TABLE IF NOT EXISTS gaps (
      gap_id INTEGER PRIMARY KEY AUTOINCREMENT, folder TEXT NOT NULL, epoch TEXT NOT NULL,
      kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);`);
    return this;
  }
  async preserve(document) {
    const digest = createHash('sha256').update(document.bytes).digest('hex');
    const destination = join(this.directory, 'objects', digest);
    const temporary = destination + '.' + process.pid + '.' + randomUUID();
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(document.bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, destination);
    this.database.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?,?)').run(digest, document.location, document.observedAt, document.bytes.length);
    return digest;
  }
  put(scope, key, digest, record, decision) {
    if (!this.database.prepare('SELECT digest FROM evidence WHERE digest=?').get(digest)) throw new Error('原文尚未保存');
    this.database.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,?)').run(scope, key, digest, JSON.stringify(record), JSON.stringify(decision));
  }
  records(scope) {
    return this.database.prepare('SELECT * FROM receipts WHERE scope=? ORDER BY business_key,digest').all(scope).map(row => ({ ...row, record: JSON.parse(row.record), decision: JSON.parse(row.decision) }));
  }
  async original(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('原文摘要无效');
    const content = await readFile(join(this.directory, 'objects', digest));
    if (createHash('sha256').update(content).digest('hex') !== digest) throw new Error('原文完整性校验失败');
    return content;
  }
  getSession(folder) {
    const row = this.database.prepare('SELECT * FROM sessions WHERE folder=?').get(folder);
    if (!row) return null;
    return { folder: row.folder, epoch: row.epoch, observedSequence: row.observed_sequence, window: JSON.parse(row.window), ...JSON.parse(row.basis) };
  }
  putSession(folder, session) {
    this.database.prepare('INSERT INTO sessions VALUES(?,?,?,?,?) ON CONFLICT(folder) DO UPDATE SET epoch=excluded.epoch, observed_sequence=excluded.observed_sequence, window=excluded.window, basis=excluded.basis')
      .run(folder, session.epoch, session.observedSequence, JSON.stringify(session.window), JSON.stringify({ location: session.location, observedAt: session.observedAt }));
  }
  getMembers(folder, epoch) {
    return this.database.prepare('SELECT * FROM members WHERE folder=? AND epoch=? ORDER BY id').all(folder, epoch).map(row => ({
      folder: row.folder, epoch: row.epoch, id: row.id, uid: row.uid,
      record: row.record ? JSON.parse(row.record) : null, state: row.state, workState: row.work_state,
      basis: row.basis ? JSON.parse(row.basis) : null, firstSeen: row.first_seen, updatedAt: row.updated_at,
    }));
  }
  upsertMember(folder, epoch, member) {
    const now = new Date().toISOString();
    const existing = this.database.prepare('SELECT first_seen FROM members WHERE folder=? AND epoch=? AND id=?').get(folder, epoch, member.id);
    this.database.prepare(`INSERT INTO members(folder,epoch,id,uid,record,state,work_state,basis,first_seen,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(folder,epoch,id) DO UPDATE SET uid=excluded.uid, record=excluded.record, state=excluded.state,
      work_state=excluded.work_state, basis=excluded.basis, updated_at=excluded.updated_at`)
      .run(folder, epoch, member.id, member.uid ?? null, member.record ? JSON.stringify(member.record) : null,
        member.state, member.workState, member.basis ? JSON.stringify(member.basis) : null, existing?.first_seen ?? now, now);
  }
  addGap(folder, epoch, gap) {
    const detail = JSON.stringify(gap);
    const duplicate = this.database.prepare('SELECT 1 FROM gaps WHERE folder=? AND epoch=? AND kind=? AND detail=?').get(folder, epoch, gap.kind, detail);
    if (duplicate) return;
    this.database.prepare('INSERT INTO gaps(folder,epoch,kind,detail,created_at) VALUES(?,?,?,?,?)')
      .run(folder, epoch, gap.kind, detail, new Date().toISOString());
  }
  clearGaps(folder, epoch) {
    this.database.prepare('DELETE FROM gaps WHERE folder=? AND epoch=?').run(folder, epoch);
  }
  listGaps() {
    return this.database.prepare('SELECT * FROM gaps ORDER BY gap_id').all().map(row => ({ gapId: row.gap_id, folder: row.folder, epoch: row.epoch, kind: row.kind, ...JSON.parse(row.detail), createdAt: row.created_at }));
  }
  close() { this.database?.close(); }
}
