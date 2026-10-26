// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Sidequestered.
// A copy of packages/core/src/session-wire.ts in the Bookdelver repository, shared with
// this server under the MIT licence (LICENSE). Edit the original there: a test
// in that repository holds this copy to it, byte for byte below this header.

import { crc32, crcHex, fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from './codec.ts'
import { Reader, Stop } from './reader.ts'

/**
 * The session layer (docs/proposals/self-hosted-servers.md, section 2, "The
 * session layer's messages"; docs/server-protocol.md): who a phone is on a
 * server, the server's name and rules, and the tables it has. It holds no
 * game data, so its reader is small and imports nothing of the game: the
 * server and the app read it alike.
 *
 * One connection carries both layers: a message with `sv` is the session's,
 * one with `v` the table's (`relay-wire.ts`).
 */

/** The server protocol's version: `hello` settles on it, or the phone is told who must update. */
export const SERVER_PROTOCOL = 1

export const SESSION_LIMITS = {
  /** A message's JSON, in characters, read before it's parsed. */
  message: 1_000_000,
  /** A member's name on a server: as a player's at a table. */
  name: 24,
  /** A server's name and its notice. */
  serverName: 48,
  notice: 280,
  /** A member's or an invite's secret: 32 random bytes, base64url (43 characters). */
  secret: 43,
  /** A member's id: the server's, 8 characters of the share codes' alphabet. */
  id: 8,
  /** Tables a list shows. */
  tables: 50,
  /** A table's title (the scenario's) and its build. */
  title: 80,
  build: 64,
  /** An address in an invite. */
  address: 200,
} as const

/** What a member may do on a server (section 5). SH1 makes owners and members; SH2 the rest. */
export type MemberRole = 'owner' | 'moderator' | 'author' | 'member'
export const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'moderator', 'author', 'member']

/** Who joins a server: anyone with an invite, or anyone with the address. */
export type JoinPolicy = 'invite' | 'open'

/** A member, as the server tells them. */
export interface Member {
  id: string
  name: string
  role: MemberRole
}

/** A table a server lists. */
export interface TableListing {
  room: string
  title: string
  /** The host's name. */
  host: string
  /** Players sat down, and seats nobody has taken yet (a lobby's). */
  players: number
  free: number
  /** The build it admits: one a room. */
  build: string
  /** Whether it has opened (a fight under way) or is still gathering. */
  open: boolean
  /** The asker's own place at it, if they hold one: to come back to. */
  you?: number
}

/** Why a server turns a session away. */
export type SessionRefuse =
  /** Another server protocol: `want` says which, and who must update. */
  | 'version'
  /** A new member with no invite, or one that's used up, expired or revoked. */
  | 'invite'
  /** A secret this server doesn't know. */
  | 'secret'
  /** A name with a listed word, or one already taken here. */
  | 'name'
  /** Too many messages, too fast. */
  | 'slow'
  /** The message didn't read. */
  | 'garbled'
  /** The server has its most members, or its most tables. */
  | 'full'

export const SESSION_REFUSALS: readonly SessionRefuse[] = [
  'version',
  'invite',
  'secret',
  'name',
  'slow',
  'garbled',
  'full',
]

/** What a phone sends a server. */
export type ToServer = { sv: typeof SERVER_PROTOCOL } & (
  | {
      t: 'hello'
      build: string
      /** The member's secret for this server: a new one with an invite, or one it knows. */
      secret: string
      /** An invite's secret: for a new member on an invite-only server. */
      invite?: string
      /** A new member's name here. */
      name?: string
    }
  | { t: 'rename'; name: string }
  | { t: 'tables' }
  /** A room code for a new table, handed out by the server. */
  | { t: 'table' }
  /** Leaving the server: `forget`, its record and its entries deleted. */
  | { t: 'leave'; forget: boolean }
)

/** What a server sends a phone. */
export type FromServer = { sv: typeof SERVER_PROTOCOL } & (
  | {
      t: 'server'
      name: string
      notice: string
      join: JoinPolicy
      /** The owner's name: "Run by <owner> · not by Bookdelver". */
      owner: string
      you: Member
    }
  | { t: 'you'; you: Member }
  | { t: 'tables'; list: TableListing[] }
  | { t: 'room'; room: string }
  | { t: 'refuse'; reason: SessionRefuse; want?: number }
)

