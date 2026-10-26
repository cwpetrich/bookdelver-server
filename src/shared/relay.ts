// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Sidequestered.
// A copy of packages/core/src/relay.ts in the Bookdelver repository, shared with
// this server under the MIT licence (LICENSE). Edit the original there: a test
// in that repository holds this copy to it, byte for byte below this header.

import {
  type Envelope,
  type Lobby,
  LOCKSTEP_PROTOCOL,
  type Opaque,
  type RefuseReason,
  type RelayEntry,
  type RelayIn,
  type RelayOut,
  WIRE_LIMITS,
  readRelayIn,
} from './relay-wire.ts'

/**
 * A table's relay (docs/proposals/dm-scenarios.md, slice DM9;
 * docs/proposals/self-hosted-servers.md, section 2): rooms, order,
 * forwarding, the log. Pure: messages in, messages out, no clock and no
 * network. It runs in a host's tab (`TabRoom`) and on a server
 * (`packages/server`), the same code, and imports nothing of the game, only
 * the envelope (`relay-wire.ts`).
 */

/** A message for one connection. */
export interface Send {
  to: string
  message: RelayOut
}

/**
 * The relay: it opens a room for its host, admits one build (the host's),
 * gives each input its place in order (`seq`) and passes it to every phone,
 * the sender too, passes fingerprints on, keeps the whole log for phones that
 * come back, and says who is here. It never reads the fight: who may send
 * what is every phone's to check, alike (`applyAt`). Since lockstep protocol
 * 2 it reads only the envelope (`readRelayIn`): the payloads, a setup and
 * each input, it carries unread.
 *
 * On a server, each connection is a member who said who they are (`hello`):
 * `receive`'s `member`. Then a player's place belongs to that person, who
 * may come back to it on another phone and nobody else may take it. In a
 * host's tab (no members) a place is free to any phone once its own has gone.
 */
export class Relay {
  readonly room: string
  /** The room's build: the host's, once it opens. */
  build: string | undefined
  /** The room's setup, as the host sent it: unread but for its players and host. */
  setup: Opaque | undefined
  /** The players by name, and the host's index, as the setup says. */
  players: string[] = []
  host = 0
  readonly log: RelayEntry[] = []
  /** The connection playing each player, by player index. */
  private seats: (string | undefined)[] = []
  /** The member (a server's) each player's place belongs to, once one has taken it. */
  private owners: (string | undefined)[] = []
  /**
   * The table being gathered before it opens (SH0's lobby), and who sat, by
   * connection, in the order they sat: the host first. Both gone once the
   * room opens, everyone who sat then seated as their player.
   */
  lobby: Lobby | undefined
  private sitters: string[] = []
  /** Each sitter's member, by the same index. */
  private sitterOwners: (string | undefined)[] = []
  /** Why the relay turned something down, for its log: the last few. */
  readonly turnedDown: { conn: string; why: string }[] = []

  constructor(room: string) {
    this.room = room
  }

  /**
   * A room opened before, opened again with its setup and its log, nobody in
   * it yet (SH0, the host's own drop): the host's tab back after it closed,
   * its relay restored from what it kept. Each phone that comes back says
   * what it holds (`join`) and gets the rest.
   */
  static resume(
    room: string,
    build: string,
    setup: { players: readonly string[]; host: number },
    log: readonly RelayEntry[],
    owners: readonly (string | undefined)[] = [],
  ): Relay {
    const relay = new Relay(room)
    relay.build = build
    relay.setup = setup
    relay.players = [...setup.players]
    relay.host = setup.host
    relay.log.push(...log.map((e, seq) => ({ ...e, seq })))
    relay.seats = setup.players.map(() => undefined)
    relay.owners = setup.players.map((_, p) => owners[p])
    return relay
  }

  /** Whose each player's place is (a server's members), by player: to keep across a restart. */
  placesOwned(): (string | undefined)[] {
    return this.players.map((_, p) => this.owners[p])
  }

  private envelope(): Envelope {
    // Before a room opens it has no build: '-', so even a refusal then reads (a build is never empty).
    return { v: LOCKSTEP_PROTOCOL, build: this.build ?? '-', room: this.room }
  }

  private refuse(conn: string, reason: RefuseReason, why: string = reason): Send[] {
    this.note(conn, why)
    return [
      { to: conn, message: { ...this.envelope(), t: 'refuse', reason, want: this.build ?? '-' } },
    ]
  }

