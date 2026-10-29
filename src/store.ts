import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { JoinPolicy, MemberRole, ReportReason } from './shared/session-wire.ts'
import type { RelayEntry } from './shared/relay-wire.ts'
import type { LibraryKind } from './shared/library-wire.ts'

/**
 * The data folder (docs/proposals/self-hosted-servers.md, section 1, "Running
 * it"): plain files, so a backup is a copy of the folder.
 *
 * - `server.json`: the settings, the members (each secret kept only as its
 *   SHA-256) and the invites. Read and written whole on each change, so the
 *   `invite` command and a running server never undo each other.
 * - `rooms/<code>.jsonl`: an open room, a line for its start (setup and
 *   players) and a line for each entry, appended as it comes; deleted when
 *   the room closes.
 *
 * Every whole write goes to a temporary file that's then renamed: a pulled
 * plug never leaves half a file.
 */

export const SERVER_FORMAT = 'bookdelver-server'
export const SERVER_VERSION = 1

export interface StoredMember {
  id: string
  name: string
  role: MemberRole
  /** The SHA-256 of the member's secret, hex: the secret itself is never kept. */
  secret: string
  /** When they joined, by the server's clock (ms). */
  joined: number
  /** The invite they came by, if any. */
  invite?: string
  /** Banned (SH2): their secret is refused here, and their invites were revoked. */
  banned?: true
}

export interface StoredInvite {
  id: string
  /** The SHA-256 of the invite's secret, hex. */
  hash: string
  role: MemberRole
  /** Uses left. */
  uses: number
  /** When it stops working (ms); none, never. */
  expires?: number
  /**
   * The owner invite's own secret, kept until it's used so each start can
   * print it again: the one secret the folder holds, and only until then.
   */
  secret?: string
  /** The member who made it (SH2); none, the command line. */
  by?: string
}

/** A report a member made (SH2): for the host's inbox. */
export interface StoredReport {
  id: string
  /** The reporter's member id. */
  by: string
  member?: string
  room?: string
  /** A library entry reported (SH3). */
  entry?: string
  reason: ReportReason
  at: number
}

export interface ServerFile {
  format: typeof SERVER_FORMAT
  version: typeof SERVER_VERSION
  name: string
  notice: string
  join: JoinPolicy
  members: StoredMember[]
  invites: StoredInvite[]
  /** Reports for the host's inbox (SH2); a file from before has none. */
  reports: StoredReport[]
}

/** A secret's SHA-256, hex. */
export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex')

/** A new secret: 32 random bytes, base64url (43 characters). */
export const newSecret = () => randomBytes(32).toString('base64url')

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** `n` characters of the share codes' alphabet, at random. */
export function newCode(n: number): string {
  const bytes = randomBytes(n)
  let out = ''
  for (const b of bytes) out += ALPHABET[b & 31]
  return out
}

function writeWhole(path: string, text: string) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

/** The data folder at `dir`, made if it isn't there. */
export class DataFolder {
  readonly dir: string
  readonly rooms: string

  constructor(dir: string) {
    this.dir = dir
    this.rooms = join(dir, 'rooms')
    mkdirSync(this.rooms, { recursive: true })
  }

  get serverPath() {
    return join(this.dir, 'server.json')
  }

  /** `server.json`, or one made from `fresh` on the first start. Throws when it won't read. */
  read(fresh: () => ServerFile): ServerFile {
    if (!existsSync(this.serverPath)) {
      const made = fresh()
      writeWhole(this.serverPath, JSON.stringify(made, null, 2))
      return made
    }
    const value = JSON.parse(readFileSync(this.serverPath, 'utf8')) as unknown
    const file = readServerFile(value)
    if (file === undefined) throw new Error(`${this.serverPath} doesn’t read as a server’s file`)
    return file
  }

  /** `server.json` changed by `edit`, read fresh first and written whole. */
  update<T>(fresh: () => ServerFile, edit: (file: ServerFile) => T): T {
    const file = this.read(fresh)
    const out = edit(file)
    writeWhole(this.serverPath, JSON.stringify(file, null, 2))
    return out
  }

  private roomPath(room: string) {
    return join(this.rooms, `${room}.jsonl`)
  }

  /** An opened room's start, written afresh: its first line. */
  startRoom(room: string, start: RoomStartLine) {
    writeWhole(this.roomPath(room), `${JSON.stringify(start)}\n`)
  }

  /** An entry, appended. */
  addEntry(room: string, entry: RelayEntry) {
    appendFileSync(this.roomPath(room), `${JSON.stringify(entry)}\n`)
  }

  dropRoom(room: string) {
    rmSync(this.roomPath(room), { force: true })
  }

  /** The rooms kept, each read back; a file that doesn't read is left aside (renamed). */
  keptRooms(): { start: RoomStartLine; log: RelayEntry[] }[] {
    const out: { start: RoomStartLine; log: RelayEntry[] }[] = []
    for (const name of readdirSync(this.rooms)) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(this.rooms, name)
      try {
        const lines = readFileSync(path, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
        const start = JSON.parse(lines[0]!) as RoomStartLine
        const log = lines.slice(1).map((l, seq) => ({ ...(JSON.parse(l) as RelayEntry), seq }))
        if (typeof start.room !== 'string' || `${start.room}.jsonl` !== name) throw new Error()
        out.push({ start, log })
      } catch {
        renameSync(path, `${path}.unreadable`)
      }
    }
    return out
  }
}