export type SessionResult<T> = { ok: T } | { problems: string[] }

const ID = /^[0-9A-HJKMNP-TV-Z]{8}$/
const SECRET = /^[A-Za-z0-9_-]{43}$/
const ROOM = /^[0-9A-HJKMNP-TV-Z]{6}$/

class SessionReader extends Reader {
  shape(value: unknown, where: string, allowed: readonly string[], required = allowed) {
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

  match(value: unknown, where: string, pattern: RegExp, what: string): string | undefined {
    if (typeof value !== 'string' || !pattern.test(value)) {
      this.problem(where, `should be ${what}`)
      return undefined
    }
    return value
  }

  /** Text that may be empty (a notice), else as `text` reads it. */
  maybeEmpty(value: unknown, where: string, max: number): string | undefined {
    return value === '' ? '' : this.text(value, where, max, true)
  }

  member(value: unknown, where: string): Member | undefined {
    const o = this.shape(value, where, ['id', 'name', 'role'])
    if (o === undefined) return undefined
    const id = this.match(this.field(o, 'id'), `${where}.id`, ID, 'a member’s id')
    const name = this.text(this.field(o, 'name'), `${where}.name`, SESSION_LIMITS.name)
    const role = this.oneOf(this.field(o, 'role'), `${where}.role`, MEMBER_ROLES)
    return id === undefined || name === undefined || role === undefined
      ? undefined
      : { id, name, role }
  }
}

function guarded<T>(read: (r: SessionReader) => T | undefined): SessionResult<T> {
  const r = new SessionReader()
  try {
    const out = read(r)
    if (out !== undefined && r.problems.length === 0) return { ok: out }
  } catch (error) {
    if (!(error instanceof Stop)) r.problems.push('It can’t be read')
    else r.problems.push('… and maybe more')
  }
  return { problems: r.problems.length === 0 ? ['It can’t be read'] : r.problems }
}

/** Whether a parsed message is the session layer's (`sv`), not a table's (`v`). */
export function isSession(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'sv')
  )
}

/** A message to a server from untrusted data, or its problems. Never throws. */
export function readToServer(value: unknown): SessionResult<ToServer> {
  return guarded((r) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      r.problem('', 'should be an object')
      return undefined
    }
    const raw = value as Record<string, unknown>
    if (r.field(raw, 'sv') !== SERVER_PROTOCOL) {
      r.problem('sv', `should be ${SERVER_PROTOCOL}`)
      return undefined
    }
    const t = r.oneOf(r.field(raw, 't'), 't', [
      'hello',
      'rename',
      'tables',
      'table',
      'leave',
    ] as const)
    const sv = SERVER_PROTOCOL
    switch (t) {
      case undefined:
        return undefined
      case 'hello': {
        const keys = ['sv', 't', 'build', 'secret', 'invite', 'name']
        const o = r.shape(raw, '', keys, ['sv', 't', 'build', 'secret'])
        if (o === undefined) return undefined
        const build = r.text(r.field(o, 'build'), 'build', SESSION_LIMITS.build)
        const secret = r.match(r.field(o, 'secret'), 'secret', SECRET, 'a secret')
        const invite =
          r.field(o, 'invite') === undefined
            ? undefined
            : r.match(r.field(o, 'invite'), 'invite', SECRET, 'an invite')
        const name =
          r.field(o, 'name') === undefined
            ? undefined
            : r.text(r.field(o, 'name'), 'name', SESSION_LIMITS.name)
        if (build === undefined || secret === undefined || r.problems.length > 0) return undefined
        return {
          sv,
          t,
          build,
          secret,
          ...(invite === undefined ? {} : { invite }),
          ...(name === undefined ? {} : { name }),
        }
      }
      case 'rename': {
        const o = r.shape(raw, '', ['sv', 't', 'name'])
        const name = o && r.text(r.field(o, 'name'), 'name', SESSION_LIMITS.name)
        return name === undefined ? undefined : { sv, t, name }
      }
      case 'tables':
      case 'table':
        return r.shape(raw, '', ['sv', 't']) === undefined ? undefined : { sv, t }
      case 'leave': {
        const o = r.shape(raw, '', ['sv', 't', 'forget'])
        const forget = o && r.bool(r.field(o, 'forget'), 'forget')
        return forget === undefined ? undefined : { sv, t, forget }
      }
    }
  })
}

