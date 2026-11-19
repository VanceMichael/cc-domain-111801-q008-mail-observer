import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { Archive } from '../src/archive.mjs';
import { observe, observeRound } from '../src/app.mjs';

const baseFixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));

function inbox(records, relation) {
  return {
    '/mail/INBOX': { body: { mailbox: 'INBOX', relation: '/mail/INBOX/relations', messages: records.map(([id]) => ({ id, href: '/mail/INBOX/records/' + id })) } },
    ...Object.fromEntries(records.map(([id, body]) => ['/mail/INBOX/records/' + id, { body }])),
    '/mail/INBOX/relations': { supportsSince: true, body: relation },
  };
}

function handover(records, relation) {
  return {
    '/mail/HANDOVER': { body: { mailbox: 'HANDOVER', relation: '/mail/HANDOVER/relations', messages: records.map(([id]) => ({ id, href: '/mail/HANDOVER/records/' + id })) } },
    ...Object.fromEntries(records.map(([id, body]) => ['/mail/HANDOVER/records/' + id, { body }])),
    '/mail/HANDOVER/relations': { supportsSince: true, body: relation },
  };
}

const message = (id, uid, subject, flags, sender = 'partner@local.invalid', mailbox = 'INBOX') =>
  ({ message: id, mailbox, uid, subject, flags, sender });

