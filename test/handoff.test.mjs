import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretRelation, interpretChange } from '../src/interpret.mjs';
import { planSession } from '../src/session.mjs';
import { reconcileFolder, inferMoves, buildHandoff, workState } from '../src/handoff.mjs';

const relation = {
  mailbox: 'INBOX', epoch: 'E1', sequence: 3, window: [1, 3],
  changes: [
    { kind: 'arrive', sequence: 1, id: 'M100', uid: '100' },
    { kind: 'expunge', sequence: 2, id: 'M101', uid: '101' },
    { kind: 'flags', sequence: 3, id: 'M100', flags: ['pending'] },
  ],
};

test('解释会话资料并拒绝不连续或重复的变更顺序号', () => {
  const parsed = interpretRelation(relation);
  assert.equal(parsed.epoch, 'E1');
  assert.deepEqual(parsed.changes.map(change => change.kind), ['arrive', 'expunge', 'flags']);
  assert.throws(() => interpretRelation({ ...relation, changes: [relation.changes[0], relation.changes[0]] }), /重复/);
  assert.throws(() => interpretRelation({ ...relation, changes: [relation.changes[0], { ...relation.changes[2], sequence: 9 }] }), /不连续/);
  assert.throws(() => interpretRelation({ ...relation, window: [9, 1] }), /区间/);
  assert.throws(() => interpretChange({ kind: 'rename', sequence: 1 }), /变更类型/);
});

test('代际变化与无法补发都触发重新确认，并保留先前观察依据', () => {
  const parsed = interpretRelation(relation);
  assert.equal(planSession(parsed, null).mode, 'reset');
  assert.equal(planSession(parsed, { epoch: 'E0', observedSequence: 5 }).mode, 'reset');
  // 顺序号已经越过来源可补发窗口的下界，中间变更无法再补发。
  const beyondWindow = planSession({ ...parsed, window: [5, 6], sequence: 6 }, { epoch: 'E1', observedSequence: 3 });
  assert.equal(beyondWindow.mode, 'reset');
  assert.equal(beyondWindow.observedSequence, 3);
  // 游标仍落在可补发窗口内时按增量应用。
  assert.equal(planSession(parsed, { epoch: 'E1', observedSequence: 0 }).mode, 'apply');
  const apply = planSession(parsed, { epoch: 'E1', observedSequence: 2 });
  assert.equal(apply.mode, 'apply');
  assert.deepEqual(apply.changes.map(change => change.sequence), [3]);
  assert.equal(planSession({ ...parsed, sequence: 3 }, { epoch: 'E1', observedSequence: 3 }).mode, 'idle');
});

test('工作标记区分待补资料、已移交和未标记', () => {
  assert.equal(workState(['pending']), 'pending');
  assert.equal(workState(['handed']), 'handed');
  assert.equal(workState(['seen']), 'unmarked');
});

test('消失成员有会话依据，旧会话回复不能复活', () => {
  const stored = [
    { id: 'M100', uid: '100', record: { uid: '100', subject: '货票资料', sender: 'a@x', flags: ['pending'] }, state: 'current', workState: 'pending', basis: { digest: 'd1' } },
    { id: 'M101', uid: '101', record: { uid: '101', subject: '补充说明', sender: 'b@x', flags: ['pending'] }, state: 'current', workState: 'pending', basis: { digest: 'd2' } },
  ];
  const result = reconcileFolder({
    folder: 'INBOX', epoch: 'E1', storedMembers: stored,
    references: [{ identity: 'M100' }],
    records: new Map([['M100', { uid: '100', subject: '货票资料', sender: 'a@x', flags: ['pending'], basis: { digest: 'd3' } }]]),
    lateIds: [],
    evidence: [{ kind: 'expunge', sequence: 2, id: 'M101' }],
  });
  assert.equal(result.confirmed.length, 1);
  assert.equal(result.vanished.length, 1);
  assert.equal(result.vanished[0].id, 'M101');
  assert.equal(result.vanished[0].incomplete, true);
  assert.equal(result.gaps.length, 0);

  // 旧会话回复让 M101 重新出现在目录，也不能复活已证实消失的成员，只能记为迟到。
  const reply = reconcileFolder({
    folder: 'INBOX', epoch: 'E1', storedMembers: [
      { id: 'M101', uid: '101', record: { uid: '101', subject: '补充说明', sender: 'b@x', flags: ['pending'] }, state: 'vanished', workState: 'pending', basis: { kind: 'expunge', sequence: 2 } },
    ],
    references: [{ identity: 'M101' }],
    records: new Map([['M101', { uid: '101', subject: '补充说明', sender: 'b@x', flags: ['pending'], basis: { digest: 'd4' } }]]),
    lateIds: ['M101'],
    evidence: [],
  });
  assert.equal(reply.confirmed.length, 0);
  assert.equal(reply.vanished.length, 1);
  assert.equal(reply.lateDocuments.length, 1);
});