/** A message from a server from untrusted data, or its problems. Never throws. */
export function readFromServer(value: unknown): SessionResult<FromServer> {
  return guarded((r) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      r.problem('', 'should be an object')
      return undefined
    }
    const raw = value as Record<string, unknown>
    if (r.field(raw, 'sv') !== SERVER_PROTOCOL) {
      r.problem('sv', `should be ${SERVER_PROTOCOL}`)
      return undefined
    }
    const t = r.oneOf(r.field(raw, 't'), 't', [
      'server',
      'you',
      'tables',
      'room',
      'refuse',
    ] as const)
    const sv = SERVER_PROTOCOL
    switch (t) {
      case undefined:
        return undefined
      case 'server': {
        const o = r.shape(raw, '', ['sv', 't', 'name', 'notice', 'join', 'owner', 'you'])
        if (o === undefined) return undefined
        const name = r.text(r.field(o, 'name'), 'name', SESSION_LIMITS.serverName)
        const notice = r.maybeEmpty(r.field(o, 'notice'), 'notice', SESSION_LIMITS.notice)
        const join = r.oneOf(r.field(o, 'join'), 'join', ['invite', 'open'] as const)
        const owner = r.text(r.field(o, 'owner'), 'owner', SESSION_LIMITS.name)
        const you = r.member(r.field(o, 'you'), 'you')
        return name === undefined ||
          notice === undefined ||
          join === undefined ||
          owner === undefined ||
          you === undefined
          ? undefined
          : { sv, t, name, notice, join, owner, you }
      }
      case 'you': {
        const o = r.shape(raw, '', ['sv', 't', 'you'])
        const you = o && r.member(r.field(o, 'you'), 'you')
        return you === undefined ? undefined : { sv, t, you }
      }
      case 'tables': {
        const o = r.shape(raw, '', ['sv', 't', 'list'])
        const list = o && r.list(r.field(o, 'list'), 'list', SESSION_LIMITS.tables)
        if (list === undefined) return undefined
        const out: TableListing[] = []
        for (let i = 0; i < list.length; i++) {
          const w = `list[${i}]`
          const keys = ['room', 'title', 'host', 'players', 'free', 'build', 'open']
          const e = r.shape(list[i], w, [...keys, 'you'], keys)
          if (e === undefined) return undefined
          const room = r.match(r.field(e, 'room'), `${w}.room`, ROOM, 'a room code')
          const title = r.text(r.field(e, 'title'), `${w}.title`, SESSION_LIMITS.title)
          const host = r.text(r.field(e, 'host'), `${w}.host`, SESSION_LIMITS.name)
          const players = r.whole(r.field(e, 'players'), `${w}.players`, { min: 0, max: 6 })
          const free = r.whole(r.field(e, 'free'), `${w}.free`, { min: 0, max: 6 })
          const build = r.text(r.field(e, 'build'), `${w}.build`, SESSION_LIMITS.build)
          const open = r.bool(r.field(e, 'open'), `${w}.open`)
          if (
            room === undefined ||
            title === undefined ||
            host === undefined ||
            players === undefined ||
            free === undefined ||
            build === undefined ||
            open === undefined
          ) {
            return undefined
          }
          const you =
            r.field(e, 'you') === undefined
              ? undefined
              : r.whole(r.field(e, 'you'), `${w}.you`, { min: 0, max: 5 })
          if (r.problems.length > 0) return undefined
          out.push({
            room,
            title,
            host,
            players,
            free,
            build,
            open,
            ...(you === undefined ? {} : { you }),
          })
        }
        return { sv, t, list: out }
      }
      case 'room': {
        const o = r.shape(raw, '', ['sv', 't', 'room'])
        const room = o && r.match(r.field(o, 'room'), 'room', ROOM, 'a room code')
        return room === undefined ? undefined : { sv, t, room }
      }
      case 'refuse': {
        const o = r.shape(raw, '', ['sv', 't', 'reason', 'want'], ['sv', 't', 'reason'])
        if (o === undefined) return undefined
        const reason = r.oneOf(r.field(o, 'reason'), 'reason', SESSION_REFUSALS)
        const want =
          r.field(o, 'want') === undefined
            ? undefined
            : r.whole(r.field(o, 'want'), 'want', { min: 1, max: 1_000 })
        if (reason === undefined || r.problems.length > 0) return undefined
        return { sv, t, reason, ...(want === undefined ? {} : { want }) }
      }
    }
  })
}

