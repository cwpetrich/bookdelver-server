import { type IncomingMessage, type ServerResponse, createServer as createHttp } from 'node:http'
import { createServer as createHttps } from 'node:https'
import type { AddressInfo } from 'node:net'
import { Relay, type Send } from './shared/relay.ts'
import {
  LOCKSTEP_PROTOCOL,
  type RefuseReason,
  WIRE_LIMITS,
  isRoomCode,
  wireText,
} from './shared/relay-wire.ts'
import {
  type FromServer,
  type JoinPolicy,
  type Member,
  type MemberRole,
  SERVER_PROTOCOL,
  SESSION_LIMITS,
  type SessionRefuse,
  type LibraryListing,
  type TableListing,
  type ToServer,
  encodeInvite,
  isSession,
  readToServer,
} from './shared/session-wire.ts'
import {
  DataFolder,
  LibraryFolder,
  type StoredEntry,
  type StoredVersion,
  type ServerFile,
  type StoredInvite,
  type StoredMember,
  SERVER_FORMAT,
  SERVER_VERSION,
  hashSecret,
  newCode,
  newSecret,
} from './store.ts'
import { type WebSocket, WebSocketServer } from 'ws'
import { LIBRARY_LIMITS, type LibraryKind, readCodeListing } from './shared/library-wire.ts'

/**
 * The reference server (docs/proposals/self-hosted-servers.md, slice SH1;
 * docs/server-protocol.md): one Node program a player runs for their group.
 * It puts each table's inputs in order and passes them on, and never runs a
 * fight: its rooms are core's `Relay`, which reads envelopes only. It knows
 * its members by a secret each phone made for it alone (kept as a hash),
 * hands out room codes, lists its tables, keeps each open room's log on disk,
 * closes a room after a day idle, and holds rate limits.
 *
 * Tables only, in SH1: no library (SH3), no host's tools beyond the owner
 * invite and the `invite` command (SH2).
 */

export interface ServerOptions {
  /** 0: any free port. */
  port: number
  /** The interface to listen on (`127.0.0.1` for this machine only). Default: every one. */
  host?: string
  /** The data folder. */
  data: string
  /** The public address that goes into invites; default `ws://localhost:<port>`. */
  url?: string
  /** On the first start only: the server's name, notice and join policy. */
  name?: string
  notice?: string
  join?: JoinPolicy
  /** TLS, when not left to Caddy or a tunnel: the certificate and key, as PEM text. */
  tls?: { cert: string; key: string }
  /** The clock (ms), for tests. */
  now?: () => number
  /** Where the server's own lines go. Default: none. */
  log?: (line: string) => void
  /** The rate limits, for tests that play faster than people (`LIMITS`). */
  limits?: Partial<Record<'messagesPerSecond' | 'proposalsPerSecond' | 'helloMs', number>>
}

export interface RunningServer {
  readonly port: number
  /** The address in invites. */
  readonly url: string
  /** The owner invite's code, until someone has used it. */
  ownerInvite(): string | undefined
  /** A new member invite's code: `uses` times, until `hours` from now (none: no end). */
  invite(role?: MemberRole, uses?: number, hours?: number): string
  /** Close the room `room` (as 24 hours idle does). */
  closeRoom(room: string): void
  /** Rooms idle past the limit closed now (the server does it every minute). */
  sweep(): void
  close(): Promise<void>
}

export const LIMITS = {
  /** Messages a connection may send in a second before it's closed. */
  messagesPerSecond: 100,
  /** Proposals a connection may make in a second before they're refused (`slow`). */
  proposalsPerSecond: 20,
  /** A room with nothing happening for this long is closed. */
  idleMs: 24 * 60 * 60 * 1000,
  /** Rooms at once, and members kept. */
  rooms: 200,
  members: 1_000,
  /** Reports kept for the inbox: the oldest go past it. */
  reports: 500,
  /**
   * A message's bytes on the wire (`ws`'s `maxPayload`): the protocol's cap
   * of 1,000,000 characters at UTF-8's 4 bytes a character at most; the
   * characters are counted once it's read.
   */
  frameBytes: WIRE_LIMITS.message * 4,
  /** How long a new connection has to say `hello`. */
  helloMs: 10_000,
  /** A ping this often; no answer by the next, and the connection is gone. */
  pingMs: 30_000,
} as const