async function harness(resources) {
  const source = await fixtureSource({ resources });
  const directory = await mkdtemp(join(tmpdir(), 'observe-'));
  const archive = await new Archive(directory).start();
  const client = new SourceClient(source.url);
  return {
    source, archive, client,
    async close() { archive.close(); await source.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('持续观察依据会话补查推进，并在目录中反映待补资料与已移交标记', async () => {
  const resources = {
    ...inbox(
      [['M100', message('M100', '100', '货票资料', ['pending'])]],
      { mailbox: 'INBOX', epoch: 'E1', sequence: 1, window: [1, 1], changes: [{ kind: 'arrive', sequence: 1, id: 'M100', uid: '100' }] },
    ),
    ...handover(
      [['M200', message('M200', '200', '交接单', ['handed'], 'colleague@local.invalid', 'HANDOVER')]],
      { mailbox: 'HANDOVER', epoch: 'E1', sequence: 1, window: [1, 1], changes: [{ kind: 'arrive', sequence: 1, id: 'M200', uid: '200' }] },
    ),
  };
  const env = await harness(resources);
  try {
    const round = await observeRound(env.client, env.archive, ['INBOX', 'HANDOVER']);
    assert.equal(round.handoff.complete, true);
    assert.equal(round.handoff.counts.confirmed, 2);
    assert.equal(round.handoff.confirmed.pendingMaterials[0].id, 'M100');
    assert.equal(round.handoff.confirmed.handedOver[0].id, 'M200');
    const session = env.archive.getSession('INBOX');
    assert.deepEqual(session, { folder: 'INBOX', epoch: 'E1', observedSequence: 1, window: [1, 1], location: env.source.url + '/mail/INBOX/relations', observedAt: session.observedAt });

    // 第二轮以 since 补查，来源只返回新增变更。
    const before = env.source.accesses.length;
    const second = await observeRound(env.client, env.archive, ['INBOX', 'HANDOVER']);
    const relationCall = env.source.accesses.slice(before).find(item => item.path === '/mail/INBOX/relations');
    assert.equal(relationCall.query.since, '1');
    assert.equal(second.folders[0].session.mode, 'idle');
    assert.equal(env.archive.records('INBOX').length, 1);
  } finally { await env.close(); }
});

test('删除后顺序号重排，稳定身份不与新顺序号正文混淆', async () => {
  const first = inbox(
    [
      ['M100', message('M100', '100', '第一封', ['pending'])],
      ['M101', message('M101', '101', '第二封', ['pending'])],
    ],
    { mailbox: 'INBOX', epoch: 'E1', sequence: 2, window: [1, 2], changes: [
      { kind: 'arrive', sequence: 1, id: 'M100', uid: '100' },
      { kind: 'arrive', sequence: 2, id: 'M101', uid: '101' },
    ] },
  );
  const env = await harness(first);
  try {
    const initial = await observeRound(env.client, env.archive, ['INBOX']);
    assert.equal(initial.handoff.counts.confirmed, 2);

    // M101 被删除，M102 到达；新邮件继承了原来的顺序位置，但 uid/身份不同。
    env.source.replace('/mail/INBOX', { body: { mailbox: 'INBOX', relation: '/mail/INBOX/relations', messages: [
      { id: 'M100', href: '/mail/INBOX/records/M100' },
      { id: 'M102', href: '/mail/INBOX/records/M102' },
    ] } });
    env.source.replace('/mail/INBOX/records/M102', { body: message('M102', '102', '第三封', ['pending']) });
    env.source.replace('/mail/INBOX/relations', { supportsSince: true, body: {
      mailbox: 'INBOX', epoch: 'E1', sequence: 4, window: [1, 4], changes: [
        { kind: 'arrive', sequence: 1, id: 'M100', uid: '100' },
        { kind: 'arrive', sequence: 2, id: 'M101', uid: '101' },
        { kind: 'expunge', sequence: 3, id: 'M101', uid: '101' },
        { kind: 'arrive', sequence: 4, id: 'M102', uid: '102' },
      ],
    } });
    const after = await observeRound(env.client, env.archive, ['INBOX']);
    const ids = after.handoff.confirmed.current.map(item => item.id).sort();
    assert.deepEqual(ids, ['M100', 'M102']);
    assert.equal(after.handoff.vanishedIncomplete[0].id, 'M101');
    const keys = env.archive.records('INBOX').map(row => row.business_key);
    assert.ok(keys.includes('INBOX:E1:101'));
    assert.ok(keys.includes('INBOX:E1:102'));
  } finally { await env.close(); }
});

test('消失观察之后才到达的迟到摘要不能当作新待补资料', async () => {
  const env = await harness(inbox(
    [['M100', message('M100', '100', '资料', ['pending'])]],
    { mailbox: 'INBOX', epoch: 'E1', sequence: 1, window: [1, 1], changes: [
      { kind: 'arrive', sequence: 1, id: 'M100', uid: '100' },
    ] },
  ));
  try {
    const first = await observeRound(env.client, env.archive, ['INBOX']);
    assert.equal(first.handoff.confirmed.current[0].id, 'M100');

    // 同事删除邮件：目录不再列出，会话先给出 expunge 依据。
    env.source.replace('/mail/INBOX', { body: { mailbox: 'INBOX', relation: '/mail/INBOX/relations', messages: [] } });
    env.source.replace('/mail/INBOX/relations', { supportsSince: true, body: {
      mailbox: 'INBOX', epoch: 'E1', sequence: 2, window: [1, 2], changes: [
        { kind: 'arrive', sequence: 1, id: 'M100', uid: '100' },
        { kind: 'expunge', sequence: 2, id: 'M100', uid: '100' },
      ],
    } });
    const deleted = await observeRound(env.client, env.archive, ['INBOX']);
    assert.equal(deleted.handoff.confirmed.current.length, 0);
    assert.equal(deleted.handoff.vanishedIncomplete[0].id, 'M100');

    // 旧会话回复让原文迟到，目录重新列出；不能把它当成新来的待补资料。
    env.source.replace('/mail/INBOX', { body: { mailbox: 'INBOX', relation: '/mail/INBOX/relations', messages: [
      { id: 'M100', href: '/mail/INBOX/records/M100' },
    ] } });
    const late = await observeRound(env.client, env.archive, ['INBOX']);
    assert.equal(late.handoff.confirmed.current.length, 0);
    assert.equal(late.handoff.lateDocuments[0].id, 'M100');
    assert.equal(late.handoff.vanishedIncomplete[0].id, 'M100');
    assert.equal(late.handoff.complete, false);
    const member = env.archive.getMembers('INBOX', 'E1').find(item => item.id === 'M100');
    assert.equal(member.state, 'vanished');
  } finally { await env.close(); }
});

test('移动关系两端依据齐备才确认，仅主题相同列为可能关系', async () => {
  const initial = {
    ...inbox(
      [['M101', message('M101', '101', '报关单', ['pending'])]],
      { mailbox: 'INBOX', epoch: 'E1', sequence: 1, window: [1, 1], changes: [{ kind: 'arrive', sequence: 1, id: 'M101', uid: '101' }] },
    ),
    ...handover([], { mailbox: 'HANDOVER', epoch: 'E1', sequence: 0, window: [1, 0], changes: [] }),
  };
  const env = await harness(initial);
  try {
    await observeRound(env.client, env.archive, ['INBOX', 'HANDOVER']);
    env.source.replace('/mail/INBOX', { body: { mailbox: 'INBOX', relation: '/mail/INBOX/relations', messages: [] } });
    env.source.replace('/mail/INBOX/relations', { supportsSince: true, body: {
      mailbox: 'INBOX', epoch: 'E1', sequence: 2, window: [1, 2], changes: [
        { kind: 'arrive', sequence: 1, id: 'M101', uid: '101' },
        { kind: 'move', sequence: 2, id: 'M101', uid: '101', destination: 'HANDOVER' },
      ],
    } });
    env.source.replace('/mail/HANDOVER', { body: { mailbox: 'HANDOVER', relation: '/mail/HANDOVER/relations', messages: [
      { id: 'M101', href: '/mail/HANDOVER/records/M101' },
      { id: 'M300', href: '/mail/HANDOVER/records/M300' },
    ] } });
    env.source.replace('/mail/HANDOVER/records/M101', { body: message('M101', '101', '报关单', ['handed'], 'partner@local.invalid', 'HANDOVER') });
    env.source.replace('/mail/HANDOVER/records/M300', { body: message('M300', '300', '另一份同主题', ['handed'], 'partner@local.invalid', 'HANDOVER') });
    env.source.replace('/mail/HANDOVER/relations', { supportsSince: true, body: {
      mailbox: 'HANDOVER', epoch: 'E1', sequence: 2, window: [1, 2], changes: [
        { kind: 'arrive', sequence: 1, id: 'M101', uid: '101' },
        { kind: 'arrive', sequence: 2, id: 'M300', uid: '300' },
      ],
    } });

    const round = await observeRound(env.client, env.archive, ['INBOX', 'HANDOVER']);
    assert.equal(round.handoff.moves.confirmed[0].id, 'M101');
    assert.equal(round.handoff.moves.confirmed[0].to, 'HANDOVER');
    assert.equal(round.handoff.moves.possible.length, 0);
  } finally { await env.close(); }
});

test('无法补发的会话段触发重新确认并保留先前观察依据与缺口', async () => {
  const env = await harness(inbox(
    [['M100', message('M100', '100', '资料', ['pending'])]],
    { mailbox: 'INBOX', epoch: 'E1', sequence: 2, window: [1, 2], changes: [
      { kind: 'arrive', sequence: 1, id: 'M100', uid: '100' },
      { kind: 'flags', sequence: 2, id: 'M100', flags: ['pending'] },
    ] },
  ));
  try {
    await observeRound(env.client, env.archive, ['INBOX']);
    // 来源窗口已经滑过本地游标，第 3、4 步变更无法再补发。
    env.source.replace('/mail/INBOX/relations', { supportsSince: true, body: {
      mailbox: 'INBOX', epoch: 'E1', sequence: 5, window: [5, 5], changes: [
        { kind: 'flags', sequence: 5, id: 'M100', flags: ['handed'] },
      ],
    } });
    const round = await observeRound(env.client, env.archive, ['INBOX']);
    const reset = round.folders[0].session;
    assert.equal(reset.mode, 'reset');
    const gap = round.handoff.gaps.find(item => item.kind === 'session-reset');
    assert.equal(gap.priorObservedSequence, 2);
    assert.equal(gap.currentEpoch, 'E1');
  } finally { await env.close(); }
});

test('代际切换后旧代际身份不能复活，需重新确认成员', async () => {
  const env = await harness(inbox(
    [['M100', message('M100', '100', '资料', ['pending'])]],
    { mailbox: 'INBOX', epoch: 'E1', sequence: 1, window: [1, 1], changes: [{ kind: 'arrive', sequence: 1, id: 'M100', uid: '100' }] },
  ));
  try {
    await observeRound(env.client, env.archive, ['INBOX']);
    env.source.replace('/mail/INBOX/relations', { supportsSince: true, body: {
      mailbox: 'INBOX', epoch: 'E2', sequence: 1, window: [1, 1], changes: [{ kind: 'arrive', sequence: 1, id: 'M100', uid: '100' }],
    } });
    const round = await observeRound(env.client, env.archive, ['INBOX']);
    assert.equal(round.folders[0].session.mode, 'reset');
    assert.equal(round.folders[0].epoch, 'E2');
    const gap = round.handoff.gaps.find(item => item.kind === 'session-reset');
    assert.equal(gap.priorEpoch, 'E1');
    const current = env.archive.getMembers('INBOX', 'E2');
    assert.equal(current.length, 1);
    assert.equal(current[0].state, 'current');
  } finally { await env.close(); }
});

test('来源 404/503 不能解释成删除，未读到的成员不计入已移交', async () => {
  const env = await harness(inbox(
    [['M100', message('M100', '100', '资料', ['handed'])]],
    { mailbox: 'INBOX', epoch: 'E1', sequence: 1, window: [1, 1], changes: [{ kind: 'arrive', sequence: 1, id: 'M100', uid: '100' }] },
  ));
  try {
    await observeRound(env.client, env.archive, ['INBOX']);
    env.source.fail('/mail/INBOX/records/M100', 404, 1);
    env.source.fail('/mail/INBOX/relations', 503, 2);
    const round = await observeRound(env.client, env.archive, ['INBOX']);
    assert.equal(round.handoff.complete, false);
    assert.equal(round.handoff.unread[0].id, 'M100');
    assert.equal(round.handoff.vanishedIncomplete.length, 0);
    assert.ok(round.handoff.gaps.some(gap => gap.kind === 'relation-unavailable'));
    assert.ok(round.handoff.gaps.some(gap => gap.kind === 'record-unread'));
    // 先前已保存原文仍可复查，缺口不能抹掉已有依据。
    assert.equal(env.archive.records('INBOX').length, 1);
  } finally { await env.close(); }
});

test('持续观察循环可由调用方停止，每轮输出当前工作状态', async () => {  const env = await harness(inbox(
    [['M100', message('M100', '100', '资料', ['pending'])]],
    { mailbox: 'INBOX', epoch: 'E1', sequence: 1, window: [1, 1], changes: [{ kind: 'arrive', sequence: 1, id: 'M100', uid: '100' }] },
  ));
  const controller = new AbortController();
  try {
    const seen = [];
    const done = observe(env.client, env.archive, ['INBOX'], {
      intervalMs: 10,
      signal: controller.signal,
      onRound: round => {
        seen.push(round.handoff.counts.confirmed);
        if (seen.length === 2) controller.abort();
      },
    });
    const result = await done;
    assert.equal(result.stopReason, 'aborted');
    assert.equal(seen.length, 2);
  } finally { controller.abort(); await env.close(); }
});
