import { text, integer, integerPair } from './validation.mjs';

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  const uid = text(raw.uid, 'uid');
           if (!/^\d+$/.test(uid) || !Array.isArray(raw.flags) || raw.flags.some(flag => typeof flag !== 'string')) throw new Error('邮件编号或工作标记无效');
           return { message: text(raw.message, 'message'), mailbox: text(raw.mailbox, 'mailbox'), uid, subject: text(raw.subject, 'subject'), sender: text(raw.sender, 'sender'), flags: [...new Set(raw.flags)].sort() };
}

export const changeKinds = ['expunge', 'flags', 'move', 'arrive'];

export function interpretChange(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('变更记录不是对象');
  const kind = text(raw.kind, 'kind');
  if (!changeKinds.includes(kind)) throw new Error('未知的会话变更类型：' + kind);
  const change = { kind, sequence: integer(raw.sequence, 'sequence') };
  if (typeof raw.id === 'string' && raw.id.trim()) change.id = raw.id;
  if (typeof raw.uid === 'string' && /^\d+$/.test(raw.uid)) change.uid = raw.uid;
  if (Array.isArray(raw.flags) && raw.flags.every(flag => typeof flag === 'string')) change.flags = [...new Set(raw.flags)].sort();
  if (typeof raw.destination === 'string' && raw.destination.trim()) change.destination = raw.destination;
  return change;
}

export function interpretRelation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('会话资料不是对象');
  if (!Array.isArray(raw.changes)) throw new Error('会话变更序列结构无效');
  const sequences = new Set();
  const changes = raw.changes.map((entry, index) => {
    const change = interpretChange(entry);
    if (sequences.has(change.sequence)) throw new Error('会话变更顺序号重复：' + change.sequence);
    sequences.add(change.sequence);
    change.order = index;
    return change;
  }).sort((left, right) => left.sequence - right.sequence);
  if (changes.some((change, index) => index > 0 && change.sequence !== changes[index - 1].sequence + 1)) {
    throw new Error('会话变更顺序号不连续，无法补查');
  }
  return {
    epoch: text(raw.epoch, 'epoch'),
    sequence: integer(raw.sequence, 'sequence'),
    changes,
    window: integerPair(raw.window, 'window'),
    mailbox: typeof raw.mailbox === 'string' && raw.mailbox.trim() ? text(raw.mailbox, 'mailbox') : null,
  };
}
