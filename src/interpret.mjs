import { text, decimal } from './validation.mjs';

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  const uid = text(raw.uid, 'uid');
           if (!/^\d+$/.test(uid) || !Array.isArray(raw.flags) || raw.flags.some(flag => typeof flag !== 'string')) throw new Error('邮件编号或工作标记无效');
           return { message: text(raw.message, 'message'), mailbox: text(raw.mailbox, 'mailbox'), uid, subject: text(raw.subject, 'subject'), sender: text(raw.sender, 'sender'), flags: [...new Set(raw.flags)].sort() };
}
