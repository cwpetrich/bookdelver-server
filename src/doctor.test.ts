import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { doctor, doctorLines } from './doctor.ts'
import { type RunningServer, startServer } from './server.ts'

/**
 * `bookdelver-server doctor` (SH4): each check against servers started in
 * this process on this machine's free ports, and nothing else.
 */

const servers: RunningServer[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function running() {
  const data = mkdtempSync(join(tmpdir(), 'bd-doctor-'))
  dirs.push(data)
  const s = await startServer({ port: 0, host: '127.0.0.1', data })
  servers.push(s)
  return s
}

/** A port where nothing listens: one taken, then let go. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((r) => probe.close(() => r()))
  return port
}

describe('doctor', () => {
  it('passes a server that answers hello', async () => {
    const s = await running()
    const checks = await doctor(`ws://127.0.0.1:${s.port}`)
    expect(checks.map((c) => [c.what, c.ok])).toEqual([
      ['The address', true],
      ['Its name', true],
      ['A Bookdelver server', true],
    ])
    expect(checks[2]!.said).toMatch(/answers/)
    expect(doctorLines(checks)[0]).toMatch(/^OK {3}The address/)
  })

  it('stops at an address the app won’t reach', async () => {
    const checks = await doctor('ws://tables.example.net')
    expect(checks).toEqual([
      { what: 'The address', ok: false, said: 'This server needs a secure address (wss://)' },
    ])
    expect(doctorLines(checks)[0]).toMatch(/^FAIL The address/)
  })

  it('fails where nothing answers, and where no certificate is', async () => {
    const port = await freePort()
    const none = await doctor(`ws://127.0.0.1:${port}`, 2_000)
    expect(none.at(-1)).toMatchObject({ what: 'A Bookdelver server', ok: false })
    // wss:// to a plain server: no HTTPS there.
    const s = await running()
    const plain = await doctor(`wss://localhost:${s.port}`, 2_000)
    expect(plain.at(-1)).toMatchObject({ what: 'Its certificate', ok: false })
  })
})
