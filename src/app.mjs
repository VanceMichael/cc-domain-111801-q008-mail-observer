import { browse, retrieve } from './source.mjs';
import { interpret } from './interpret.mjs';
import { assess, summarize } from './receiving.mjs';
import { readRelation, planSession, nextSessionBasis } from './session.mjs';
import { reconcileFolder, buildHandoff, workState } from './handoff.mjs';

export async function preview(client) {
  const manifest = await browse(client);
  const entries = [];
  for (const ref of manifest.references) {
    const document = await retrieve(client, ref);
    entries.push(interpret(document.raw));
  }
  return { context: manifest.context, entries };
}

export async function collect(client, archive, scope, operator) {
  const manifest = await browse(client);
  const outcomes = [];
  for (const reference of manifest.references) {
    let digest;
    try {
      const document = await retrieve(client, reference);
      digest = await archive.preserve(document);
      const record = interpret(document.raw);
      const prior = archive.records(scope).filter(item => item.decision.status === 'accepted').map(item => item.record);
      const decision = assess(record, prior, scope);
      if (operator && decision.status === 'accepted') decision.portal = await operator(record);
      archive.put(scope, decision.key ?? reference.identity, digest, record, decision);
      outcomes.push({ reference: reference.identity, digest, ...decision });
    } catch (error) {
      outcomes.push({ reference: reference.identity, digest, status: 'error', reason: error.message });
    }
  }
  return { context: manifest.context, ...summarize(outcomes) };
}

function receiptKey(folder, epoch, record) {
  return folder + ':' + epoch + ':' + record.uid;
}