  private note(conn: string, why: string) {
    this.turnedDown.push({ conn, why })
    if (this.turnedDown.length > 50) this.turnedDown.shift()
  }

  /** Which players have a phone here. */
  present(): boolean[] {
    return this.players.map((_, p) => this.seats[p] !== undefined)
  }

  private toAll(message: RelayOut): Send[] {
    return this.seats.flatMap((conn) => (conn === undefined ? [] : [{ to: conn, message }]))
  }

  private presence(): Send[] {
    return this.toAll({ ...this.envelope(), t: 'presence', present: this.present() })
  }

  /** The player connection `conn` plays, if it's joined. */
  playerOf(conn: string): number | undefined {
    const p = this.seats.indexOf(conn)
    return p < 0 ? undefined : p
  }

  /**
   * A message from connection `conn` (untrusted): what to send, and to whom.
   * `member`: who the connection is, on a server (a seat is theirs).
   */
  receive(conn: string, value: unknown, member?: string): Send[] {
    const read = readRelayIn(value)
    if (!('ok' in read)) {
      const v =
        typeof value === 'object' && value !== null ? (value as { v?: unknown }).v : undefined
      return this.refuse(conn, v !== LOCKSTEP_PROTOCOL ? 'protocol' : 'garbled', read.problems[0])
    }
    const m = read.ok
    if (m.room !== this.room) return this.refuse(conn, 'no-room')
    if (m.t === 'gather' || m.t === 'sit' || m.t === 'claim') {
      if (this.setup !== undefined) return this.refuse(conn, 'open')
      return this.gathering(conn, m, member)
    }
    if (m.t === 'open') {
      if (this.setup !== undefined) return this.refuse(conn, 'open')
      if (this.lobby !== undefined) {
        // A gathered table opens with everyone who sat, each as their player, the host first.
        if (conn !== this.sitters[0]) return this.refuse(conn, 'open')
        if (m.build !== this.build) return this.refuse(conn, 'build')
        if (m.host !== 0 || m.players.length !== this.sitters.length) {
          return this.refuse(conn, 'player')
        }
        this.setup = m.setup
        this.players = m.players
        this.host = m.host
        this.seats = [...this.sitters]
        this.owners = [...this.sitterOwners]
        this.lobby = undefined
        this.sitters = []
        this.sitterOwners = []
        return [...this.seats.map((c, p) => this.welcome(c!, p, 0)), ...this.presence()]
      }
      this.build = m.build
      this.setup = m.setup
      this.players = m.players
      this.host = m.host
      this.seats = m.players.map((_, p) => (p === m.host ? conn : undefined))
      this.owners = m.players.map((_, p) => (p === m.host ? member : undefined))
      return [this.welcome(conn, m.host, 0), ...this.presence()]
    }
    if (m.t === 'bye' && this.setup === undefined && this.sitters.includes(conn)) {
      return this.leave(conn)
    }
    if (this.setup === undefined) return this.refuse(conn, 'no-room')
    if (m.build !== this.build) return this.refuse(conn, 'build')
    if (m.t === 'join') {
      if (m.player >= this.players.length) return this.refuse(conn, 'player')
      const owner = this.owners[m.player]
      // A place a person has taken is theirs alone, on whichever phone they come back on.
      if (owner !== undefined && owner !== member) return this.refuse(conn, 'taken')
      const held = this.seats[m.player]
      if (held !== undefined && held !== conn && (member === undefined || owner !== member)) {
        return this.refuse(conn, 'taken')
      }
      // A connection takes one player's place: any other it held is let go.
      this.seats = this.seats.map((c) => (c === conn ? undefined : c))
      this.seats[m.player] = conn
      if (member !== undefined) this.owners[m.player] = member
      return [
        this.welcome(conn, m.player, m.have <= this.log.length ? m.have : 0),
        ...this.presence(),
      ]
    }
    const player = this.playerOf(conn)
    if (player === undefined) {
      this.note(conn, `${m.t} before joining`)
      return []
    }
    switch (m.t) {
      case 'propose': {
        if (this.log.length >= WIRE_LIMITS.log) return this.refuse(conn, 'full')
        const entry: RelayEntry = { seq: this.log.length, from: player, input: m.input }
        this.log.push(entry)
        return this.toAll({ ...this.envelope(), t: 'entry', entry })
      }
      case 'print':
        return this.toAll({ ...this.envelope(), t: 'print', player, seq: m.seq, fp: m.fp }).filter(
          (s) => s.to !== conn,
        )
      case 'want':
        return [
          {
            to: conn,
            message: {
              ...this.envelope(),
              t: 'sync',
              setup: this.setup,
              from: Math.min(m.from, this.log.length),
              log: this.log.slice(Math.min(m.from, this.log.length)),
            },
          },
        ]
      case 'bye':
        return this.leave(conn)
    }
  }

