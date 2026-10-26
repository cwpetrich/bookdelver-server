// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Sidequestered.
// A copy of packages/core/src/relay-wire.ts in the Bookdelver repository, shared with
// this server under the MIT licence (LICENSE). Edit the original there: a test
// in that repository holds this copy to it, byte for byte below this header.

import { Reader, Stop } from './reader.ts'

/**
 * The table layer's envelope (docs/proposals/self-hosted-servers.md, section
 * 2, "From DM9's relay to the protocol"; docs/server-protocol.md): what a
 * relay reads of a lockstep message, and nothing more. A relay, the one in
 * a host's tab or a server anyone may run, reads the message's kind, the
 * room, the build, the players and the sequence numbers. The payloads (a
 * room's setup, a proposal's input) it carries as opaque JSON values,
 * measured (size, depth) and never interpreted: every phone reads them
 * strictly (`readToPhone`, in `lockstep-wire.ts`). So a relay needs no rules
 * code, and an old server never refuses a newer build's moves.
 *
 * This module imports nothing of the game: the server runs it as it is.
 */

/** The lockstep protocol's version: a message of another is refused ("update the app"). */
export const LOCKSTEP_PROTOCOL = 2

/** The caps on a message. */
export const WIRE_LIMITS = {
  /** A message's JSON, in characters: a welcome with a whole fight's log fits easily. */
  message: 1_000_000,
  /** Entries in a room's log, and in one welcome or sync: a fight is a few hundred decisions. */
  log: 5_000,
  /** The build's text ("0.1.0+201c9a8"). */
  build: 64,
  /** Players at a table: the seats, and a DM beside them. */
  players: 6,
  playerName: 24,
  /** A table's seats: a party's most (`BATTLE_PARTY_MAX`, held equal by a test). */
  seats: 3,
  /** A creature's index in a fight, and a hex's. */
  combatant: 63,
  cell: 4_095,
  /** A walk's hexes. */
  path: 64,
  /** The creatures, conditions or Metamagic options one action names. */
  many: 16,
  /** A feature's id (an art's, a rider's). */
  id: 48,
  /** A play of a scenario. */
  play: 1_000_000,
  /** A lobby's title (the scenario's), and a seat's name (its hero's). */
  title: 80,
  seatName: 40,
  /** How deep an opaque payload may nest. */
  depth: 16,
} as const

/** A room's code: six characters of the share codes' alphabet (`seed.ts`), read aloud easily. */
export const ROOM_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const ROOM_LENGTH = 6

/** Whether `text` is a room code. */
export function isRoomCode(text: string): boolean {
  return text.length === ROOM_LENGTH && [...text].every((c) => ROOM_ALPHABET.includes(c))
}

/** What every message carries. */
export interface Envelope {
  v: typeof LOCKSTEP_PROTOCOL
  build: string
  room: string
}

/**
 * A table being gathered, before it opens (docs/proposals/self-hosted-servers.md,
 * slice SH0, "a lobby"): what it plays, who has sat down, who plays which
 * seat, and whether the host sits as the Author. The host keeps it; the
 * relay keeps who sat (each by their name), and passes it to everyone.
 * Nothing in it tells of the fight beyond the scenario's title and its
 * heroes' names: no monster, hidden or seen.
 */
export interface Lobby {
  /** The scenario's title. */
  title: string
  /** The seats, in seat order, by their heroes' names. */
  seats: string[]
  /** The players by name, in the order they sat: the host first. */
  players: string[]
  /** Who plays each seat: a player's index, or -1 for the AI. */
  claims: number[]
  /**
   * The host sits as the Author: they play no seat, and play the monsters
   * they take in the fight (DM10). Otherwise the host is a player too.
   */
  author: boolean
}

/** Why the relay turns a phone away. */
export type RefuseReason =
  /** Another build than the room's: whoever is behind must update. */
  | 'build'
  /** Another protocol than the relay's. */
  | 'protocol'
  /** No such room open yet. */
  | 'no-room'
  /** The room is open already (a second `open`). */
  | 'open'
  /** That player's place is taken by a phone still here, or by another person. */
  | 'taken'
  /** No such player at this table. */
  | 'player'
  /** The room's log is full. */
  | 'full'
  /** The message didn't read. */
  | 'garbled'
  /** The table being gathered has its most players. */
  | 'crowd'
  /** That name is taken at this table, or that seat by another player. */
  | 'name'
  /** Too many messages, too fast (a server's rate limit). */
  | 'slow'
  /** The room is closed: its host closed it, or it lay idle too long. */
  | 'closed'
  /** Kicked from this table by the server's host or a moderator. */
  | 'kicked'

