// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Sidequestered.
// A copy of packages/core/src/codec.ts in the Bookdelver repository, shared with
// this server under the MIT licence (LICENSE). Edit the original there: a test
// in that repository holds this copy to it, byte for byte below this header.

/**
 * Text codes for things a player copies and pastes: their bytes, a checksum
 * and an alphabet that survives a message. Pure, with no DOM and no Node:
 * core runs in the client, on a server and in tests, so it brings its own
 * UTF-8 and base64url rather than `TextEncoder` and `btoa`.
 *
 * A save's backup (`apps/client/src/backup.ts`) and a scenario's code
 * (`scenario.ts`, docs/proposals/dm-scenarios.md) share the checksum.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE), as zip and PNG use it. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A CRC-32 as eight lowercase hex digits. */
export function crcHex(n: number): string {
  return n.toString(16).padStart(8, '0')
}

/** `text` as UTF-8. A lone surrogate becomes U+FFFD, as `TextEncoder` makes it. */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      )
    }
  }
  return Uint8Array.from(out)
}

/**
 * UTF-8 back to text, strictly: undefined for anything that isn't well-formed
 * UTF-8 (a stray continuation byte, a sequence cut short, an overlong form, a
 * surrogate, past U+10FFFF), as `TextDecoder`'s `fatal` refuses it.
 */
export function utf8Decode(bytes: Uint8Array): string | undefined {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]!
    let need: number
    let c: number
    let least: number
    if (b < 0x80) {
      out += String.fromCharCode(b)
      i++
      continue
    } else if (b >= 0xc2 && b <= 0xdf) {
      need = 1
      c = b & 0x1f
      least = 0x80
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2
      c = b & 0x0f
      least = 0x800
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3
      c = b & 0x07
      least = 0x10000
    } else return undefined
    for (let k = 1; k <= need; k++) {
      const n = bytes[i + k]
      if (n === undefined || (n & 0xc0) !== 0x80) return undefined
      c = (c << 6) | (n & 0x3f)
    }
    if (c < least || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return undefined
    if (c >= 0x10000) {
      const v = c - 0x10000
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
    } else out += String.fromCharCode(c)
    i += need + 1
  }
  return out
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Bytes as base64url, unpadded: letters, digits, `-` and `_`, safe in a link and a message. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += BASE64URL[(n >> 18) & 63]! + BASE64URL[(n >> 12) & 63]!
    if (b !== undefined) out += BASE64URL[(n >> 6) & 63]!
    if (c !== undefined) out += BASE64URL[n & 63]!
  }
  return out
}

/**
 * Base64url back to bytes, strictly: undefined for any character outside
 * its alphabet, padding, or a length no bytes give. The unused low bits of
 * the last character must be 0, so one set of bytes has one spelling.
 */
export function fromBase64Url(text: string): Uint8Array | undefined {
  if (text.length % 4 === 1) return undefined
  const values: number[] = []
  for (let i = 0; i < text.length; i++) {
    const v = BASE64URL.indexOf(text[i]!)
    if (v < 0) return undefined
    values.push(v)
  }
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let o = 0
  for (let i = 0; i < values.length; i += 4) {
    const a = values[i]!
    const b = values[i + 1]!
    const c = values[i + 2]
    const d = values[i + 3]
    const n = (a << 18) | (b << 12) | ((c ?? 0) << 6) | (d ?? 0)
    out[o++] = (n >> 16) & 0xff
    if (c === undefined) {
      if ((b & 0x0f) !== 0) return undefined
      break
    }
    out[o++] = (n >> 8) & 0xff
    if (d === undefined) {
      if ((c & 0x03) !== 0) return undefined
      break
    }
    out[o++] = n & 0xff
  }
  return out
}
