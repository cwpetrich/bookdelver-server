// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Sidequestered.
// A copy of packages/core/src/reader.ts in the Bookdelver repository, shared with
// this server under the MIT licence (LICENSE). Edit the original there: a test
// in that repository holds this copy to it, byte for byte below this header.

/**
 * Reading untrusted data (docs/proposals/dm-scenarios.md, "Checking it:
 * untrusted from the first byte"): what a scenario code and a character code
 * are read with. Every read is of an own property, every number whole and in
 * range, every text capped and free of characters that can't be shown, every
 * list capped; problems are kept, up to `PROBLEM_CAP`, so the person who
 * pasted it sees more than the first.
 */

/** At most this many problems are listed: past it, the list says so. */
export const PROBLEM_CAP = 20

/**
 * Whether `text` holds a character never in a code's text: a control (a
 * line break apart, where `lines` allows it), or a mark that turns text
 * round or hides it (the zero-width ones, the bidirectional overrides and
 * isolates, a byte-order mark, the interlinear annotations).
 */
export function unsafeText(text: string, lines: boolean): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x0a ? !lines : c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e)) return true
    if ((c >= 0x2060 && c <= 0x2069) || c === 0xfeff || (c >= 0xfff9 && c <= 0xfffb)) return true
  }
  return false
}

/** A problem found, with where: what the whole check stops at once it has enough. */
export class Stop extends Error {}

/**
 * Reads untrusted values: every read is of an own property, every number
 * whole and in range, every string capped. Problems are kept; the reader
 * carries on so the Author sees more than the first.
 */
export class Reader {
  readonly problems: string[] = []

  problem(where: string, what: string): void {
    this.problems.push(where === '' ? what : `${where}: ${what}`)
    if (this.problems.length >= PROBLEM_CAP) throw new Stop()
  }

  /** `value` as a plain object with only the keys allowed, or undefined (a problem said). */
  object(
    value: unknown,
    where: string,
    allowed: readonly string[],
  ): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.problem(where, 'should be an object')
      return undefined
    }
    const proto = Object.getPrototypeOf(value) as unknown
    if (proto !== Object.prototype && proto !== null) {
      this.problem(where, 'should be a plain object')
      return undefined
    }
    const keys = Object.keys(value)
    // Every key named, up to a few more than are known: past that, too many to list.
    for (const key of keys.slice(0, allowed.length + 4)) {
      if (!allowed.includes(key)) {
        this.problem(
          where,
          `"${key.slice(0, 24)}" isn't known here (made with a newer Bookdelver?)`,
        )
      }
    }
    if (keys.length > allowed.length + 4) this.problem(where, `has ${keys.length} fields`)
    return value as Record<string, unknown>
  }

  /** An own property, never an inherited one. */
  field(o: Record<string, unknown>, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined
  }

  whole(value: unknown, where: string, range: { min: number; max: number }): number | undefined {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      this.problem(where, 'should be a whole number')
      return undefined
    }
    if (value < range.min || value > range.max) {
      this.problem(where, `${value} isn't between ${range.min} and ${range.max}`)
      return undefined
    }
    return value
  }

  text(value: unknown, where: string, max: number, lines = false): string | undefined {
    if (typeof value !== 'string') {
      this.problem(where, 'should be text')
      return undefined
    }
    if (value.length === 0 || value.length > max) {
      this.problem(where, `should be 1 to ${max} characters`)
      return undefined
    }
    if (value.trim() !== value) {
      this.problem(where, 'starts or ends with a space')
      return undefined
    }
    if (unsafeText(value, lines) || hasLoneSurrogate(value)) {
      this.problem(where, 'holds a character that can’t be shown')
      return undefined
    }
    return value
  }

  oneOf<T extends string>(value: unknown, where: string, options: readonly T[]): T | undefined {
    if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
      this.problem(where, `should be one of ${options.slice(0, 8).join(', ')}`)
      return undefined
    }
    return value as T
  }

  list(value: unknown, where: string, max: number): unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.problem(where, 'should be a list')
      return undefined
    }
    if (value.length > max) {
      this.problem(where, `holds ${value.length}; at most ${max}`)
      return undefined
    }
    return Array.from({ length: value.length }, (_, i) => (value as unknown[])[i])
  }

  /** A list of at most `max` of `options`, each once, or undefined (a problem said). */
  ids<T extends string>(
    value: unknown,
    where: string,
    max: number,
    options: readonly T[],
  ): T[] | undefined {
    const list = this.list(value, where, max)
    if (list === undefined) return undefined
    const out: T[] = []
    for (let i = 0; i < list.length; i++) {
      const id = this.oneOf(list[i], `${where}[${i}]`, options)
      if (id === undefined) return undefined
      if (out.includes(id)) {
        this.problem(where, `${id} twice`)
        return undefined
      }
      out.push(id)
    }
    return out
  }
}

export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1)
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return true
  }
  return false
}
