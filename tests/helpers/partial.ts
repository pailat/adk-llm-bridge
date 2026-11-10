/**
 * Deep partial of `T`: every object field is optional at every depth.
 * Functions are kept whole so a fixture cannot pass a half-typed callback.
 */
export type PartialDeep<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly PartialDeep<Item>[]
    : T extends object
      ? { [Key in keyof T]?: PartialDeep<T[Key]> }
      : T;

/**
 * Types a partial fixture as the full `T`, for tests that read only the
 * fields they set. Each given field is still checked against `T`.
 */
export function fromPartial<T>(value: PartialDeep<T>): T {
  return value as unknown as T;
}