export const REFUSE_REASONS: readonly RefuseReason[] = [
  'build',
  'protocol',
  'no-room',
  'open',
  'taken',
  'player',
  'full',
  'garbled',
  'crowd',
  'name',
  'slow',
  'closed',
  'kicked',
]

export type WireResult<T> = { ok: T } | { problems: string[] }

/** A payload a relay carries and never reads: a room's setup, a proposal's input. */
export type Opaque = unknown

/** An input in the order the relay gave it, as a relay holds it: its input unread. */
export interface RelayEntry {
  seq: number
  from: number
  input: Opaque
}

/**
 * A message to a relay, as a relay reads it: its envelope, and its payloads
 * opaque. An `open`'s setup is read only for its players (by name) and its
 * host, which the relay seats.
 */
export type RelayIn = Envelope &
  (
    | { t: 'gather'; lobby: Lobby }
    | { t: 'sit'; name: string }
    | { t: 'claim'; seat: number; take: boolean }
    | { t: 'open'; setup: Opaque; players: string[]; host: number }
    | { t: 'join'; player: number; have: number }
    | { t: 'propose'; input: Opaque }
    | { t: 'print'; seq: number; fp: string }
    | { t: 'want'; from: number }
    | { t: 'bye' }
  )

/** A message from a relay, its payloads as they came. A phone reads it strictly (`readToPhone`). */
export type RelayOut = Envelope &
  (
    | { t: 'lobby'; lobby: Lobby; you: number }
    | {
        t: 'welcome'
        player: number
        setup: Opaque
        from: number
        log: RelayEntry[]
        present: boolean[]
      }
    | { t: 'sync'; setup: Opaque; from: number; log: RelayEntry[] }
    | { t: 'entry'; entry: RelayEntry }
    | { t: 'print'; player: number; seq: number; fp: string }
    | { t: 'presence'; present: boolean[] }
    | { t: 'refuse'; reason: RefuseReason; want: string }
  )

/** A reader with the envelope's own reads. */
export class EnvelopeReader extends Reader {
  /** An object of exactly `allowed`'s keys, those in `required` there. */
  shape(
    value: unknown,
    where: string,
    allowed: readonly string[],
    required: readonly string[] = allowed,
  ): Record<string, unknown> | undefined {
    const o = this.object(value, where, allowed)
    if (o === undefined) return undefined
    for (const key of required) {
      if (this.field(o, key) === undefined) {
        this.problem(where, `"${key}" is missing`)
        return undefined
      }
    }
    return o
  }

  bool(value: unknown, where: string): boolean | undefined {
    if (typeof value !== 'boolean') {
      this.problem(where, 'should be true or false')
      return undefined
    }
    return value
  }

  /** Eight hexadecimal digits: a fingerprint or a hash. */
  print(value: unknown, where: string): string | undefined {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}$/.test(value)) {
      this.problem(where, 'should be 8 hexadecimal digits')
      return undefined
    }
    return value
  }

  /**
   * An opaque payload: any JSON value (plain objects, lists, text, finite
   * numbers, true, false, null) nested at most `WIRE_LIMITS.depth` deep, no
   * prototype key anywhere; a fresh copy, never the input. Its size is the
   * message's cap, held before it was parsed.
   */
  opaque(value: unknown, where: string, depth = 0): Opaque {
    if (depth > WIRE_LIMITS.depth) {
      this.problem(where, `nests deeper than ${WIRE_LIMITS.depth}`)
      return undefined
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
    if (typeof value === 'number') {
      if (Number.isFinite(value)) return value
      this.problem(where, 'should be a finite number')
      return undefined
    }
    if (Array.isArray(value)) {
      const out: unknown[] = []
      for (let i = 0; i < value.length; i++) {
        const v = this.opaque((value as unknown[])[i], `${where}[${i}]`, depth + 1)
        if (this.problems.length > 0) return undefined
        out.push(v)
      }
      return out
    }
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          this.problem(where, `holds a key "${key}"`)
          return undefined
        }
        const v = this.opaque((value as Record<string, unknown>)[key], `${where}.${key}`, depth + 1)
        if (this.problems.length > 0) return undefined
        out[key] = v
      }
      return out
    }
    this.problem(where, 'should be JSON')
    return undefined
  }
}

