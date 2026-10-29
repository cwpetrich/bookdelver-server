// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Sidequestered.
// A copy of packages/core/src/library-wire.ts in the Bookdelver repository, shared with
// this server under the MIT licence (LICENSE). Edit the original there: a test
// in that repository holds this copy to it, byte for byte below this header.

import { crc32, crcHex, fromBase64Url, utf8Decode } from './codec.ts'

/**
 * A code as a server's library reads it (docs/proposals/self-hosted-servers.md,
 * section 3, "Publishing"; slice SH3): its envelope and its listing, never
 * the whole. A server checks a known prefix (`bdsc`, a scenario; `bdhb`, a
 * homebrew piece), the CRC-32, base64url that decodes, the size caps, and
 * reads the listing's fields tolerantly as capped text. It doesn't run the
 * full reader, so an old server never refuses a newer build's scenario: the
 * app reads the whole code strictly when it's previewed or kept, exactly as
 * a pasted code is read (`decodeHomebrewScenario`, `decodeHomebrew`).
 *
 * This module imports nothing of the game: the server runs it as it is.
 */

export const LIBRARY_LIMITS = {
  /** A scenario's code, in characters, and its JSON's bytes (`SCENARIO_LIMITS`). */
  scenarioCode: 16_384,
  scenarioJson: 65_536,
  /** A homebrew piece's code, in characters, and its JSON's bytes with what it carries (`PIECE_LIMITS`). */
  pieceCode: 24_000,
  pieceJson: 16_384,
  /** Entries a page lists. */
  page: 50,
  /** Versions kept of each entry, entries a server keeps, and a member's own. */
  versions: 10,
  entries: 500,
  mine: 50,
  /** Publishing a member may do in an hour. */
  perHour: 10,
  /** The listing's fields, as a library shows them. */
  title: 40,
  intro: 400,
  author: 24,
  /** A title search. */
  query: 40,
} as const

export type LibraryKind = 'scenario' | 'piece'

/** What a library reads of a code: its kind, its content's id, and what its listing shows. */
export interface CodeListing {
  kind: LibraryKind
  /** The content's id: the code's CRC-32 and its body's length. The same code twice is one version. */
  content: string
  /** A scenario's title, a piece's name. */
  title: string
  /** A scenario's intro, a piece's flavour; empty when it has none. */
  intro: string
  /** Its author as the code names them; empty when none. */
  author: string
  /** A piece's kind (`item`, `feat`, …); a scenario's is `scenario`. */
  sort: string
  /** A scenario's board and seats, for its row. */
  cols?: number
  rows?: number
  seats?: number
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g

/** Text from a code's field: trimmed, cut to `max`, or empty. Tolerant: a listing never refuses a code. */
function field(o: Record<string, unknown>, key: string, max: number): string {
  if (!Object.prototype.hasOwnProperty.call(o, key)) return ''
  const v = o[key]
  if (typeof v !== 'string') return ''
  // No control characters in a listing: they're dropped.
  return v.replace(CONTROL, ' ').trim().slice(0, max).trim()
}

/** A whole number field in range, or undefined. */
function count(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined
}

/** A code's envelope and listing, or why a library won't take it. Never throws. */
export function readCodeListing(text: unknown): { ok: CodeListing } | { problems: string[] } {
  if (typeof text !== 'string') return { problems: ['should be a code'] }
  const match = /^(bdsc|bdhb)(\d{1,4})\.([0-9a-f]{8})\.([A-Za-z0-9_-]+)$/.exec(text)
  if (match === null) return { problems: ['should be a scenario’s or a homebrew piece’s code'] }
  const [, prefix, , checksum, body] = match as unknown as [string, string, string, string, string]
  const kind: LibraryKind = prefix === 'bdsc' ? 'scenario' : 'piece'
  const caps =
    kind === 'scenario'
      ? { code: LIBRARY_LIMITS.scenarioCode, json: LIBRARY_LIMITS.scenarioJson }
      : { code: LIBRARY_LIMITS.pieceCode, json: LIBRARY_LIMITS.pieceJson }
  if (text.length > caps.code) return { problems: ['too long'] }
  const bytes = fromBase64Url(body)
  if (bytes === undefined || bytes.length > caps.json) return { problems: ['damaged, or too long'] }
  if (crcHex(crc32(bytes)) !== checksum) return { problems: ['damaged: its checksum differs'] }
  const json = utf8Decode(bytes)
  let value: unknown
  try {
    value = json === undefined ? undefined : JSON.parse(json)
  } catch {
    value = undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { problems: ['damaged: its JSON doesn’t read'] }
  }
  const o = value as Record<string, unknown>
  const content = `${checksum}-${bytes.length.toString(36)}`
  if (kind === 'scenario') {
    const title = field(o, 'title', LIBRARY_LIMITS.title)
    if (title === '') return { problems: ['a scenario needs a title'] }
    const board = o.board as Record<string, unknown> | undefined
    const party = o.party as { size?: Record<string, unknown> } | undefined
    const cols = typeof board === 'object' && board !== null ? count(board.cols, 1, 99) : undefined
    const rows = typeof board === 'object' && board !== null ? count(board.rows, 1, 99) : undefined
    const seats =
      typeof party === 'object' && party !== null && typeof party.size === 'object'
        ? count(party.size?.max, 1, 9)
        : undefined
    return {
      ok: {
        kind,
        content,
        title,
        intro: field(o, 'intro', LIBRARY_LIMITS.intro),
        author: field(o, 'author', LIBRARY_LIMITS.author),
        sort: 'scenario',
        ...(cols === undefined ? {} : { cols }),
        ...(rows === undefined ? {} : { rows }),
        ...(seats === undefined ? {} : { seats }),
      },
    }
  }
  const title = field(o, 'name', LIBRARY_LIMITS.title)
  if (title === '') return { problems: ['a piece needs a name'] }
  const sort = field(o, 'kind', 20)
  return {
    ok: {
      kind,
      content,
      title,
      intro: field(o, 'flavour', LIBRARY_LIMITS.intro),
      author: field(o, 'author', LIBRARY_LIMITS.author),
      sort: /^[a-z-]{1,20}$/.test(sort) ? sort : 'piece',
    },
  }
}
