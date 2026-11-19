import { text } from './validation.mjs';

export const collectionPath = "/mail/INBOX";
export function folderPath(scope) {
  const folder = text(scope, 'scope');
  if (folder.startsWith('/') || folder.includes('?') || folder.includes('#')) throw new Error('文件夹范围无效');
  return '/mail/' + folder;
}
export async function browse(client, scope = collectionPath) {
  const path = scope === collectionPath ? collectionPath : folderPath(scope);
  const document = await client.get(path);
  const raw = document.raw;
  const context = text(raw.mailbox, 'mailbox');
  if (!Array.isArray(raw.messages)) throw new Error('来源目录结构无效');
  const references = raw.messages.map(entry => ({
    identity: text(entry.id, 'id'), href: text(entry.href, 'href'), context,
  }));
  if (new Set(references.map(entry => entry.identity)).size !== references.length) throw new Error('目录包含重复来源身份');
  const relation = typeof raw.relation === 'string' && raw.relation.trim() ? text(raw.relation, 'relation') : null;
  return { context, references, relation, document };
}
export async function retrieve(client, reference) {
  const document = await client.get(reference.href);
  if (document.raw.message !== reference.identity) throw new Error('原文身份与目录引用不符');
  if (document.raw.mailbox !== reference.context) throw new Error('原文上下文与目录不符');
  return document;
}