/** A lobby from untrusted data: its names as a scenario's names are, its claims in range. */
export function readLobby(r: EnvelopeReader, value: unknown, where: string): Lobby | undefined {
  const o = r.shape(value, where, ['title', 'seats', 'players', 'claims', 'author'])
  if (o === undefined) return undefined
  const title = r.text(r.field(o, 'title'), `${where}.title`, WIRE_LIMITS.title)
  const author = r.bool(r.field(o, 'author'), `${where}.author`)
  const seatList = r.list(r.field(o, 'seats'), `${where}.seats`, WIRE_LIMITS.seats)
  const playerList = r.list(r.field(o, 'players'), `${where}.players`, WIRE_LIMITS.players)
  const claimList = r.list(r.field(o, 'claims'), `${where}.claims`, WIRE_LIMITS.seats)
  if (title === undefined || author === undefined) return undefined
  if (seatList === undefined || playerList === undefined || claimList === undefined) {
    return undefined
  }
  if (seatList.length === 0 || playerList.length === 0) {
    r.problem(where, 'should hold a seat and a player at least')
    return undefined
  }
  const seats: string[] = []
  for (let i = 0; i < seatList.length; i++) {
    const name = r.text(seatList[i], `${where}.seats[${i}]`, WIRE_LIMITS.seatName)
    if (name === undefined) return undefined
    seats.push(name)
  }
  const players = readNames(r, playerList, `${where}.players`)
  if (players === undefined) return undefined
  if (claimList.length !== seats.length) {
    r.problem(`${where}.claims`, `should hold one for each of the ${seats.length} seats`)
    return undefined
  }
  const claims: number[] = []
  for (let i = 0; i < claimList.length; i++) {
    const c = r.whole(claimList[i], `${where}.claims[${i}]`, { min: -1, max: players.length - 1 })
    if (c === undefined) return undefined
    claims.push(c)
  }
  return { title, seats, players, claims, author }
}

/** Players' names, each as a scenario's names are read. */
export function readNames(r: Reader, list: unknown[], where: string): string[] | undefined {
  const names: string[] = []
  for (let i = 0; i < list.length; i++) {
    const name = r.text(list[i], `${where}[${i}]`, WIRE_LIMITS.playerName)
    if (name === undefined) return undefined
    names.push(name)
  }
  return names
}

export function readPresent(
  r: EnvelopeReader,
  value: unknown,
  where: string,
): boolean[] | undefined {
  const list = r.list(value, where, WIRE_LIMITS.players)
  if (list === undefined) return undefined
  const out: boolean[] = []
  for (let i = 0; i < list.length; i++) {
    const b = r.bool(list[i], `${where}[${i}]`)
    if (b === undefined) return undefined
    out.push(b)
  }
  return out
}

/** The envelope's `v`, `build` and `room`, and the message's type among `types`. */
export function readEnvelope<T extends string>(
  r: EnvelopeReader,
  value: unknown,
  types: readonly T[],
): { o: Record<string, unknown>; env: Envelope; t: T } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    r.problem('', 'should be an object')
    return undefined
  }
  const raw = value as Record<string, unknown>
  if (r.field(raw, 'v') !== LOCKSTEP_PROTOCOL) {
    r.problem('v', `should be ${LOCKSTEP_PROTOCOL}: another version of the app`)
    return undefined
  }
  const build = r.text(r.field(raw, 'build'), 'build', WIRE_LIMITS.build)
  const room = r.field(raw, 'room')
  if (typeof room !== 'string' || !isRoomCode(room)) r.problem('room', 'should be a room code')
  const t = r.oneOf(r.field(raw, 't'), 't', types)
  if (build === undefined || t === undefined || r.problems.length > 0) return undefined
  return { o: raw, env: { v: LOCKSTEP_PROTOCOL, build, room: room as string }, t }
}

export const ENVELOPE = ['v', 'build', 'room', 't'] as const

/** A message's problems, past a stop or a throw: never throws. */
export function guarded<T, R extends Reader>(
  make: () => R,
  read: (r: R) => T | undefined,
): WireResult<T> {
  const r = make()
  try {
    const out = read(r)
    if (out !== undefined && r.problems.length === 0) return { ok: out }
  } catch (error) {
    if (!(error instanceof Stop)) r.problems.push('It can’t be read')
    else r.problems.push('… and maybe more')
  }
  return { problems: r.problems.length === 0 ? ['It can’t be read'] : r.problems }
}

/**
 * A message to a relay from untrusted data, as a relay reads it: the
 * envelope, the counts and names a relay needs, the payloads opaque. Never
 * throws. A phone's own messages are read whole elsewhere (`readToRelay`).
 */
