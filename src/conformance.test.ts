import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCKSTEP_PROTOCOL } from './shared/relay-wire.ts'
import { type FromServer, decodeInvite, readFromServer } from './shared/session-wire.ts'
import { LIMITS, type RunningServer, startServer } from './server.ts'

/**
 * The conformance suite (docs/proposals/self-hosted-servers.md, section 2;
 * docs/server-protocol.md, "Conformance"), against the reference server
 * started in this process on a free port of this machine, with Node's own
 * WebSocket client as the phones' connection: hello (the owner, an invite,
 * refusals), a table gathered, opened and played by the protocol's messages
 * alone (its payloads opaque, as the server carries them), a reconnect
 * replayed, a seat kept for its person, a restart, a room closed when idle,
 * the caps and the WebSocket layer. It needs nothing of the game: it runs
 * where the server is published as well as in the Bookdelver repository.
 */

const BUILD = '0.1.0+conformance'
const dirs: string[] = []
const servers: RunningServer[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close()
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Phones played by bots decide far faster than people: the rate limits raised but for their own test. */
const FAST = { messagesPerSecond: 100_000, proposalsPerSecond: 100_000 }

async function server(
  data = mkdtempSync(join(tmpdir(), 'bd-server-')),
  now?: () => number,
  limits: object = FAST,
) {
  if (!dirs.includes(data)) dirs.push(data)
  const s = await startServer({
    port: 0,
    host: '127.0.0.1',
    data,
    name: 'The Lantern Table',
    limits,
    ...(now === undefined ? {} : { now }),
  })
  servers.push(s)
  return { s, data }
}

const secret = (n: number) => Buffer.alloc(32, n).toString('base64url')
const inviteOf = (code: string) => {
  const read = decodeInvite(code)
  if (!('ok' in read)) throw new Error(read.problems.join('; '))
  return read.ok.invite
}

/** A phone's connection: what came in, in order, and waiting for a message. */
class Client {
  readonly got: unknown[] = []
  readonly sent: unknown[] = []
  closed = false
  private waiters: (() => void)[] = []
  onTable: ((value: unknown) => void) | undefined
  readonly ws: WebSocket

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`)
    sockets.push(this.ws)
    this.ws.onmessage = (e) => {
      const value = JSON.parse(String(e.data)) as unknown
      this.got.push(value)
      if (typeof value === 'object' && value !== null && 'v' in value) this.onTable?.(value)
      for (const w of this.waiters.splice(0)) w()
    }
    this.ws.onclose = () => {
      this.closed = true
      for (const w of this.waiters.splice(0)) w()
    }
  }

  async ready() {
    if (this.ws.readyState === WebSocket.OPEN) return
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('no connection'))
    })
  }

  send(value: unknown) {
    this.sent.push(value)
    this.ws.send(typeof value === 'string' ? value : JSON.stringify(value))
  }

  /** The first message from `from` on that `pick` finds, waited for. */
  async next<T>(pick: (v: unknown) => T | undefined, from = 0, ms = 5_000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      for (const v of this.got.slice(from)) {
        const found = pick(v)
        if (found !== undefined) return found
      }
      if (this.closed) throw new Error('closed')
      if (Date.now() > end) throw new Error(`nothing came: ${JSON.stringify(this.got).slice(-300)}`)
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        setTimeout(resolve, 50)
      })
    }
  }

  /** A session message of type `t`, from the session layer's reader. */
  session<T extends FromServer['t']>(t: T, from = 0): Promise<Extract<FromServer, { t: T }>> {
    return this.next((v) => {
      const r = readFromServer(v)
      return 'ok' in r && r.ok.t === t ? (r.ok as Extract<FromServer, { t: T }>) : undefined
    }, from)
  }
}

async function hello(port: number, n: number, extra: object = {}) {
  const c = new Client(port)
  await c.ready()
  c.send({ sv: 1, t: 'hello', build: BUILD, secret: secret(n), ...extra })
  return c
}

describe('hello', () => {
  it('makes the owner by the owner invite, members by invites, and refuses the rest', async () => {
    const { s } = await server()
    const owner = s.ownerInvite()!
    expect(decodeInvite(owner)).toMatchObject({ ok: { name: 'The Lantern Table' } })
    const sam = await hello(s.port, 1, { invite: inviteOf(owner), name: 'Sam' })
    expect(await sam.session('server')).toMatchObject({
      name: 'The Lantern Table',
      owner: 'Sam',
      join: 'invite',
      you: { name: 'Sam', role: 'owner' },
    })
    expect(s.ownerInvite()).toBeUndefined()
    // The owner invite, spent; no invite on an invite-only server; a secret it doesn't know.
    const again = await hello(s.port, 2, { invite: inviteOf(owner), name: 'Mallory' })
    expect(await again.session('refuse')).toMatchObject({ reason: 'invite' })
    const none = await hello(s.port, 3, { name: 'Stranger' })
    expect(await none.session('refuse')).toMatchObject({ reason: 'invite' })
    const unknown = await hello(s.port, 4)
    expect(await unknown.session('refuse')).toMatchObject({ reason: 'secret' })
    // An invite made for two: two members, then no more; a name taken, in any case.
    const code = s.invite('author', 2)
    const kiku = await hello(s.port, 5, { invite: inviteOf(code), name: 'Kiku' })
    expect(await kiku.session('server')).toMatchObject({ you: { name: 'Kiku', role: 'author' } })
    const taken = await hello(s.port, 6, { invite: inviteOf(code), name: 'kiku' })
    expect(await taken.session('refuse')).toMatchObject({ reason: 'name' })
    const ana = await hello(s.port, 7, { invite: inviteOf(code), name: 'Ana' })
    expect(await ana.session('server')).toMatchObject({ you: { name: 'Ana' } })
    const late = await hello(s.port, 8, { invite: inviteOf(code), name: 'Bo' })
    expect(await late.session('refuse')).toMatchObject({ reason: 'invite' })
    // Back with the same secret, on another connection: the same member, no invite needed.
    const back = await hello(s.port, 5)
    expect(await back.session('server')).toMatchObject({ you: { name: 'Kiku' } })
    // Another version of the session protocol, and text that isn't JSON.
    const newer = new Client(s.port)
    await newer.ready()
    newer.send({ sv: 2, t: 'hello', build: BUILD, secret: secret(9) })
    expect(
      await newer.next((v) => ((v as { reason?: string }).reason === 'version' ? v : undefined)),
    ).toMatchObject({ want: 1 })
    newer.send('{"sv":1')
    expect(await newer.session('refuse', 1)).toMatchObject({ reason: 'garbled' })
    // Nothing of the table layer before hello.
    newer.send({ v: LOCKSTEP_PROTOCOL, build: BUILD, room: 'K7F2Q9', t: 'bye' })
    await new Promise((r) => setTimeout(r, 100))
    expect(newer.got.length).toBe(2)
  })

  it('renames, and forgets a member who asks', async () => {
    const { s } = await server()
    const sam = await hello(s.port, 1, { invite: inviteOf(s.ownerInvite()!), name: 'Sam' })
    await sam.session('server')
    sam.send({ sv: 1, t: 'rename', name: 'Samwise' })
    expect(await sam.session('you')).toMatchObject({ you: { name: 'Samwise' } })
    const kiku = await hello(s.port, 2, { invite: inviteOf(s.invite()), name: 'Kiku' })
    await kiku.session('server')
    kiku.send({ sv: 1, t: 'rename', name: 'SAMWISE' })
    expect(await kiku.session('refuse')).toMatchObject({ reason: 'name' })
    kiku.send({ sv: 1, t: 'leave', forget: true })
    await kiku.next(() => (kiku.closed ? true : undefined)).catch(() => true)
    const back = await hello(s.port, 2)
    expect(await back.session('refuse')).toMatchObject({ reason: 'secret' })
  })
})

describe('the caps', () => {
  it('closes a connection that floods, or sends a frame past the cap', async () => {
    const { s } = await server(undefined, undefined, {})
    const flood = await hello(s.port, 1, { invite: inviteOf(s.ownerInvite()!), name: 'Sam' })
    await flood.session('server')
    for (let i = 0; i < 120; i++) flood.send({ sv: 1, t: 'tables' })
    await flood.next(() => (flood.closed ? true : undefined)).catch(() => true)
    expect(flood.closed).toBe(true)
    const big = await hello(s.port, 1)
    await big.session('server')
    big.send({ sv: 1, t: 'rename', name: 'x'.repeat(1_000_001) })
    await big.next(() => (big.closed ? true : undefined)).catch(() => true)
    expect(big.closed).toBe(true)
  })
})

const env = (room: string) => ({ v: LOCKSTEP_PROTOCOL, build: BUILD, room })
/** A setup as the server sees it: players and a host it seats; the rest it carries unread. */
const SETUP = {
  players: ['Sam', 'Kiku'],
  host: 0,
  scenario: 'anything a newer app sends',
  heroes: [{ deep: [1, [2, [3]]] }],
  start: '00000000',
}
const LOBBY = {
  title: 'A table',
  seats: ['Mara', 'Tam'],
  players: ['Sam'],
  claims: [0, -1],
  author: false,
}
const typed =
  (t: string, extra: (v: Record<string, unknown>) => boolean = () => true) =>
  (v: unknown) => {
    const m = v as Record<string, unknown>
    return m.t === t && extra(m) ? m : undefined
  }

/** The owner and Kiku on a server, Kiku sat at a table Sam gathered, seat 1 Kiku's. */
async function gathered(s: RunningServer) {
  const sam = await hello(s.port, 1, { invite: inviteOf(s.ownerInvite()!), name: 'Sam' })
  await sam.session('server')
  const kiku = await hello(s.port, 2, { invite: inviteOf(s.invite('author', 3)), name: 'Kiku' })
  await kiku.session('server')
  sam.send({ sv: 1, t: 'table' })
  const { room } = await sam.session('room')
  sam.send({ ...env(room), t: 'gather', lobby: LOBBY })
  await sam.next(typed('lobby'))
  kiku.send({ ...env(room), t: 'sit', name: 'Kiku' })
  expect(await kiku.next(typed('lobby'))).toMatchObject({
    you: 1,
    lobby: { players: ['Sam', 'Kiku'] },
  })
  kiku.send({ ...env(room), t: 'claim', seat: 1, take: true })
  await sam.next(typed('lobby', (m) => (m.lobby as { claims: number[] }).claims[1] === 1))
  return { room, sam, kiku }
}

describe('a table, by the protocol alone', () => {
  it('gathers, opens, numbers and passes on, lists, and keeps a seat for its person', async () => {
    const { s } = await server()
    const { room, sam, kiku } = await gathered(s)
    sam.send({ sv: 1, t: 'tables' })
    expect((await sam.session('tables')).list).toEqual([
      {
        hostId: expect.stringMatching(/^[0-9A-Z]{8}$/),
        room,
        title: 'A table',
        host: 'Sam',
        players: 2,
        free: 0,
        build: BUILD,
        open: false,
      },
    ])
    sam.send({ ...env(room), t: 'open', setup: SETUP })
    // The setup comes back to each as it was sent: carried, not read.
    expect(await kiku.next(typed('welcome'))).toMatchObject({ player: 1, setup: SETUP, log: [] })
    expect(await sam.next(typed('welcome'))).toMatchObject({ player: 0, setup: SETUP })
    sam.send({ ...env(room), t: 'propose', input: { kind: 'a-move-no-server-knows', n: 1 } })
    await kiku.next(typed('entry'))
    kiku.send({ ...env(room), t: 'propose', input: { kind: 'let-go', at: '0123abcd' } })
    const second = await sam.next(typed('entry', (m) => (m.entry as { seq: number }).seq === 1))
    expect(second.entry).toEqual({ seq: 1, from: 1, input: { kind: 'let-go', at: '0123abcd' } })
    expect(await kiku.next(typed('entry'))).toMatchObject({
      entry: { seq: 0, from: 0, input: { kind: 'a-move-no-server-knows', n: 1 } },
    })
    kiku.send({ ...env(room), t: 'print', seq: 0, fp: '0123abcd' })
    expect(await sam.next(typed('print'))).toMatchObject({ player: 1, seq: 0, fp: '0123abcd' })
    const from = sam.got.length
    sam.send({ sv: 1, t: 'tables' })
    expect((await sam.session('tables', from)).list[0]).toMatchObject({ open: true, you: 0 })
    // Another person can't take Kiku's place; Kiku, back on a new connection, can.
    const ana = await hello(s.port, 3, { invite: inviteOf(s.invite()), name: 'Ana' })
    await ana.session('server')
    ana.send({ ...env(room), t: 'join', player: 1, have: 0 })
    expect(await ana.next(typed('refuse'))).toMatchObject({ reason: 'taken' })
    kiku.ws.close()
    expect(
      await sam.next(typed('presence', (m) => (m.present as boolean[])[1] === false)),
    ).toBeDefined()
    const back = await hello(s.port, 2)
    await back.session('server')
    back.send({ ...env(room), t: 'join', player: 1, have: 1 })
    expect(await back.next(typed('welcome'))).toMatchObject({
      player: 1,
      from: 1,
      log: [{ seq: 1, from: 1 }],
    })
    // A message for a room that isn't there.
    back.send({ ...env('000000'), t: 'join', player: 0, have: 0 })
    expect(await back.next(typed('refuse', (m) => m.reason === 'no-room'))).toBeDefined()
  })

  it('keeps an open room over a restart, its members and their places', async () => {
    const { s, data } = await server()
    const { room, sam, kiku } = await gathered(s)
    sam.send({ ...env(room), t: 'open', setup: SETUP })
    await kiku.next(typed('welcome'))
    sam.send({ ...env(room), t: 'propose', input: { kind: 'one' } })
    sam.send({ ...env(room), t: 'propose', input: { kind: 'two' } })
    await kiku.next(typed('entry', (m) => (m.entry as { seq: number }).seq === 1))
    expect(readdirSync(join(data, 'rooms'))).toEqual([`${room}.jsonl`])
    await s.close()
    servers.splice(servers.indexOf(s), 1)
    const { s: again } = await server(data)
    const k2 = await hello(again.port, 2)
    expect(await k2.session('server')).toMatchObject({ you: { name: 'Kiku' } })
    k2.send({ ...env(room), t: 'join', player: 1, have: 0 })
    const w = await k2.next(typed('welcome'))
    expect(w).toMatchObject({ player: 1, setup: SETUP })
    expect((w.log as { input: unknown }[]).map((e) => e.input)).toEqual([
      { kind: 'one' },
      { kind: 'two' },
    ])
    // Sam can't take Kiku's place after the restart either.
    const sam2 = await hello(again.port, 1)
    await sam2.session('server')
    sam2.send({ ...env(room), t: 'join', player: 1, have: 0 })
    expect(await sam2.next(typed('refuse'))).toMatchObject({ reason: 'taken' })
  })

  it('closes a room a day idle, and refuses what comes for it', async () => {
    let clock = 1_000_000
    const { s } = await server(undefined, () => clock)
    const { room, sam, kiku } = await gathered(s)
    sam.send({ ...env(room), t: 'open', setup: SETUP })
    await kiku.next(typed('welcome'))
    clock += 25 * 60 * 60 * 1000
    s.sweep()
    await kiku.next(typed('refuse', (m) => m.reason === 'closed'))
    const from = kiku.got.length
    kiku.send({ ...env(room), t: 'join', player: 1, have: 0 })
    await kiku.next(
      typed('refuse', (m) => m.reason === 'no-room'),
      from,
    )
  })

  it('refuses proposals past the rate, as slow', async () => {
    const { s } = await server(undefined, undefined, {})
    const { room, sam, kiku } = await gathered(s)
    sam.send({ ...env(room), t: 'open', setup: SETUP })
    await kiku.next(typed('welcome'))
    for (let i = 0; i < 30; i++) kiku.send({ ...env(room), t: 'propose', input: { i } })
    await kiku.next(typed('refuse', (m) => m.reason === 'slow'))
  })
})

describe('the host’s tools (SH2)', () => {
  /** The owner, and a member by an invite the owner made in the app. */
  async function hosted() {
    const { s } = await server()
    const sam = await hello(s.port, 1, { invite: inviteOf(s.ownerInvite()!), name: 'Sam' })
    await sam.session('server')
    sam.send({ sv: 1, t: 'invite', role: 'author', uses: 2, hours: 24 })
    const made = await sam.session('invite')
    expect(made).toMatchObject({ role: 'author', uses: 2 })
    expect(made.expires).toBeGreaterThan(Date.now())
    const kiku = await hello(s.port, 2, { invite: made.secret, name: 'Kiku' })
    expect(await kiku.session('server')).toMatchObject({ you: { name: 'Kiku', role: 'author' } })
    return { s, sam, kiku, made }
  }

  it('makes, lists and revokes invites, and keeps the tools for owners and moderators', async () => {
    const { s, sam, kiku, made } = await hosted()
    let from = sam.got.length
    sam.send({ sv: 1, t: 'invites' })
    expect((await sam.session('invites', from)).list).toEqual([
      { id: made.id, role: 'author', uses: 1, expires: made.expires, by: 'Sam' },
    ])
    sam.send({ sv: 1, t: 'revoke', invite: made.id })
    from = sam.got.length
    expect((await sam.session('invites', from)).list).toEqual([])
    const late = await hello(s.port, 3, { invite: made.secret, name: 'Ana' })
    expect(await late.session('refuse')).toMatchObject({ reason: 'invite' })
    // An author has no tools; a moderator has some, and makes no moderators.
    kiku.send({ sv: 1, t: 'members' })
    expect(await kiku.session('refuse')).toMatchObject({ reason: 'forbidden' })
    const kikuId = (await kiku.session('server')).you.id
    sam.send({ sv: 1, t: 'role', member: kikuId, role: 'moderator' })
    from = sam.got.length
    expect((await sam.session('members', from)).list.map((m) => [m.name, m.role])).toEqual([
      ['Sam', 'owner'],
      ['Kiku', 'moderator'],
    ])
    from = kiku.got.length
    kiku.send({ sv: 1, t: 'invite', role: 'moderator', uses: 1 })
    expect(await kiku.session('refuse', from)).toMatchObject({ reason: 'forbidden' })
    kiku.send({ sv: 1, t: 'invite', role: 'member', uses: 1 })
    expect(await kiku.session('invite')).toMatchObject({ role: 'member' })
    // A moderator can't touch the owner, nor change roles or settings.
    const samId = (await sam.session('server')).you.id
    from = kiku.got.length
    kiku.send({ sv: 1, t: 'ban', member: samId })
    expect(await kiku.session('refuse', from)).toMatchObject({ reason: 'forbidden' })
    from = kiku.got.length
    kiku.send({ sv: 1, t: 'settings', notice: 'Mine now' })
    expect(await kiku.session('refuse', from)).toMatchObject({ reason: 'forbidden' })
  })

  it('takes reports, lists them for the host, and dismisses them', async () => {
    const { sam, kiku } = await hosted()
    const samId = (await sam.session('server')).you.id
    kiku.send({ sv: 1, t: 'report', member: samId, reason: 'offensive' })
    await kiku.session('reported')
    kiku.send({ sv: 1, t: 'report', room: 'K7F2Q9', reason: 'cheating' })
    await kiku.next(typed('reported'), kiku.got.length)
    let from = sam.got.length
    sam.send({ sv: 1, t: 'reports' })
    let list = (await sam.session('reports', from)).list
    for (let i = 0; i < 20 && list.length < 2; i++) {
      from = sam.got.length
      sam.send({ sv: 1, t: 'reports' })
      list = (await sam.session('reports', from)).list
    }
    expect(list.map((r) => [r.by, r.member?.name ?? r.room, r.reason])).toEqual([
      ['Kiku', 'Sam', 'offensive'],
      ['Kiku', 'K7F2Q9', 'cheating'],
    ])
    from = sam.got.length
    sam.send({ sv: 1, t: 'dismiss', report: list[0]!.id })
    expect((await sam.session('reports', from)).list.length).toBe(1)
  })

  it('kicks from a table, removes, bans and unbans', async () => {
    const { s, sam, kiku } = await hosted()
    const kikuId = (await kiku.session('server')).you.id
    // A table, Kiku at it: kicked, the host sees them gone, and they can't come back to it.
    sam.send({ sv: 1, t: 'table' })
    const { room } = await sam.session('room')
    sam.send({ ...env(room), t: 'gather', lobby: LOBBY })
    await sam.next(typed('lobby'))
    kiku.send({ ...env(room), t: 'sit', name: 'Kiku' })
    await kiku.next(typed('lobby'))
    sam.send({ ...env(room), t: 'open', setup: SETUP })
    await kiku.next(typed('welcome'))
    sam.send({ sv: 1, t: 'kick', member: kikuId, room })
    expect(await kiku.next(typed('refuse', (m) => m.reason === 'kicked'))).toBeDefined()
    expect(
      await sam.next(typed('presence', (m) => (m.present as boolean[])[1] === false)),
    ).toBeDefined()
    let from = kiku.got.length
    kiku.send({ ...env(room), t: 'join', player: 1, have: 0 })
    expect(
      await kiku.next(
        typed('refuse', (m) => m.reason === 'kicked'),
        from,
      ),
    ).toBeDefined()
    // Banned: closed, refused on hello, its invites gone; unbanned: back.
    sam.send({ sv: 1, t: 'role', member: kikuId, role: 'moderator' })
    await sam.session('members', sam.got.length)
    kiku.send({ sv: 1, t: 'invite', role: 'member', uses: 5 })
    const theirs = await kiku.session('invite')
    from = sam.got.length
    sam.send({ sv: 1, t: 'role', member: kikuId, role: 'author' })
    await sam.session('members', from)
    sam.send({ sv: 1, t: 'ban', member: kikuId })
    expect(await kiku.session('refuse')).toBeDefined()
    await kiku.next(() => (kiku.closed ? true : undefined)).catch(() => true)
    expect(kiku.closed).toBe(true)
    const banned = await hello(s.port, 2)
    expect(await banned.session('refuse')).toMatchObject({ reason: 'banned' })
    const viaTheirs = await hello(s.port, 4, { invite: theirs.secret, name: 'Bo' })
    expect(await viaTheirs.session('refuse')).toMatchObject({ reason: 'invite' })
    from = sam.got.length
    sam.send({ sv: 1, t: 'members' })
    expect((await sam.session('members', from)).list.find((m) => m.id === kikuId)?.banned).toBe(
      true,
    )
    sam.send({ sv: 1, t: 'unban', member: kikuId })
    await sam.session('members', from + 1)
    const back = await hello(s.port, 2)
    expect(await back.session('server')).toMatchObject({ you: { name: 'Kiku' } })
    // Removed: closed, and their secret no longer works.
    sam.send({ sv: 1, t: 'remove', member: kikuId })
    expect(await back.session('refuse')).toMatchObject({ reason: 'removed' })
    const gone = await hello(s.port, 2)
    expect(await gone.session('refuse')).toMatchObject({ reason: 'secret' })
  })

  it('lets the owner change the name, the notice and who may join', async () => {
    const { s, sam } = await hosted()
    const from = sam.got.length
    sam.send({ sv: 1, t: 'settings', name: 'Crypt Club', notice: 'Fridays.', join: 'open' })
    expect(await sam.session('server', from)).toMatchObject({
      name: 'Crypt Club',
      notice: 'Fridays.',
      join: 'open',
    })
    const walkIn = await hello(s.port, 9, { name: 'Walk-in' })
    expect(await walkIn.session('server')).toMatchObject({
      name: 'Crypt Club',
      you: { role: 'author' },
    })
  })
})

describe('the server stands alone', () => {
  it('imports only Node, ws, its own modules and the shared five', () => {
    const dir = new URL('.', import.meta.url)
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.includes('.test.')) continue
      const text = readFileSync(new URL(name, dir), 'utf8')
      for (const m of text.matchAll(/from '([^']+)'/g)) {
        const spec = m[1]!
        expect(
          spec.startsWith('node:') || spec === 'ws' || /^\.\/(shared\/)?[a-z-]+\.ts$/.test(spec),
          `${name}: ${spec}`,
        ).toBe(true)
      }
    }
    expect(readdirSync(new URL('./shared/', dir)).sort()).toEqual([
      'codec.ts',
      'reader.ts',
      'relay-wire.ts',
      'relay.ts',
      'session-wire.ts',
    ])
  })
})

/**
 * A raw TCP connection that does the WebSocket handshake by hand, so a test
 * can send frames no client library would: what the server's socket does
 * then (its close frame's code, or the socket ending).
 */
async function raw(port: number, frame: Buffer): Promise<{ code: number | undefined }> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    let got = Buffer.alloc(0)
    let upgraded = false
    socket.on('connect', () => {
      socket.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    socket.on('data', (chunk: Buffer) => {
      got = Buffer.concat([got, chunk])
      if (!upgraded) {
        const end = got.indexOf('\r\n\r\n')
        if (end < 0) return
        upgraded = true
        got = got.subarray(end + 4)
        socket.write(frame)
      }
      // A close frame from the server: opcode 8, its code in the first two bytes.
      if (got.length >= 4 && (got[0]! & 0x0f) === 0x8) {
        resolve({ code: got.readUInt16BE(2) })
        socket.destroy()
      }
    })
    socket.on('close', () => resolve({ code: undefined }))
  })
}

/** A client frame: text unless `opcode` says, masked unless `masked` is false. */
function frame(payload: Buffer, opts: { opcode?: number; masked?: boolean } = {}): Buffer {
  const masked = opts.masked ?? true
  const len = payload.length
  const head =
    len < 126
      ? Buffer.from([0x80 | (opts.opcode ?? 1), (masked ? 0x80 : 0) | len])
      : (() => {
          const b = Buffer.alloc(10)
          b[0] = 0x80 | (opts.opcode ?? 1)
          b[1] = (masked ? 0x80 : 0) | 127
          b.writeBigUInt64BE(BigInt(len), 2)
          return b
        })()
  if (!masked) return Buffer.concat([head, payload])
  const mask = Buffer.from([1, 2, 3, 4])
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]!))
  return Buffer.concat([head, mask, body])
}

describe('the WebSocket layer (`ws`)', () => {
  it('closes on an unmasked client frame, a binary frame, and one past the size cap', async () => {
    const { s } = await server()
    const hello = Buffer.from(JSON.stringify({ sv: 1, t: 'tables' }))
    // Unmasked: a protocol error (1002).
    expect(await raw(s.port, frame(hello, { masked: false }))).toEqual({ code: 1002 })
    // Binary: text only (1003).
    expect(await raw(s.port, frame(hello, { opcode: 2 }))).toEqual({ code: 1003 })
    // A length past `maxPayload`, declared in a 64-bit length: closed before it's read (1009).
    const head = Buffer.alloc(14)
    head[0] = 0x81
    head[1] = 0x80 | 127
    head.writeBigUInt64BE(BigInt(LIMITS.frameBytes + 1), 2)
    expect(await raw(s.port, head)).toEqual({ code: 1009 })
    // Text that isn't UTF-8 (1007).
    expect(await raw(s.port, frame(Buffer.from([0xc3, 0x28])))).toEqual({ code: 1007 })
  })

  it('lets go a connection that never says hello', async () => {
    const data = mkdtempSync(join(tmpdir(), 'bd-server-'))
    dirs.push(data)
    const s = await startServer({ port: 0, host: '127.0.0.1', data, limits: { helloMs: 200 } })
    servers.push(s)
    const quiet = new Client(s.port)
    await quiet.ready()
    await new Promise((r) => setTimeout(r, 500))
    expect(quiet.closed).toBe(true)
  })
})