// ---------------------------------------------------------------------------
// The invite: `bdinv1.<crc32>.<base64url of { address, invite, name }>`

/** What an invite holds: where the server is, the invite's secret, the server's name. */
export interface Invite {
  /** `wss://…`; `ws://` only to this machine (`localhost`, `127.0.0.1`), for trying a server out. */
  address: string
  invite: string
  name: string
}

export const INVITE_PREFIX = 'bdinv1.'
const NOT_AN_INVITE = "That isn't a Bookdelver invite."
const DAMAGED = 'That invite is cut short or damaged. Copy all of it again.'

/** Whether `address` is one a phone may connect to: `wss://`, or `ws://` to this machine. */
export function addressProblem(address: string): string | undefined {
  if (address.length > SESSION_LIMITS.address) return 'That address is too long.'
  // A scheme, a host (a name, an IPv4 address or [::1]), a port, a path: nothing else.
  const m = /^(wss?):\/\/([a-z0-9.-]+|\[::1\])(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/i.exec(address)
  if (m === null) return 'That isn’t a server’s address.'
  const [, scheme, host] = m as unknown as [string, string, string]
  if (scheme.toLowerCase() === 'wss') return undefined
  if (['localhost', '127.0.0.1', '[::1]'].includes(host.toLowerCase())) return undefined
  return 'This server needs a secure address (wss://)'
}

/** An invite as a code to send. */
export function encodeInvite(invite: Invite): string {
  const bytes = utf8Encode(JSON.stringify(invite))
  return `${INVITE_PREFIX}${crcHex(crc32(bytes))}.${toBase64Url(bytes)}`
}

/** An invite out of pasted text, read strictly. Never throws. */
export function decodeInvite(text: string): SessionResult<Invite> {
  if (typeof text !== 'string') return { problems: [NOT_AN_INVITE] }
  const compact = text.replace(/\s+/g, '')
  if (compact.length > 1_000) return { problems: ['That invite is too long.'] }
  const match = /^bdinv1\.([0-9a-f]{8})\.([A-Za-z0-9_-]+)$/.exec(compact)
  if (match === null) {
    return { problems: [compact.startsWith('bdinv') ? DAMAGED : NOT_AN_INVITE] }
  }
  const bytes = fromBase64Url(match[2]!)
  if (bytes === undefined || crcHex(crc32(bytes)) !== match[1]) return { problems: [DAMAGED] }
  const json = utf8Decode(bytes)
  let value: unknown
  try {
    value = json === undefined ? undefined : JSON.parse(json)
  } catch {
    return { problems: [DAMAGED] }
  }
  return guarded((r) => {
    const o = r.shape(value, '', ['address', 'invite', 'name'])
    if (o === undefined) return undefined
    const address = r.text(r.field(o, 'address'), 'address', SESSION_LIMITS.address)
    const invite = r.match(r.field(o, 'invite'), 'invite', SECRET, 'an invite')
    const name = r.text(r.field(o, 'name'), 'name', SESSION_LIMITS.serverName)
    if (address === undefined || invite === undefined || name === undefined) return undefined
    const problem = addressProblem(address)
    if (problem !== undefined) {
      r.problem('address', problem)
      return undefined
    }
    return { address, invite, name }
  })
}