export function readRelayIn(value: unknown): WireResult<RelayIn> {
  return guarded(
    () => new EnvelopeReader(),
    (r) => {
      const e = readEnvelope(r, value, [
        'gather',
        'sit',
        'claim',
        'open',
        'join',
        'propose',
        'print',
        'want',
        'bye',
      ] as const)
      if (e === undefined) return undefined
      const { o, env, t } = e
      switch (t) {
        case 'gather': {
          if (r.shape(o, '', [...ENVELOPE, 'lobby']) === undefined) return undefined
          const lobby = readLobby(r, r.field(o, 'lobby'), 'lobby')
          return lobby === undefined ? undefined : { ...env, t, lobby }
        }
        case 'sit': {
          if (r.shape(o, '', [...ENVELOPE, 'name']) === undefined) return undefined
          const name = r.text(r.field(o, 'name'), 'name', WIRE_LIMITS.playerName)
          return name === undefined ? undefined : { ...env, t, name }
        }
        case 'claim': {
          if (r.shape(o, '', [...ENVELOPE, 'seat', 'take']) === undefined) return undefined
          const seat = r.whole(r.field(o, 'seat'), 'seat', { min: 0, max: WIRE_LIMITS.seats - 1 })
          const take = r.bool(r.field(o, 'take'), 'take')
          return seat === undefined || take === undefined ? undefined : { ...env, t, seat, take }
        }
        case 'open': {
          if (r.shape(o, '', [...ENVELOPE, 'setup']) === undefined) return undefined
          const raw = r.field(o, 'setup')
          // The players and the host: what the relay seats. The rest it carries unread.
          if (
            typeof raw !== 'object' ||
            raw === null ||
            Array.isArray(raw) ||
            Object.getPrototypeOf(raw) !== Object.prototype
          ) {
            r.problem('setup', 'should be an object')
            return undefined
          }
          const shell = raw as Record<string, unknown>
          const list = r.list(r.field(shell, 'players'), 'setup.players', WIRE_LIMITS.players)
          if (list === undefined) return undefined
          if (list.length === 0) {
            r.problem('setup.players', 'should hold a player at least')
            return undefined
          }
          const players = readNames(r, list, 'setup.players')
          if (players === undefined) return undefined
          const host = r.whole(r.field(shell, 'host'), 'setup.host', {
            min: 0,
            max: players.length - 1,
          })
          const setup = r.opaque(raw, 'setup')
          return host === undefined || r.problems.length > 0
            ? undefined
            : { ...env, t, setup, players, host }
        }
        case 'join': {
          if (r.shape(o, '', [...ENVELOPE, 'player', 'have']) === undefined) return undefined
          const player = r.whole(r.field(o, 'player'), 'player', {
            min: 0,
            max: WIRE_LIMITS.players - 1,
          })
          const have = r.whole(r.field(o, 'have'), 'have', { min: 0, max: WIRE_LIMITS.log })
          return player === undefined || have === undefined
            ? undefined
            : { ...env, t, player, have }
        }
        case 'propose': {
          if (r.shape(o, '', [...ENVELOPE, 'input']) === undefined) return undefined
          const input = r.opaque(r.field(o, 'input'), 'input')
          return r.problems.length > 0 ? undefined : { ...env, t, input }
        }
        case 'print': {
          if (r.shape(o, '', [...ENVELOPE, 'seq', 'fp']) === undefined) return undefined
          const seq = r.whole(r.field(o, 'seq'), 'seq', { min: 0, max: WIRE_LIMITS.log - 1 })
          const fp = r.print(r.field(o, 'fp'), 'fp')
          return seq === undefined || fp === undefined ? undefined : { ...env, t, seq, fp }
        }
        case 'want': {
          if (r.shape(o, '', [...ENVELOPE, 'from']) === undefined) return undefined
          const from = r.whole(r.field(o, 'from'), 'from', { min: 0, max: WIRE_LIMITS.log })
          return from === undefined ? undefined : { ...env, t, from }
        }
        case 'bye':
          return r.shape(o, '', ENVELOPE) === undefined ? undefined : { ...env, t }
      }
    },
  )
}

/** A message as text on the wire. */
export function wireText(message: object): string {
  return JSON.stringify(message)
}

/**
 * A message's text parsed, size first (`WIRE_LIMITS.message`), then strict
 * JSON, then the reader for its direction. Never throws.
 */
export function parseWire<T>(
  text: unknown,
  read: (value: unknown) => WireResult<T>,
): WireResult<T> {
  if (typeof text !== 'string') return { problems: ['should be text'] }
  if (text.length > WIRE_LIMITS.message) return { problems: ['too long'] }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { problems: ['isn’t JSON'] }
  }
  return read(value)
}
