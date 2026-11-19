import { interpretRelation } from './interpret.mjs';

// 读取文件夹的会话变更资料；404/403/503 属于来源暂不发布，不能自行解释成业务删除。
export async function readRelation(client, href, { since } = {}) {
  let target = href;
  if (Number.isInteger(since) && since >= 0) {
    const separator = href.includes('?') ? '&' : '?';
    target = href + separator + 'since=' + since;
  }
  const document = await client.get(target);
  const relation = interpretRelation(document.raw);
  relation.location = document.location;
  relation.observedAt = document.observedAt;
  return relation;
}

// 依据本地已观察到的代际与顺序号，决定本轮如何消费来源会话。
// 稳定标识只在所属邮箱代际内成立：代际变化必须重新确认整个文件夹。
export function planSession(relation, state) {
  if (!state || state.epoch !== relation.epoch) {
    return {
      mode: 'reset',
      reason: state ? '来源会话代际变化，需重新确认成员与标记' : '首次观察该文件夹',
      epoch: relation.epoch,
      observedSequence: 0,
      changes: relation.changes,
    };
  }
  const [lower] = relation.window;
  if (state.observedSequence > 0 && state.observedSequence < lower) {
    return {
      mode: 'reset',
      reason: '来源已无法补发中间变更，需重新确认成员与标记',
      epoch: relation.epoch,
      observedSequence: state.observedSequence,
      changes: relation.changes,
    };
  }
  const applied = relation.changes.filter(change => change.sequence > state.observedSequence);
  return {
    mode: applied.length ? 'apply' : 'idle',
    reason: applied.length ? '应用来源会话的新增变更' : '会话没有新的变更',
    epoch: relation.epoch,
    observedSequence: state.observedSequence,
    changes: applied,
  };
}

// 本轮处理成功后，会话观察依据可以推进到来源当前顺序号。
export function nextSessionBasis(plan, relation) {
  return { epoch: relation.epoch, observedSequence: relation.sequence, window: relation.window, location: relation.location, observedAt: relation.observedAt };
}