test('没读到的邮件不能为了对齐数量记成已移交', () => {
  const result = reconcileFolder({
    folder: 'INBOX', epoch: 'E1', storedMembers: [],
    references: [{ identity: 'M100' }, { identity: 'M102' }],
    records: new Map([['M100', { uid: '100', subject: '资料', sender: 'a@x', flags: ['handed'], basis: { digest: 'd1' } }]]),
    lateIds: [], evidence: [],
  });
  assert.equal(result.confirmed.length, 1);
  assert.equal(result.unread.length, 1);
  assert.equal(result.unread[0].id, 'M102');
});

test('移动认定需要两端依据，主题相同不足，跨代际只能存疑', () => {
  const source = {
    folder: 'INBOX', epoch: 'E1',
    confirmed: [],
    unread: [],
    lateDocuments: [],
    vanished: [
      { id: 'M101', uid: '101', subject: '报关单', sender: 'b@x', basis: { kind: 'move', sequence: 2, id: 'M101', destination: 'HANDOVER' } },
      { id: 'M102', uid: '102', subject: '合同附件', sender: 'c@x', basis: { kind: 'expunge', sequence: 3, id: 'M102' } },
    ],
    gaps: [],
  };
  const destination = {
    folder: 'HANDOVER', epoch: 'E1',
    confirmed: [
      { id: 'M101', uid: '101', subject: '报关单', sender: 'b@x', basis: { digest: 'd9' } },
      { id: 'M300', uid: '300', subject: '合同附件', sender: 'c@x', basis: { digest: 'd10' } },
    ],
    unread: [], lateDocuments: [], vanished: [], gaps: [],
  };
  const moves = inferMoves([source, destination]);
  assert.equal(moves.confirmed.length, 1);
  assert.equal(moves.confirmed[0].id, 'M101');
  assert.equal(moves.possible.length, 1);
  assert.equal(moves.possible[0].id, 'M102');

  const otherGeneration = { ...destination, epoch: 'E2', confirmed: [{ id: 'M101', uid: '101', subject: '报关单', sender: 'b@x', basis: { digest: 'd11' } }] };
  const acrossGenerations = inferMoves([source, otherGeneration]);
  assert.equal(acrossGenerations.confirmed.length, 0);
  assert.equal(acrossGenerations.possible.length, 1);
  assert.match(acrossGenerations.possible[0].reason, /代际/);
});

test('交接报告只在所有依据齐备时声明完成', () => {
  const clean = buildHandoff([{
    folder: 'INBOX', epoch: 'E1',
    confirmed: [{ id: 'M100', workState: 'handed', flags: ['handed'] }],
    unread: [], lateDocuments: [], vanished: [], gaps: [],
  }]);
  assert.equal(clean.complete, true);
  assert.equal(clean.counts.handed, 1);

  const blocked = buildHandoff([{
    folder: 'INBOX', epoch: 'E1',
    confirmed: [{ id: 'M100', workState: 'pending', flags: ['pending'] }],
    unread: [], lateDocuments: [],
    vanished: [{ id: 'M101', incomplete: true, subject: 'x' }], gaps: [],
  }]);
  assert.equal(blocked.complete, false);
  assert.equal(blocked.counts.vanished, 1);
});