interface Room {
  relay: Relay
  title: string
  active: number
  /** Whether its start is on disk (it has opened). */
  kept: boolean
  /** Members kicked from it (SH2): refused if they come back. */
  kicked: Set<string>
  /** The member who asked for it: its host. */
  hostId?: string
}

interface Connection {
  id: string
  ws: WebSocket
  /** Answered the last ping. */
  alive: boolean
  member: StoredMember | undefined
  rooms: Set<string>
  messages: number[]
  proposals: number[]
}

/** Start a server: listening once the promise resolves. */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const now = opts.now ?? (() => Date.now())
  const say = opts.log ?? (() => {})
  const rate = { ...LIMITS, ...opts.limits }
  const folder = new DataFolder(opts.data)
  const library = new LibraryFolder(opts.data)
  const fresh = (): ServerFile => ({
    format: SERVER_FORMAT,
    version: SERVER_VERSION,
    name: (opts.name ?? 'Bookdelver server').slice(0, SESSION_LIMITS.serverName),
    notice: (opts.notice ?? '').slice(0, SESSION_LIMITS.notice),
    join: opts.join ?? 'invite',
    members: [],
    invites: [],
    reports: [],
  })
  // The owner invite on a first start, kept until it's used.
  folder.update(fresh, (file) => {
    const owned = file.members.some((m) => m.role === 'owner')
    if (owned || file.invites.some((i) => i.secret !== undefined)) return
    const secret = newSecret()
    file.invites.push({ id: newCode(8), hash: hashSecret(secret), role: 'owner', uses: 1, secret })
  })

  const rooms = new Map<string, Room>()
  for (const { start, log } of folder.keptRooms()) {
    const owners = start.owners.map((o) => o ?? undefined)
    const relay = Relay.resume(
      start.room,
      start.build,
      { ...(start.setup as object), players: start.players, host: start.host },
      log,
      owners,
    )
    // The setup as it was sent, not with the fields above laid over it.
    relay.setup = start.setup
    rooms.set(start.room, {
      relay,
      title: start.title,
      active: start.active,
      kept: true,
      kicked: new Set(),
    })
  }
  const conns = new Map<string, Connection>()
  let nextConn = 1

  const handler = (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(426, { 'content-type': 'text/plain' })
    res.end('A Bookdelver server: connect from the app.\n')
  }
  const http =
    opts.tls === undefined
      ? createHttp(handler)
      : createHttps({ cert: opts.tls.cert, key: opts.tls.key }, handler)

  // WebSockets by `ws`: frames, masking, fragments, control frames and the close handshake
  // are its; a message past `maxPayload` closes the connection (1009), text that isn't
  // UTF-8 too (1007). No compression: nothing a phone sends is worth the memory it costs.
  const wss = new WebSocketServer({
    server: http,
    maxPayload: LIMITS.frameBytes,
    perMessageDeflate: false,
  })
  wss.on('connection', (ws) => {
    const conn: Connection = {
      id: `c${nextConn++}`,
      ws,
      alive: true,
      member: undefined,
      rooms: new Set(),
      messages: [],
      proposals: [],
    }
    conns.set(conn.id, conn)
    ws.on('message', (data, binary) => {
      if (binary) {
        ws.close(1003, 'text only')
        return
      }
      receive(
        conn,
        (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)).toString('utf8'),
      )
    })
    ws.on('pong', () => {
      conn.alive = true
    })
    ws.on('close', () => gone(conn))
    ws.on('error', () => ws.terminate())
    // A connection that hasn't said who it is in time is let go.
    setTimeout(() => {
      if (conn.member === undefined && conns.has(conn.id)) ws.close(1008, 'no hello')
    }, rate.helloMs).unref()
  })

  await new Promise<void>((resolve) => http.listen(opts.port, opts.host, resolve))
  const port = (http.address() as AddressInfo).port
  const url = opts.url ?? `ws://localhost:${port}`
  const sweeper = setInterval(() => sweep(), 60_000)
  sweeper.unref()
  // A ping every half minute; a connection that didn't answer the last one is gone.
  const heartbeat = setInterval(() => {
    for (const conn of conns.values()) {
      if (!conn.alive) {
        conn.ws.terminate()
        continue
      }
      conn.alive = false
      conn.ws.ping()
    }
  }, LIMITS.pingMs)
  heartbeat.unref()

  function file(): ServerFile {
    return folder.read(fresh)
  }

  function sendSession(conn: Connection, message: FromServer) {
    conn.ws.send(JSON.stringify(message))
  }

  function refuseSession(conn: Connection, reason: SessionRefuse, want?: number) {
    sendSession(conn, {
      sv: SERVER_PROTOCOL,
      t: 'refuse',
      reason,
      ...(want === undefined ? {} : { want }),
    })
  }

  function deliver(sends: readonly Send[]) {
    for (const s of sends) conns.get(s.to)?.ws.send(wireText(s.message))
  }

  /** A table-layer refusal for a room the relay can't answer for (none, or closed). */
  function refuseTable(conn: Connection, room: string, build: string, reason: RefuseReason) {
    conn.ws.send(wireText({ v: LOCKSTEP_PROTOCOL, build, room, t: 'refuse', reason, want: build }))
  }

  /** `stamps` within the last second, `t` added: how many. */
  function within(stamps: number[], t: number): number {
    stamps.push(t)
    while (stamps.length > 0 && stamps[0]! <= t - 1000) stamps.shift()
    return stamps.length
  }

  function receive(conn: Connection, text: string) {
    const t = now()
    if (within(conn.messages, t) > rate.messagesPerSecond) {
      say(`${conn.id}: too many messages, closed`)
      conn.ws.close(1008, 'too many messages')
      return
    }
    if (text.length > WIRE_LIMITS.message) {
      conn.ws.close(1009, 'too long')
      return
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      if (conn.member === undefined) refuseSession(conn, 'garbled')
      return
    }
    if (isSession(value)) return session(conn, value)
    if (conn.member === undefined) return
    table(conn, value)
  }

  function session(conn: Connection, value: unknown) {
    const sv = (value as { sv?: unknown }).sv
    if (sv !== SERVER_PROTOCOL) return refuseSession(conn, 'version', SERVER_PROTOCOL)
    const read = readToServer(value)
    if (!('ok' in read)) return refuseSession(conn, 'garbled')
    const m = read.ok
    if (m.t === 'hello') return hello(conn, m)
    const member = conn.member
    if (member === undefined) return
    switch (m.t) {
      case 'rename': {
        const taken = file().members.some(
          (x) => x.id !== member.id && x.name.toLowerCase() === m.name.toLowerCase(),
        )
        if (taken) return refuseSession(conn, 'name')
        folder.update(fresh, (f) => {
          const kept = f.members.find((x) => x.id === member.id)
          if (kept !== undefined) kept.name = m.name
        })
        member.name = m.name
        return sendSession(conn, { sv: SERVER_PROTOCOL, t: 'you', you: shown(member) })
      }
      case 'tables':
        return sendSession(conn, { sv: SERVER_PROTOCOL, t: 'tables', list: listing(member.id) })
      case 'table': {
        if (rooms.size >= LIMITS.rooms) return refuseSession(conn, 'full')
        let code = newCode(6)
        while (rooms.has(code)) code = newCode(6)
        rooms.set(code, {
          relay: new Relay(code),
          title: 'A table',
          active: now(),
          kept: false,
          kicked: new Set(),
          hostId: member.id,
        })
        say(`${member.name} opened table ${code}`)
        return sendSession(conn, { sv: SERVER_PROTOCOL, t: 'room', room: code })
      }
      case 'leave': {
        if (m.forget) {
          folder.update(fresh, (f) => {
            f.members = f.members.filter((x) => x.id !== member.id)
          })
          // Their entries go with them.
          const index = library.read()
          for (const e of index.entries.filter((x) => x.by === member.id)) library.dropEntry(e.id)
          index.entries = index.entries.filter((x) => x.by !== member.id)
          library.write(index)
          say(`${member.name} left, and asked to be forgotten`)
        }
        conn.ws.close(1000, 'left')
        return
      }
      case 'lib.list':
        return sendSession(conn, { sv: SERVER_PROTOCOL, t: 'lib.page', ...libraryPage(m) })
      case 'lib.get': {
        const entry = library.read().entries.find((e) => e.id === m.entry)
        const v = entry?.versions.find((x) => x.v === (m.version ?? entry.versions.at(-1)!.v))
        const code =
          entry === undefined || v === undefined ? undefined : library.code(entry.id, v.v)
        if (code === undefined)
          return sendSession(conn, { sv: SERVER_PROTOCOL, t: 'lib.gone', entry: m.entry })
        return sendSession(conn, {
          sv: SERVER_PROTOCOL,
          t: 'lib.code',
          entry: m.entry,
          version: v!.v,
          code,
        })
      }
      case 'lib.publish':
        return publish(conn, member, m)
      case 'lib.withdraw':
        return withdraw(conn, member, m)
      case 'report': {
        folder.update(fresh, (f) => {
          f.reports.push({
            id: newCode(8),
            by: member.id,
            reason: m.reason,
            at: now(),
            ...(m.member === undefined ? {} : { member: m.member }),
            ...(m.room === undefined ? {} : { room: m.room }),
            ...(m.entry === undefined ? {} : { entry: m.entry }),
          })
          if (f.reports.length > LIMITS.reports) f.reports.shift()
        })
        say(`${member.name} reported ${m.member ?? m.room ?? '?'} (${m.reason})`)
        return sendSession(conn, { sv: SERVER_PROTOCOL, t: 'reported' })
      }
      default:
        return tools(conn, member, m)
    }
  }

  /** How far each role reaches: a host's tool reaches only those below. */
  const RANK: Record<MemberRole, number> = { owner: 3, moderator: 2, author: 1, member: 0 }

  /**
   * The host's tools (docs/proposals/self-hosted-servers.md, section 5;
   * slice SH2): owners and moderators. A moderator acts on authors and
   * members only, and makes invites for them only; roles and settings are
   * the owner's.
   */
  function tools(
    conn: Connection,
    actor: StoredMember,
    m: Exclude<ToServer, { t: 'hello' | 'rename' | 'tables' | 'table' | 'leave' | 'report' }>,
  ) {
    const me = file().members.find((x) => x.id === actor.id)
    if (me === undefined || RANK[me.role] < RANK.moderator) return refuseSession(conn, 'forbidden')
    const owner = me.role === 'owner'
    /** The member `id`, if this actor reaches them. */
    const target = (id: string) => {
      const t = file().members.find((x) => x.id === id)
      return t !== undefined && RANK[t.role] < RANK[me.role] ? t : undefined
    }
    switch (m.t) {
      case 'invite': {
        if (m.role === 'owner' || (!owner && RANK[m.role] >= RANK.moderator)) {
          return refuseSession(conn, 'forbidden')
        }
        const secret = newSecret()
        const id = newCode(8)
        const expires = m.hours === undefined ? undefined : now() + m.hours * 3_600_000
        folder.update(fresh, (f) => {
          f.invites.push({
            id,
            hash: hashSecret(secret),
            role: m.role,
            uses: m.uses,
            by: me.id,
            ...(expires === undefined ? {} : { expires }),
          })
        })
        say(`${me.name} made an invite (${m.role}, ${m.uses})`)
        return sendSession(conn, {
          sv: SERVER_PROTOCOL,
          t: 'invite',
          id,
          secret,
          role: m.role,
          uses: m.uses,
          ...(expires === undefined ? {} : { expires }),
        })
      }
      case 'invites':
        return sendInvites(conn)
      case 'revoke':
        folder.update(fresh, (f) => {
          f.invites = f.invites.filter((i) => i.id !== m.invite || i.role === 'owner')
        })
        return sendInvites(conn)
      case 'members':
        return sendMembers(conn)
      case 'kick': {
        const t = target(m.member)
        const room = rooms.get(m.room)
        if (t === undefined || room === undefined) return refuseSession(conn, 'forbidden')
        room.kicked.add(t.id)
        for (const c of conns.values()) {
          if (c.member?.id !== t.id || !c.rooms.has(m.room)) continue
          c.rooms.delete(m.room)
          deliver(room.relay.leave(c.id))
          refuseTable(c, m.room, room.relay.build ?? '-', 'kicked')
        }
        say(`${me.name} kicked ${t.name} from table ${m.room}`)
        return sendMembers(conn)
      }
      case 'remove':
      case 'ban': {
        const t = target(m.member)
        if (t === undefined) return refuseSession(conn, 'forbidden')
        folder.update(fresh, (f) => {
          if (m.t === 'remove') f.members = f.members.filter((x) => x.id !== t.id)
          else {
            const kept = f.members.find((x) => x.id === t.id)
            if (kept !== undefined) kept.banned = true
            // A banned member's invites go with them.
            f.invites = f.invites.filter((i) => i.by !== t.id)
          }
        })
        shut(t.id, m.t === 'remove' ? 'removed' : 'banned')
        say(`${me.name} ${m.t === 'remove' ? 'removed' : 'banned'} ${t.name}`)
        return sendMembers(conn)
      }
      case 'unban': {
        const t = target(m.member)
        if (t === undefined) return refuseSession(conn, 'forbidden')
        folder.update(fresh, (f) => {
          const kept = f.members.find((x) => x.id === t.id)
          if (kept !== undefined) delete kept.banned
        })
        return sendMembers(conn)
      }
      case 'role': {
        const t = target(m.member)
        if (!owner || t === undefined || m.role === 'owner') return refuseSession(conn, 'forbidden')
        folder.update(fresh, (f) => {
          const kept = f.members.find((x) => x.id === t.id)
          if (kept !== undefined) kept.role = m.role
        })
        for (const c of conns.values()) if (c.member?.id === t.id) c.member.role = m.role
        return sendMembers(conn)
      }
      case 'settings': {
        if (!owner) return refuseSession(conn, 'forbidden')
        folder.update(fresh, (f) => {
          if (m.name !== undefined) f.name = m.name
          if (m.notice !== undefined) f.notice = m.notice
          if (m.join !== undefined) f.join = m.join
        })
        return sendServer(conn, me)
      }
      case 'reports':
        return sendReports(conn)
      case 'dismiss':
        folder.update(fresh, (f) => {
          f.reports = f.reports.filter((x) => x.id !== m.report)
        })
        return sendReports(conn)
    }
  }

  /** A member's every connection closed, told why. */
  function shut(id: string, why: 'removed' | 'banned') {
    for (const c of conns.values()) {
      if (c.member?.id !== id) continue
      refuseSession(c, why)
      c.ws.close(1008, why)
    }
  }

  // The library (docs/proposals/self-hosted-servers.md, section 3; slice SH3).

  /** An entry's newest title, or what's said of one withdrawn. */
  function titleOf(id: string): string {
    return (
      library
        .read()
        .entries.find((e) => e.id === id)
        ?.versions.at(-1)?.title ?? 'withdrawn'
    )
  }

  /** An entry as a page lists it: its newest version's listing. */
  function listed(e: StoredEntry): LibraryListing {
    const v = e.versions.at(-1)!
    return {
      id: e.id,
      kind: e.kind,
      sort: v.sort,
      title: v.title,
      intro: v.intro,
      author: v.author,
      by: e.by,
      byName: nameOf(e.by),
      version: v.v,
      versions: e.versions.length,
      at: v.at,
      ...(v.cols === undefined ? {} : { cols: v.cols }),
      ...(v.rows === undefined ? {} : { rows: v.rows }),
      ...(v.seats === undefined ? {} : { seats: v.seats }),
    }
  }

  /** A page of entries: newest first, of a kind, by a member, a title search, after an entry. */
  function libraryPage(m: { kind?: LibraryKind; q?: string; by?: string; after?: string }): {
    entries: LibraryListing[]
    next?: string
  } {
    const q = m.q?.toLowerCase()
    const all = library
      .read()
      .entries.filter(
        (e) =>
          (m.kind === undefined || e.kind === m.kind) &&
          (m.by === undefined || e.by === m.by) &&
          (q === undefined || e.versions.at(-1)!.title.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.versions.at(-1)!.at - a.versions.at(-1)!.at || (a.id < b.id ? -1 : 1))
    const from = m.after === undefined ? 0 : all.findIndex((e) => e.id === m.after) + 1
    const page = all.slice(from, from + LIBRARY_LIMITS.page)
    const more = from + LIBRARY_LIMITS.page < all.length
    return { entries: page.map(listed), ...(more ? { next: page.at(-1)!.id } : {}) }
  }

  /** A member's publishing, the last hour's: at most `LIBRARY_LIMITS.perHour`. */
  const publishing = new Map<string, number[]>()

  function publish(conn: Connection, member: StoredMember, m: { code: string; entry?: string }) {
    const me = file().members.find((x) => x.id === member.id)
    // Members browse and keep; authors, moderators and owners publish (section 5, "Roles").
    if (me === undefined || me.role === 'member') return refuseSession(conn, 'forbidden')
    const read = readCodeListing(m.code)
    if (!('ok' in read)) return refuseSession(conn, 'garbled')
    const listing = read.ok
    const t = now()
    const recent = (publishing.get(me.id) ?? []).filter((at) => at > t - 3_600_000)
    const index = library.read()
    const same = m.entry === undefined ? undefined : index.entries.find((e) => e.id === m.entry)
    if (
      m.entry !== undefined &&
      (same === undefined || same.by !== me.id || same.kind !== listing.kind)
    ) {
      return refuseSession(conn, 'forbidden')
    }
    const version: StoredVersion = {
      v: (same?.versions.at(-1)?.v ?? 0) + 1,
      at: t,
      content: listing.content,
      title: listing.title,
      intro: listing.intro,
      author: listing.author,
      sort: listing.sort,
      ...(listing.cols === undefined ? {} : { cols: listing.cols }),
      ...(listing.rows === undefined ? {} : { rows: listing.rows }),
      ...(listing.seats === undefined ? {} : { seats: listing.seats }),
    }
    // The same code again is the same version: nothing new.
    if (same !== undefined && same.versions.at(-1)!.content === listing.content) {
      return sendSession(conn, { sv: SERVER_PROTOCOL, t: 'lib.entry', entry: listed(same) })
    }
    if (recent.length >= LIBRARY_LIMITS.perHour) return refuseSession(conn, 'slow')
    let entry = same
    if (entry === undefined) {
      if (index.entries.length >= LIBRARY_LIMITS.entries) return refuseSession(conn, 'full')
      if (index.entries.filter((e) => e.by === me.id).length >= LIBRARY_LIMITS.mine) {
        return refuseSession(conn, 'full')
      }
      let id = newCode(8)
      while (index.entries.some((e) => e.id === id)) id = newCode(8)
      entry = { id, kind: listing.kind, by: me.id, versions: [] }
      index.entries.push(entry)
    }
    library.putCode(entry.id, version.v, m.code)
    entry.versions.push(version)
    while (entry.versions.length > LIBRARY_LIMITS.versions) {
      library.dropVersion(entry.id, entry.versions.shift()!.v)
    }
    library.write(index)
    publishing.set(me.id, [...recent, t])
    say(`${me.name} published ${listing.kind} "${listing.title}" (version ${version.v})`)
    sendSession(conn, { sv: SERVER_PROTOCOL, t: 'lib.entry', entry: listed(entry) })
  }

  function withdraw(
    conn: Connection,
    member: StoredMember,
    m: { entry: string; version?: number },
  ) {
    const me = file().members.find((x) => x.id === member.id)
    const index = library.read()
    const entry = index.entries.find((e) => e.id === m.entry)
    if (entry === undefined)
      return sendSession(conn, { sv: SERVER_PROTOCOL, t: 'lib.gone', entry: m.entry })
    const host = me !== undefined && (me.role === 'owner' || me.role === 'moderator')
    if (me === undefined || (entry.by !== me.id && !host)) return refuseSession(conn, 'forbidden')
    if (m.version !== undefined && entry.versions.length > 1) {
      entry.versions = entry.versions.filter((v) => v.v !== m.version)
      library.dropVersion(entry.id, m.version)
      library.write(index)
      return sendSession(conn, { sv: SERVER_PROTOCOL, t: 'lib.entry', entry: listed(entry) })
    }
    index.entries = index.entries.filter((e) => e !== entry)
    library.dropEntry(entry.id)
    library.write(index)
    say(`${me.name} withdrew "${entry.versions.at(-1)?.title ?? '?'}"`)
    sendSession(conn, { sv: SERVER_PROTOCOL, t: 'lib.gone', entry: entry.id })
  }

  function nameOf(id: string): string {
    return file().members.find((x) => x.id === id)?.name ?? 'someone gone'
  }

  function sendInvites(conn: Connection) {
    const t = now()
    const list = file()
      .invites.filter((i) => i.role !== 'owner' && (i.expires === undefined || i.expires > t))
      .slice(-SESSION_LIMITS.listed)
      .map((i) => ({
        id: i.id,
        role: i.role,
        uses: i.uses,
        ...(i.expires === undefined ? {} : { expires: i.expires }),
        ...(i.by === undefined ? {} : { by: nameOf(i.by) }),
      }))
    sendSession(conn, { sv: SERVER_PROTOCOL, t: 'invites', list })
  }

  function sendMembers(conn: Connection) {
    const list = file()
      .members.slice(0, SESSION_LIMITS.listed)
      .map((x) => ({
        id: x.id,
        name: x.name,
        role: x.role,
        joined: x.joined,
        banned: x.banned === true,
      }))
    sendSession(conn, { sv: SERVER_PROTOCOL, t: 'members', list })
  }

  function sendReports(conn: Connection) {
    const list = file()
      .reports.slice(-SESSION_LIMITS.listed)
      .map((x) => ({
        id: x.id,
        by: nameOf(x.by),
        reason: x.reason,
        at: x.at,
        ...(x.member === undefined ? {} : { member: { id: x.member, name: nameOf(x.member) } }),
        ...(x.room === undefined ? {} : { room: x.room }),
        ...(x.entry === undefined ? {} : { entry: { id: x.entry, title: titleOf(x.entry) } }),
      }))
    sendSession(conn, { sv: SERVER_PROTOCOL, t: 'reports', list })
  }

  function sendServer(conn: Connection, member: StoredMember) {
    const f = file()
    const owner = f.members.find((x) => x.role === 'owner')?.name ?? 'the host'
    sendSession(conn, {
      sv: SERVER_PROTOCOL,
      t: 'server',
      name: f.name || 'Bookdelver server',
      notice: f.notice,
      join: f.join,
      owner,
      you: shown(member),
    })
  }

  function shown(m: StoredMember): Member {
    return { id: m.id, name: m.name, role: m.role }
  }

  function hello(
    conn: Connection,
    m: { secret: string; invite?: string; name?: string; build: string },
  ) {
    if (conn.member !== undefined) return
    const hash = hashSecret(m.secret)
    let member = file().members.find((x) => x.secret === hash)
    if (member?.banned === true) return refuseSession(conn, 'banned')
    if (member === undefined) {
      const name = m.name
      if (name === undefined) return refuseSession(conn, 'secret')
      const made = folder.update(fresh, (f): StoredMember | SessionRefuse => {
        if (f.members.length >= LIMITS.members) return 'full'
        if (f.members.some((x) => x.name.toLowerCase() === name.toLowerCase())) return 'name'
        let invite: StoredInvite | undefined
        if (m.invite !== undefined) {
          const h = hashSecret(m.invite)
          invite = f.invites.find(
            (i) => i.hash === h && (i.expires === undefined || i.expires > now()),
          )
        }
        if (invite === undefined && f.join !== 'open') return 'invite'
        const owner = invite?.role === 'owner'
        // The owner invite is spent once an owner exists, whoever brought it.
        if (owner && f.members.some((x) => x.role === 'owner')) return 'invite'
        const role: MemberRole = invite?.role ?? 'author'
        let id = newCode(8)
        while (f.members.some((x) => x.id === id)) id = newCode(8)
        const made: StoredMember = {
          id,
          name,
          role,
          secret: hash,
          joined: now(),
          ...(invite === undefined ? {} : { invite: invite.id }),
        }
        f.members.push(made)
        if (invite !== undefined) {
          invite.uses -= 1
          if (invite.uses <= 0) f.invites = f.invites.filter((i) => i !== invite)
        }
        return made
      })
      if (typeof made === 'string') return refuseSession(conn, made)
      member = made
      say(`${member.name} joined as ${member.role}`)
    }
    conn.member = member
    sendServer(conn, member)
  }

  function table(conn: Connection, value: unknown) {
    const v = value as { room?: unknown; build?: unknown; t?: unknown }
    if (typeof v.room !== 'string' || !isRoomCode(v.room)) return
    const build = typeof v.build === 'string' && v.build.length > 0 ? v.build.slice(0, 64) : '-'
    const room = rooms.get(v.room)
    if (room === undefined) return refuseTable(conn, v.room, build, 'no-room')
    if (room.kicked.has(conn.member!.id)) return refuseTable(conn, v.room, build, 'kicked')
    const t = now()
    if (v.t === 'propose' && within(conn.proposals, t) > rate.proposalsPerSecond) {
      return refuseTable(conn, v.room, build, 'slow')
    }
    conn.rooms.add(v.room)
    const relay = room.relay
    const before = relay.log.length
    const opened = relay.setup !== undefined
    const sends = relay.receive(conn.id, value, conn.member!.id)
    room.active = t
    if (relay.lobby !== undefined) room.title = relay.lobby.title
    if (!opened && relay.setup !== undefined) {
      room.kept = true
      folder.startRoom(v.room, startLine(v.room, room))
    } else if (relay.log.length > before) {
      for (const e of relay.log.slice(before)) folder.addEntry(v.room, e)
    } else if (v.t === 'join' && room.kept) {
      // Who holds each place, kept with the start.
      folder.startRoom(v.room, startLine(v.room, room))
      for (const e of relay.log) folder.addEntry(v.room, e)
    }
    deliver(sends)
  }

  function startLine(code: string, room: Room) {
    const r = room.relay
    return {
      room: code,
      build: r.build ?? '-',
      title: room.title,
      setup: r.setup,
      players: r.players,
      host: r.host,
      owners: r.placesOwned().map((o) => o ?? null),
      active: room.active,
    }
  }

  function listing(member: string): TableListing[] {
    const out: TableListing[] = []
    for (const [code, room] of rooms) {
      const r = room.relay
      const hostId = room.hostId ?? r.placesOwned()[r.host]
      const by = hostId === undefined ? {} : { hostId }
      if (r.lobby !== undefined) {
        out.push({
          ...by,
          room: code,
          title: room.title,
          host: r.lobby.players[0]!,
          players: r.lobby.players.length,
          free: r.lobby.claims.filter((c) => c < 0).length,
          build: r.build ?? '-',
          open: false,
        })
      } else if (r.setup !== undefined) {
        out.push({
          ...by,
          room: code,
          title: room.title,
          host: r.players[r.host] ?? '?',
          players: r.players.length,
          free: r.present().filter((p) => !p).length,
          build: r.build ?? '-',
          open: true,
          ...(r.placesOwned().includes(member) ? { you: r.placesOwned().indexOf(member) } : {}),
        })
      }
      if (out.length >= SESSION_LIMITS.tables) break
    }
    return out
  }

  function gone(conn: Connection) {
    conns.delete(conn.id)
    for (const code of conn.rooms) {
      const room = rooms.get(code)
      if (room !== undefined) deliver(room.relay.leave(conn.id))
    }
  }

  function closeRoom(code: string) {
    const room = rooms.get(code)
    if (room === undefined) return
    rooms.delete(code)
    folder.dropRoom(code)
    for (const conn of conns.values()) {
      if (!conn.rooms.has(code)) continue
      conn.rooms.delete(code)
      refuseTable(conn, code, room.relay.build ?? '-', 'closed')
    }
    say(`table ${code} closed`)
  }

  function sweep() {
    const t = now()
    for (const [code, room] of [...rooms]) {
      if (t - room.active >= LIMITS.idleMs) closeRoom(code)
    }
  }

  function invite(role: MemberRole = 'author', uses = 1, hours?: number): string {
    const secret = newSecret()
    folder.update(fresh, (f) => {
      f.invites.push({
        id: newCode(8),
        hash: hashSecret(secret),
        role,
        uses,
        ...(hours === undefined ? {} : { expires: now() + hours * 3_600_000 }),
      })
    })
    return encodeInvite({ address: url, invite: secret, name: file().name || 'Bookdelver server' })
  }

  return {
    port,
    url,
    ownerInvite() {
      const f = file()
      const held = f.invites.find((i) => i.role === 'owner' && i.secret !== undefined)
      if (held?.secret === undefined || f.members.some((m) => m.role === 'owner')) return undefined
      return encodeInvite({
        address: url,
        invite: held.secret,
        name: f.name || 'Bookdelver server',
      })
    },
    invite,
    closeRoom,
    sweep,
    async close() {
      clearInterval(sweeper)
      clearInterval(heartbeat)
      for (const conn of conns.values()) conn.ws.close(1001, 'the server is stopping')
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      for (const conn of conns.values()) conn.ws.terminate()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}
