/**
 * Recursive JSON Walker
 * Walks a JSON-serializable value and transforms all string leaves.
 */

/**
 * Async function that transforms a string value.
 */
export type StringProcessor = (s: string) => Promise<string>;

/**
 * Recursively rehydrate PII tags in every string field of a JSON-like value.
 *
 * 与 `walkJson` 的区别在于：返回的对象仍是入参本身（in-place 修改对象与
 * 数组），数组和对象的引用也保持不变。这与 OpenCode Plugin V2 的 tool hook
 * 行为一致（hook 持有入参引用，不能替换根对象）。
 *
 * 空字符串 / 非字符串值不变。包含 `tagPrefix` 的字符串才走 `rehydrate`，
 * 其余字符串保持原样以减少会话解密开销。
 */
export async function deepRehydrateJson<T>(
  value: T,
  rehydrate: (text: string) => Promise<string>,
  tagPrefix: string,
): Promise<T> {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.includes(tagPrefix)) {
      return (await rehydrate(value)) as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      (value as unknown[])[i] = await deepRehydrateJson(
        (value as unknown[])[i],
        rehydrate,
        tagPrefix,
      );
    }
    return value;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      obj[key] = await deepRehydrateJson(obj[key], rehydrate, tagPrefix);
    }
    return value;
  }
  return value;
}

/**
 * Recursively walks a JSON-serializable value and applies a string processor
 * to every string leaf. Returns a deep copy with all strings transformed.
 *
 * Strings are processed **sequentially** to ensure deterministic PII ID
 * assignment when used with session.anonymize().
 *
 * @param value - Any JSON-serializable value (object, array, string, number, boolean, null)
 * @param processString - Async function to transform each string leaf
 * @returns Deep copy of the value with all strings transformed
 */
export async function walkJson<T>(
  value: T,
  processString: StringProcessor,
): Promise<T> {
  // null
  if (value === null || value === undefined) {
    return value;
  }

  // string — process it
  if (typeof value === "string") {
    return (await processString(value)) as T;
  }

  // non-object primitives (number, boolean) — pass through
  if (typeof value !== "object") {
    return value;
  }

  // array — walk each element sequentially
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      result.push(await walkJson(item, processString));
    }
    return result as T;
  }

  // plain object — walk each own enumerable property sequentially
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    result[key] = await walkJson(
      (value as Record<string, unknown>)[key],
      processString,
    );
  }
  return result as T;
}