// 对一个文件夹执行一轮观察：读取会话变更资料、补查目录成员、保存实际读到的原文。
async function observeFolder(client, archive, folder) {
  const manifest = await browse(client, folder);
  if (manifest.context !== folder) throw new Error('来源目录上下文与所选文件夹不符');
  const sessionGaps = [];

  const previousState = archive.getSession(folder);
  let relation = null;
  if (manifest.relation) {
    try {
      // 利用本地邮箱会话的补查能力：带上本地已确认的顺序号，只取之后的变更。
      relation = await readRelation(client, manifest.relation, { since: previousState?.observedSequence });
      if (relation.mailbox && relation.mailbox !== folder) throw new Error('会话资料归属文件夹与目录不符');
    } catch (error) {
      // HTTP 404/403/503 或解析失败都不能自行解释成业务删除，先留缺口再核对目录。
      sessionGaps.push({ kind: 'relation-unavailable', folder, reason: error.message });
    }
  } else {
    sessionGaps.push({ kind: 'relation-undeclared', folder, reason: '来源目录没有提供会话变更资料位置' });
  }

  const plan = relation ? planSession(relation, previousState) : null;
  const epoch = relation?.epoch ?? previousState?.epoch ?? null;

  if (plan?.mode === 'reset' && previousState) {
    sessionGaps.push({
      kind: 'session-reset',
      folder,
      reason: plan.reason,
      priorEpoch: previousState.epoch,
      priorObservedSequence: previousState.observedSequence,
      currentEpoch: relation.epoch,
    });
  }

  // 代际内沿用已确认成员；代际变化后旧成员不能复活，新代际从当前目录重新确认。
  const storedMembers = epoch ? archive.getMembers(folder, epoch) : [];
  const storedById = new Map(storedMembers.map(member => [member.id, member]));
  const records = new Map();
  const outcomes = [];
  const failures = [];

  for (const reference of manifest.references) {
    try {
      const document = await retrieve(client, reference);
      const digest = await archive.preserve(document);
      const record = interpret(document.raw);
      record.basis = { observedAt: document.observedAt, location: document.location, digest, epoch, sequence: relation?.sequence ?? null };
      records.set(reference.identity, record);

      if (epoch) {
        const prior = archive.records(folder).filter(item => item.decision.status === 'accepted' && item.decision.epoch === epoch).map(item => item.record);
        const decision = assess(record, prior, folder);
        if (decision.status === 'accepted') {
          decision.epoch = epoch;
          archive.put(folder, receiptKey(folder, epoch, record), digest, record, decision);
        }
        outcomes.push({ reference: reference.identity, digest, ...decision });
      }
    } catch (error) {
      failures.push({ id: reference.identity, reason: error.message });
      sessionGaps.push({ kind: 'record-unread', folder, id: reference.identity, reason: error.message });
    }
  }

  const lateIds = [];
  if (epoch) {
    for (const [id] of records) {
      const stored = storedById.get(id);
      // 只有先前轮次已证实消失、之后又读到的原文才算迟到；同轮历史里的 expunge 不能回溯成“先观察到消失”。
      if (stored?.state === 'vanished') lateIds.push(id);
    }

    for (const reference of manifest.references) {
      const id = reference.identity;
      const record = records.get(id);
      const stored = storedById.get(id);
      if (lateIds.includes(id)) {
        if (stored) {
          archive.upsertMember(folder, epoch, { ...stored, state: 'vanished', basis: stored.basis ?? { reason: '先前已证实消失' } });
        }
        continue;
      }
      if (!record) {
        if (!stored) {
          archive.upsertMember(folder, epoch, { id, uid: null, record: null, state: 'unread', workState: 'unmarked', basis: { reason: '目录列出但原文尚未读到' } });
        }
        continue;
      }
      archive.upsertMember(folder, epoch, {
        id, uid: record.uid, record, state: 'current', workState: workState(record.flags),
        basis: record.basis,
      });
    }

    const currentIds = new Set(manifest.references.map(reference => reference.identity));
    for (const member of storedMembers) {
      if (currentIds.has(member.id) || member.state !== 'current') continue;
      const change = plan?.changes.find(item => (item.kind === 'expunge' || item.kind === 'move') && item.id === member.id);
      if (change) {
        archive.upsertMember(folder, epoch, {
          ...member, state: 'vanished',
          workState: member.workState,
          basis: { ...change, observedAt: relation.observedAt, location: relation.location },
        });
      } else {
        sessionGaps.push({ kind: 'unconfirmed-member', folder, id: member.id, reason: '目录不再列出且缺少会话消失依据，无法确认去向' });
      }
    }

    if (plan) {
      for (const change of plan.changes) {
        if ((change.kind === 'expunge' || change.kind === 'move') && change.id && !storedById.has(change.id) && !records.has(change.id)) {
          sessionGaps.push({ kind: 'unaccounted-removal', folder, change, reason: '会话声明移除了本地从未确认过的成员' });
        }
      }
    }
  }

  if (relation && epoch) {
    archive.putSession(folder, nextSessionBasis(plan, relation));
  }

  const refreshedMembers = epoch ? archive.getMembers(folder, epoch) : [];
  const reconciliation = epoch ? reconcileFolder({
    folder,
    epoch,
    storedMembers: refreshedMembers,
    references: manifest.references,
    records,
    failedIds: failures.map(failure => failure.id),
    lateIds,
    evidence: plan?.changes ?? [],
  }) : { folder, epoch, confirmed: [], unread: failures.map(failure => ({ id: failure.id, reason: failure.reason })), vanished: [], lateDocuments: [], gaps: [] };

  for (const gap of sessionGaps) archive.addGap(folder, epoch ?? 'unknown', gap);
  return {
    folder,
    epoch,
    session: plan ? { mode: plan.mode, reason: plan.reason, observedSequence: relation.sequence, window: relation.window, location: relation.location, observedAt: relation.observedAt } : null,
    reconciliation,
    sessionGaps,
    outcomes,
  };
}

// 一轮完整观察：覆盖所有业务文件夹，输出同事可确认的交接状态。
export async function observeRound(client, archive, folders) {
  if (!Array.isArray(folders) || folders.length === 0) throw new Error('观察文件夹范围为空');
  const observed = [];
  for (const folder of folders) {
    try {
      observed.push(await observeFolder(client, archive, folder));
    } catch (error) {
      archive.addGap(folder, 'unknown', { kind: 'folder-unavailable', folder, reason: error.message });
    }
  }
  const handoff = buildHandoff(observed.map(item => item.reconciliation), archive.listGaps());
  return {
    observedAt: new Date().toISOString(),
    folders: observed.map(item => ({ folder: item.folder, epoch: item.epoch, session: item.session, outcomes: item.outcomes })),
    handoff,
  };
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// 持续接收：利用本地邮箱会话的变更观察与补查能力轮询，直到调用方停止。
export async function observe(client, archive, folders, { intervalMs = 500, signal, onRound } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) throw new Error('观察间隔无效');
  const rounds = [];
  let stopped = false;
  const stop = () => { stopped = true; };
  signal?.addEventListener('abort', stop, { once: true });
  while (!stopped) {
    const round = await observeRound(client, archive, folders);
    rounds.push(round);
    await onRound?.(round);
    if (stopped) break;
    await delay(intervalMs);
  }
  return { rounds, stopReason: signal?.aborted ? 'aborted' : 'stopped' };
}
