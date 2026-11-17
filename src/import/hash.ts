/*!
 * hash-wasm 4.12.0 — SHA-256, bundled locally; https://github.com/Daninet/hash-wasm
 * MIT License
 *
 * Copyright (c) 2020 Dani Biró
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/*! sha256.c - an implementation of SHA-256/224 hash functions
 * based on FIPS 180-3 (Federal Information Processing Standart).
 *
 * Copyright (c) 2010, Aleksey Kravchenko <rhash.admin@gmail.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE  INCLUDING ALL IMPLIED WARRANTIES OF  MERCHANTABILITY
 * AND FITNESS.  IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT,  OR CONSEQUENTIAL DAMAGES  OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE,  DATA OR PROFITS,  WHETHER IN AN ACTION OF CONTRACT,  NEGLIGENCE
 * OR OTHER TORTIOUS ACTION,  ARISING OUT OF  OR IN CONNECTION  WITH THE USE  OR
 * PERFORMANCE OF THIS SOFTWARE.

 * Modified for hash-wasm by Dani Biró
 */
import { createSHA256 } from 'hash-wasm';

/** Incremental SHA-256, bundled locally. No whole-file copy or Web Crypto input snapshot. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array, signal?: AbortSignal, progress?: (done: number, total: number) => void): Promise<string> {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  const check = () => { if (signal?.aborted) throw new DOMException('cancelled', 'AbortError'); };
  check();
  const hash = await createSHA256();
  const chunk = 1024 * 1024;
  for (let off = 0; off < view.byteLength; off += chunk) {
    check();
    hash.update(view.subarray(off, Math.min(off + chunk, view.byteLength)));
    progress?.(Math.min(off + chunk, view.byteLength), view.byteLength);
    // Let iPad paint progress and dispatch Cancel without retaining a second file buffer.
    if (off + chunk < view.byteLength) await new Promise<void>((r) => setTimeout(r, 0));
  }
  check();
  return hash.digest('hex');
}
