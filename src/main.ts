#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { JoinPolicy, MemberRole } from './shared/session-wire.ts'
import { startServer } from './server.ts'

/**
 * `bookdelver-server`: the reference server's command line
 * (docs/proposals/self-hosted-servers.md, section 1, "Running it"; this
 * package's README).
 *
 *   bookdelver-server [serve] --data ./bookdelver-data --url wss://tables.example.net
 *   bookdelver-server invite --data ./bookdelver-data --url … [--uses 10] [--hours 168]
 *
 * Every flag has an environment variable beside it (`BOOKDELVER_URL`, …).
 */

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string' },
    url: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    name: { type: 'string' },
    notice: { type: 'string' },
    join: { type: 'string' },
    cert: { type: 'string' },
    key: { type: 'string' },
    uses: { type: 'string' },
    hours: { type: 'string' },
    role: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

const env = process.env
const pick = (flag: string | undefined, name: string) => flag ?? env[`BOOKDELVER_${name}`]

if (values.help === true) {
  console.log(readFileSync(new URL('../README.md', import.meta.url), 'utf8'))
  process.exit(0)
}

const command = positionals[0] ?? 'serve'
const data = resolve(pick(values.data, 'DATA') ?? './bookdelver-data')
const join = pick(values.join, 'JOIN') ?? 'invite'
if (join !== 'invite' && join !== 'open') {
  console.error('--join is invite or open')
  process.exit(2)
}
const cert = pick(values.cert, 'CERT')
const key = pick(values.key, 'KEY')
const url = pick(values.url, 'URL')

const server = await startServer({
  // The `invite` command opens no port anyone reaches: this machine, any free one.
  port: command === 'invite' ? 0 : Number(pick(values.port, 'PORT') ?? 8787),
  ...(command === 'invite'
    ? { host: '127.0.0.1' }
    : pick(values.host, 'HOST') === undefined
      ? {}
      : { host: pick(values.host, 'HOST')! }),
  data,
  ...(url === undefined ? {} : { url }),
  ...(pick(values.name, 'NAME') === undefined ? {} : { name: pick(values.name, 'NAME')! }),
  ...(pick(values.notice, 'NOTICE') === undefined
    ? {}
    : { notice: pick(values.notice, 'NOTICE')! }),
  join: join as JoinPolicy,
  ...(cert !== undefined && key !== undefined
    ? { tls: { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') } }
    : {}),
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
})

if (command === 'invite') {
  const role = (values.role ?? 'author') as MemberRole
  const uses = Number(values.uses ?? 1)
  const hours = values.hours === undefined ? undefined : Number(values.hours)
  console.log(server.invite(role, uses, hours))
  await server.close()
  process.exit(0)
}

if (command !== 'serve') {
  console.error(`Unknown command: ${command} (serve, invite)`)
  process.exit(2)
}

console.log(`Bookdelver server on port ${server.port}, data in ${data}`)
console.log(`Invites point at ${server.url}`)
if (url === undefined) {
  console.log('No --url given: invites reach only this machine (ws://localhost).')
}
const owner = server.ownerInvite()
if (owner !== undefined) {
  console.log('\nThe owner invite: paste it in the app (Homebrew > Servers > Paste invite).')
  console.log('Whoever uses it first owns this server.\n')
  console.log(owner)
  console.log('')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0))
  })
}
