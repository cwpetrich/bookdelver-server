import { lookup } from 'node:dns/promises'
import { connect as tlsConnect } from 'node:tls'
import { WebSocket } from 'ws'
import { addressProblem, isSession, readFromServer } from './shared/session-wire.ts'

/**
 * `bookdelver-server doctor` (docs/proposals/self-hosted-servers.md, section
 * 1, "HTTPS, and reaching a home server"; slice SH4): the setup checked from
 * the host's machine, against the address its invites carry and nothing
 * else.
 *
 * 1. **The address** is one the app connects to: `wss://`, or `ws://` on this
 *    machine.
 * 2. **Its name resolves.**
 * 3. **Its certificate is valid for that name** (`wss://` only).
 * 4. **A WebSocket opens and answers `hello`**: a hello with a fresh secret
 *    and no name, which a server refuses (`secret` or `invite`) without
 *    keeping anything. Any session answer shows a Bookdelver server is there.
 */

export interface Check {
  what: string
  ok: boolean
  /** What was found, or what to do. */
  said: string
}

/** The host's name and port in an address. */
function parts(address: string): { secure: boolean; host: string; port: number } {
  const m = /^(wss?):\/\/([^/:]+|\[::1\])(?::(\d+))?/i.exec(address)!
  const secure = m[1]!.toLowerCase() === 'wss'
  return {
    secure,
    host: m[2]!.replace(/^\[|\]$/g, ''),
    port: m[3] === undefined ? (secure ? 443 : 80) : Number(m[3]),
  }
}

/** The checks, in order; each one after a failure is skipped. `ms`: how long each may take. */
export async function doctor(address: string, ms = 8_000): Promise<Check[]> {
  const out: Check[] = []
  const problem = addressProblem(address)
  out.push({
    what: 'The address',
    ok: problem === undefined,
    said:
      problem ??
      (/^wss:/i.test(address) ? 'wss://, as the app needs' : 'ws://, on this machine only'),
  })
  if (problem !== undefined) return out
  const { secure, host, port } = parts(address)

  try {
    const found = await lookup(host)
    out.push({ what: 'Its name', ok: true, said: `${host} is ${found.address}` })
  } catch {
    out.push({
      what: 'Its name',
      ok: false,
      said: `${host} doesn’t resolve: check its DNS record, or your tunnel’s name`,
    })
    return out
  }

  if (secure) {
    const cert = await new Promise<Check>((resolve) => {
      const socket = tlsConnect({ host, port, servername: host, timeout: ms })
      const done = (c: Check) => {
        socket.destroy()
        resolve(c)
      }
      socket.once('secureConnect', () => {
        const peer = socket.getPeerCertificate()
        done(
          socket.authorized
            ? {
                what: 'Its certificate',
                ok: true,
                said: `valid for ${host}${peer.valid_to === undefined ? '' : `, until ${peer.valid_to}`}`,
              }
            : {
                what: 'Its certificate',
                ok: false,
                said: `not trusted for ${host}: ${String(socket.authorizationError)}`,
              },
        )
      })
      socket.once('error', (error) =>
        done({
          what: 'Its certificate',
          ok: false,
          said: `no HTTPS answer on port ${port}: ${error.message}`,
        }),
      )
      socket.once('timeout', () =>
        done({ what: 'Its certificate', ok: false, said: `no answer on port ${port} in time` }),
      )
    })
    out.push(cert)
    if (!cert.ok) return out
  }

  const answer = await new Promise<Check>((resolve) => {
    let settled = false
    const ws = new WebSocket(address, { handshakeTimeout: ms })
    const done = (c: Check) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.terminate()
      resolve(c)
    }
    const timer = setTimeout(
      () =>
        done({
          what: 'A Bookdelver server',
          ok: false,
          said: 'the connection opened, but nothing answered hello',
        }),
      ms,
    )
    ws.on('open', () => {
      const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
      ws.send(JSON.stringify({ sv: 1, t: 'hello', build: 'doctor', secret }))
    })
    ws.on('message', (data) => {
      let value: unknown
      try {
        value = JSON.parse(String(data))
      } catch {
        return
      }
      if (!isSession(value)) return
      const read = readFromServer(value)
      if (!('ok' in read)) return
      const m = read.ok
      done({
        what: 'A Bookdelver server',
        ok: true,
        said:
          m.t === 'server'
            ? `answers as “${m.name}”`
            : m.t === 'refuse'
              ? `answers (it asks a newcomer for ${m.reason === 'invite' ? 'an invite' : 'a known secret'}, as it should)`
              : 'answers',
      })
    })
    ws.on('error', (error) =>
      done({
        what: 'A Bookdelver server',
        ok: false,
        said: `no WebSocket there: ${error.message}`,
      }),
    )
  })
  out.push(answer)
  return out
}

/** The checks as lines for a terminal. */
export function doctorLines(checks: readonly Check[]): string[] {
  return checks.map((c) => `${c.ok ? 'OK  ' : 'FAIL'} ${c.what}: ${c.said}`)
}
