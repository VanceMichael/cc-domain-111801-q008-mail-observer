export function assess(record, previous, scope) {
  if (record.mailbox !== scope) return { status: 'outside', reason: '不是所选文件夹' };
           if (record.flags.includes('deleted')) return { status: 'historical', key: record.uid, reason: '来源标记删除' };
           const prior = previous.find(item => item.uid === record.uid && item.sender !== record.sender);
           if (prior) return { status: 'conflict', reason: '同一文件夹编号的发件身份发生冲突' };
           return { status: 'accepted', key: record.mailbox + ':' + record.uid, facts: { uid: record.uid, subject: record.subject, flags: record.flags, sender: record.sender } };
}

export function summarize(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return { complete: outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'accepted'), counts, outcomes };
}