  /**
   * The lobby's messages (SH0), before the room opens: the host gathers
   * (and changes) the table, phones sit down by name, players take seats
   * nobody plays or leave theirs. Every change goes to everyone who sat.
   */
  private gathering(
    conn: string,
    m: Extract<RelayIn, { t: 'gather' } | { t: 'sit' } | { t: 'claim' }>,
    member: string | undefined,
  ): Send[] {
    if (m.t === 'gather') {
      if (this.lobby === undefined) {
        this.build = m.build
        this.sitters = [conn]
        this.sitterOwners = [member]
      } else if (conn !== this.sitters[0]) {
        this.note(conn, 'gather from a player, not the host')
        return []
      } else if (m.build !== this.build) return this.refuse(conn, 'build')
      // Who sat is the relay's to say; the host names only themself.
      const players = [m.lobby.players[0]!, ...(this.lobby?.players.slice(1) ?? [])]
      const claims = m.lobby.claims.map((c) => (c < players.length ? c : -1))
      this.lobby = { ...m.lobby, players, claims }
      return this.toSitters()
    }
    if (this.lobby === undefined) return this.refuse(conn, 'no-room')
    if (m.build !== this.build) return this.refuse(conn, 'build')
    const lobby = this.lobby
    const me = this.sitters.indexOf(conn)
    if (m.t === 'sit') {
      const taken = lobby.players.some(
        (n, p) => p !== me && n.toLowerCase() === m.name.toLowerCase(),
      )
      if (taken) return this.refuse(conn, 'name')
      if (me >= 0) {
        this.lobby = { ...lobby, players: lobby.players.map((n, p) => (p === me ? m.name : n)) }
        return this.toSitters()
      }
      if (lobby.players.length >= WIRE_LIMITS.players) return this.refuse(conn, 'crowd')
      this.sitters.push(conn)
      this.sitterOwners.push(member)
      this.lobby = { ...lobby, players: [...lobby.players, m.name] }
      return this.toSitters()
    }
    if (me < 0 || m.seat >= lobby.seats.length) {
      this.note(conn, 'a claim from no player, or for no seat')
      return []
    }
    const held = lobby.claims[m.seat]!
    if (m.take && held !== -1 && held !== me) return this.refuse(conn, 'name')
    // The Author plays no seat.
    if (m.take && me === 0 && lobby.author) return this.refuse(conn, 'name')
    const claims = lobby.claims.map((c, k) => (k !== m.seat ? c : m.take ? me : c === me ? -1 : c))
    this.lobby = { ...lobby, claims }
    return this.toSitters()
  }

  /** The lobby to everyone who sat, each told which player they are. */
  private toSitters(): Send[] {
    const lobby = this.lobby
    if (lobby === undefined) return []
    return this.sitters.map((to, you) => ({
      to,
      message: { ...this.envelope(), t: 'lobby', lobby, you },
    }))
  }

  /** Connection `conn` is gone: its player's place is free, and everyone is told. */
  leave(conn: string): Send[] {
    if (this.setup === undefined && this.lobby !== undefined) {
      const p = this.sitters.indexOf(conn)
      if (p < 0) return []
      if (p === 0) {
        // The host has gone before the table opened: the lobby with them.
        const rest = this.sitters.slice(1)
        this.lobby = undefined
        this.sitters = []
        this.sitterOwners = []
        return rest.flatMap((c) => this.refuse(c, 'no-room'))
      }
      this.sitters.splice(p, 1)
      this.sitterOwners.splice(p, 1)
      const lobby = this.lobby
      this.lobby = {
        ...lobby,
        players: lobby.players.filter((_, q) => q !== p),
        claims: lobby.claims.map((c) => (c === p ? -1 : c > p ? c - 1 : c)),
      }
      return this.toSitters()
    }
    if (this.playerOf(conn) === undefined) return []
    this.seats = this.seats.map((c) => (c === conn ? undefined : c))
    return this.presence()
  }

  private welcome(conn: string, player: number, from: number): Send {
    return {
      to: conn,
      message: {
        ...this.envelope(),
        t: 'welcome',
        player,
        setup: this.setup,
        from,
        log: this.log.slice(from),
        present: this.present(),
      },
    }
  }
}
