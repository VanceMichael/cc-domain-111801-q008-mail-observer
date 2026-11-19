export function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('字段缺失或无效：' + name);
  return value;
}
export function decimal(value, name) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('十进制字段无效：' + name);
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error('数值超出范围：' + name);
  return result;
}
export function integer(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('整数字段无效：' + name);
  return value;
}
export function integerPair(value, name) {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('区间字段无效：' + name);
  const [lower, upper] = value.map((item, index) => integer(item, name + '[' + index + ']'));
  if (lower < 0 || lower > upper) throw new Error('区间起止顺序无效：' + name);
  return [lower, upper];
}
