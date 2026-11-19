// 交接领域：把会话观察结果分成同事可确认的工作状态。
// 只依据来源文件夹、标记和已保存原文；不下载附件、不代发邮件。

export function workState(flags = []) {
  if (flags.includes('handed')) return 'handed';
  if (flags.includes('pending')) return 'pending';
  return 'unmarked';
}

function memberView(member) {
  return {
    id: member.id,
    uid: member.uid ?? null,
    subject: member.record?.subject ?? null,
    sender: member.record?.sender ?? null,
    flags: member.record?.flags ?? [],
    workState: member.workState ?? workState(member.record?.flags),
    basis: member.basis,
  };
}

/**
 * 核对单个文件夹在同一代际内的成员。
 *
 * @param storedMembers 本地保存的该代际成员（含先前证实消失的成员）
 * @param references    本轮目录当前列出的成员身份
 * @param records       本轮实际读到原文的身份到领域记录
 * @param failedIds     本轮目录列出但原文读取失败的身份（不能凭旧记录算作已确认）
 * @param lateIds       目录仍列出、但已先观察到消失的迟到原文身份
 * @param evidence      本轮会话变更给出的消失依据（expunge/move）
 */
export function reconcileFolder({ folder, epoch, storedMembers, references, records, failedIds = [], lateIds, evidence }) {
  const currentIds = new Set(references.map(reference => reference.identity));
  const stored = new Map(storedMembers.map(member => [member.id, member]));
  const late = new Set(lateIds);
  const failed = new Set(failedIds);
  const vanishedEvidence = new Map();
  for (const item of evidence) {
    if ((item.kind === 'expunge' || item.kind === 'move') && item.id) vanishedEvidence.set(item.id, item);
  }

  const confirmed = [];
  const unread = [];
  const lateDocuments = [];
  const gaps = [];

  for (const reference of references) {
    const id = reference.identity;
    const record = records.get(id);
    if (late.has(id)) {
      lateDocuments.push({ id, uid: record?.uid ?? stored.get(id)?.uid ?? null, reason: '消失观察之后才到达的迟到原文，不能当作新待补资料', record: record ?? null });
      continue;
    }
    if (!record || failed.has(id)) {
      unread.push({ id, reason: failed.has(id) ? '来源暂时无法读取，不能凭旧记录计入已移交' : '目录列出但原文尚未读到，不能计入已移交' });
      continue;
    }
    confirmed.push({ id, uid: record.uid, subject: record.subject, sender: record.sender, flags: record.flags, workState: workState(record.flags), basis: record.basis });
  }

  const vanished = [];
  for (const member of storedMembers) {
    if (currentIds.has(member.id) && !late.has(member.id)) continue;
    const observed = vanishedEvidence.get(member.id);
    const isLate = late.has(member.id);
    if (member.state === 'vanished' || observed || isLate) {
      const view = memberView(member);
      vanished.push({
        ...view,
        reason: isLate
          ? '迟到原文到达前已观察到该成员消失，旧会话回复不能将其复活'
          : observed ? '会话变更证实成员已从该文件夹移除' : '先前轮次已证实消失，旧会话回复不能将其复活',
        basis: observed ?? member.basis,
        incomplete: (member.workState ?? workState(member.record?.flags)) === 'pending',
      });
    } else {
      gaps.push({ kind: 'unconfirmed-member', folder, id: member.id, reason: '目录不再列出且缺少会话消失依据，无法确认去向' });
    }
  }

  for (const item of evidence) {
    if ((item.kind === 'expunge' || item.kind === 'move') && item.id && !stored.has(item.id)) {
      gaps.push({ kind: 'unaccounted-removal', folder, change: item, reason: '会话声明移除了本地从未确认过的成员' });
    }
  }

  return { folder, epoch, confirmed, unread, vanished, lateDocuments, gaps };
}

// 移动关系必须两端都有依据：来源端观察到消失，目标端当前存在同一稳定身份。
// 主题相同不构成移动依据，跨代际身份最多列为可能关系。
export function inferMoves(folders) {
  const confirmed = [];
  const possible = [];

  for (const source of folders) {
    for (const vanished of source.vanished) {
      for (const destination of folders) {
        if (destination.folder === source.folder) continue;
        const sameIdentity = destination.confirmed.find(member => member.id === vanished.id);
        if (sameIdentity && destination.epoch === source.epoch) {
          const moveEvidence = vanished.basis?.kind === 'move' && vanished.basis.destination === destination.folder;
          confirmed.push({
            id: vanished.id,
            from: source.folder,
            to: destination.folder,
            reason: moveEvidence ? '会话移动变更与目标文件夹当前成员相互印证' : '来源端已证实消失且目标端存在同一稳定身份',
            evidence: { source: vanished.basis, destination: sameIdentity.basis },
          });
          continue;
        }
        const sameSubject = vanished.subject && destination.confirmed.find(member =>
          member.subject === vanished.subject && (member.id !== vanished.id || destination.epoch !== source.epoch));
        if (sameSubject) {
          possible.push({
            id: vanished.id,
            from: source.folder,
            to: destination.folder,
            reason: destination.epoch === source.epoch
              ? '来源端观察到消失且主题相同，但缺少同一稳定身份，不能仅凭主题认定移动'
              : '两端分属不同邮箱代际，稳定身份不能跨代际对齐',
            subject: vanished.subject,
          });
        }
      }
    }
  }
  return { confirmed, possible: dedupe(possible, item => [item.from, item.to, item.id, item.subject].join('|')) };
}

function dedupe(items, keyOf) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildHandoff(folders, sessionGaps = []) {
  const moves = inferMoves(folders);
  const confirmedMembers = folders.flatMap(folder => folder.confirmed.map(member => ({ ...member, folder: folder.folder })));
  const vanishedMembers = folders.flatMap(folder => folder.vanished.map(member => ({ ...member, folder: folder.folder })));
  const unread = folders.flatMap(folder => folder.unread.map(item => ({ ...item, folder: folder.folder })));
  const late = folders.flatMap(folder => folder.lateDocuments.map(item => ({ ...item, folder: folder.folder })));
  const mergedGaps = [...sessionGaps, ...folders.flatMap(folder => folder.gaps)];
  const gaps = dedupe(mergedGaps, gap => [
    gap.folder, gap.kind, gap.id ?? '', gap.change ? JSON.stringify(gap.change) : '',
    gap.priorEpoch ?? '', gap.priorObservedSequence ?? '', gap.currentEpoch ?? '', gap.reason ?? '',
  ].join('|'));
  const handed = confirmedMembers.filter(member => member.workState === 'handed');
  const pending = confirmedMembers.filter(member => member.workState === 'pending');
  const complete = folders.length > 0
    && unread.length === 0
    && gaps.length === 0
    && vanishedMembers.every(member => !member.incomplete)
    && late.length === 0;
  return {
    complete,
    confirmed: {
      current: confirmedMembers,
      handedOver: handed,
      pendingMaterials: pending,
    },
    vanishedIncomplete: vanishedMembers,
    moves,
    lateDocuments: late,
    unread,
    gaps,
    counts: {
      confirmed: confirmedMembers.length,
      handed: handed.length,
      pending: pending.length,
      vanished: vanishedMembers.length,
      confirmedMoves: moves.confirmed.length,
      possibleMoves: moves.possible.length,
      late: late.length,
      unread: unread.length,
      gaps: gaps.length,
    },
  };
}
