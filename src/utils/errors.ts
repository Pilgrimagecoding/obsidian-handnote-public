/** Anything thrown / rejected, as an Error (keeps the message of non-Error values). */
export function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(typeof e === 'string' ? e : JSON.stringify(e) ?? String(e));
}