/** A room's first line in its file. */
export interface RoomStartLine {
  room: string
  build: string
  title: string
  setup: unknown
  players: string[]
  host: number
  /** Its members' places, by player (who took each), so a seat stays a person's after a restart. */
  owners: (string | null)[]
  /** When anything last happened in it (ms). */
  active: number
}

const ROLE_SET = new Set(['owner', 'moderator', 'author', 'member'])
const REASONS = new Set(['offensive', 'cheating', 'spam', 'other'])

/** A server's file read back, checked field by field, or undefined. */
export function readServerFile(value: unknown): ServerFile | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v.format !== SERVER_FORMAT || v.version !== SERVER_VERSION) return undefined
  if (typeof v.name !== 'string' || typeof v.notice !== 'string') return undefined
  if (v.join !== 'invite' && v.join !== 'open') return undefined
  if (!Array.isArray(v.members) || !Array.isArray(v.invites)) return undefined
  const members: StoredMember[] = []
  for (const m of v.members as Record<string, unknown>[]) {
    if (typeof m !== 'object' || m === null) return undefined
    const { id, name, role, secret, joined, invite, banned } = m
    if (typeof id !== 'string' || typeof name !== 'string' || typeof secret !== 'string') {
      return undefined
    }
    if (!ROLE_SET.has(role as string) || typeof joined !== 'number') return undefined
    members.push({
      id,
      name,
      role: role as MemberRole,
      secret,
      joined,
      ...(typeof invite === 'string' ? { invite } : {}),
      ...(banned === true ? { banned: true as const } : {}),
    })
  }
  const invites: StoredInvite[] = []
  for (const i of v.invites as Record<string, unknown>[]) {
    if (typeof i !== 'object' || i === null) return undefined
    const { id, hash, role, uses, expires, secret, by } = i
    if (typeof id !== 'string' || typeof hash !== 'string' || typeof uses !== 'number') {
      return undefined
    }
    if (!ROLE_SET.has(role as string)) return undefined
    invites.push({
      id,
      hash,
      role: role as MemberRole,
      uses,
      ...(typeof expires === 'number' ? { expires } : {}),
      ...(typeof secret === 'string' ? { secret } : {}),
      ...(typeof by === 'string' ? { by } : {}),
    })
  }
  const reports: StoredReport[] = []
  for (const x of (Array.isArray(v.reports) ? v.reports : []) as Record<string, unknown>[]) {
    if (typeof x !== 'object' || x === null) return undefined
    const { id, by, member, room, entry, reason, at } = x
    if (typeof id !== 'string' || typeof by !== 'string' || typeof at !== 'number') return undefined
    if (!REASONS.has(reason as string)) return undefined
    reports.push({
      id,
      by,
      reason: reason as ReportReason,
      at,
      ...(typeof member === 'string' ? { member } : {}),
      ...(typeof room === 'string' ? { room } : {}),
      ...(typeof entry === 'string' ? { entry } : {}),
    })
  }
  return {
    format: SERVER_FORMAT,
    version: SERVER_VERSION,
    name: v.name,
    notice: v.notice,
    join: v.join,
    members,
    invites,
    reports,
  }
}

// ---------------------------------------------------------------------------
// The library (SH3): `library/index.json`, and each version's code as its own
// file, `library/<entry>/<version>.txt`, one code a file.

/** A version kept: its number, when it came, its content's id, and its listing. */
export interface StoredVersion {
  v: number
  at: number
  content: string
  title: string
  intro: string
  author: string
  sort: string
  cols?: number
  rows?: number
  seats?: number
}

/** An entry: whose, its kind, and its versions kept, oldest first. */
export interface StoredEntry {
  id: string
  kind: LibraryKind
  by: string
  versions: StoredVersion[]
}

export interface LibraryIndex {
  format: 'bookdelver-library'
  version: 1
  entries: StoredEntry[]
}

export class LibraryFolder {
  readonly dir: string

  constructor(data: string) {
    this.dir = join(data, 'library')
    mkdirSync(this.dir, { recursive: true })
  }

  private get indexPath() {
    return join(this.dir, 'index.json')
  }

  read(): LibraryIndex {
    if (!existsSync(this.indexPath))
      return { format: 'bookdelver-library', version: 1, entries: [] }
    const value = JSON.parse(readFileSync(this.indexPath, 'utf8')) as LibraryIndex
    if (value.format !== 'bookdelver-library' || !Array.isArray(value.entries)) {
      throw new Error(`${this.indexPath} doesn’t read as a library`)
    }
    return value
  }

  write(index: LibraryIndex) {
    writeWhole(this.indexPath, JSON.stringify(index))
  }

  private codePath(entry: string, v: number) {
    return join(this.dir, entry, `${v}.txt`)
  }

  putCode(entry: string, v: number, code: string) {
    mkdirSync(join(this.dir, entry), { recursive: true })
    writeWhole(this.codePath(entry, v), code)
  }

  code(entry: string, v: number): string | undefined {
    try {
      return readFileSync(this.codePath(entry, v), 'utf8')
    } catch {
      return undefined
    }
  }

  dropVersion(entry: string, v: number) {
    rmSync(this.codePath(entry, v), { force: true })
  }

  dropEntry(entry: string) {
    rmSync(join(this.dir, entry), { recursive: true, force: true })
  }
}
