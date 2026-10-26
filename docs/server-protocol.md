# The Bookdelver server protocol

**Status: normative, pre-release.** The Bookdelver app and the reference
server (`packages/server`) follow this document, and anyone may write
another server from it. Until the first public release it changes in place
with the beta. At release, session protocol 1 and lockstep protocol 2 are
frozen and change only by new versions. The reasoning is in
`docs/proposals/self-hosted-servers.md`.

The readers named here are in `packages/core`. They import nothing of the
game: `relay-wire.ts`, `relay.ts`, `session-wire.ts`, `reader.ts` and
`codec.ts`.

## The connection

- A server is one WebSocket endpoint. The app connects only to a `wss://`
  address, or to `ws://` on the same machine (`localhost`, `127.0.0.1`,
  `[::1]`) for trying a server out (`addressProblem`).
- Every frame is text holding one JSON message of at most 1,000,000
  characters (`WIRE_LIMITS.message`). Both sides measure it before parsing
  it. A binary frame, or one over the cap, closes the connection.
- One connection carries two layers. A message with an `sv` key belongs to
  the **session** layer, and one with a `v` key to the **table** layer
  (`isSession`).
- The first message must be `hello`. Until `server` answers it, the server
  drops anything else.
- **Rate limits** belong to the server. The reference server's limits:
  - It closes a connection that sends more than 100 messages in a second.
  - It refuses a table's proposals past 20 a second with `slow`.

## The session layer: `sv` 1

Every message has `sv: 1` and a type `t`. Each side reads the other's
messages strictly (`readToServer`, `readFromServer`):

- known keys only, and no prototype keys;
- text from 1 character up to its cap, with no control characters and no
  leading or trailing spaces;
- whole numbers within their range.

| A phone sends                             | The server answers                                       |
| ----------------------------------------- | -------------------------------------------------------- |
| `hello { build, secret, invite?, name? }` | `server { name, notice, join, owner, you }`, or `refuse` |
| `rename { name }`                         | `you { you }`, or `refuse { reason: 'name' }`            |
| `tables`                                  | `tables { list }`                                        |
| `table`                                   | `room { room }`: a new table's room code                 |
| `leave { forget }`                        | the connection closes                                    |

- **`secret`**: 32 random bytes, base64url (43 characters), made by the app
  for this server alone. The server keeps only its SHA-256. A secret it
  knows names its member; a new one makes a member when:
  - the server is `open`, or
  - `invite` is a live invite's secret.

  A new member's `name` is required. Otherwise the server refuses with
  `invite` or `secret`.

- **`you`**: `{ id, name, role }`.
  - `id`: 8 characters of the share codes' alphabet.
  - `role`: `owner`, `moderator`, `author` or `member`.
- **`join`**: `invite` or `open`.
- **`owner`**: the owner's name ("Run by …").
- **`notice`**: plain text of up to 280 characters, and may be empty. The app
  never shows it as a link or as rich text.
- **`tables.list`**: up to 50 entries of
  `{ room, title, host, players, free, build, open, you? }` (`you`: the asker's own place at an open table).
- **Refusals** (`SessionRefuse`): `version` (with `want`, the version
  needed), `invite`, `secret`, `name`, `slow`, `garbled`, `full`.
- **`leave { forget: true }`**: the server deletes the member's record.

### Invites

An invite is a code, `bdinv1.<crc32>.<base64url>`, that wraps the JSON
`{ address, invite, name }` (`encodeInvite`, `decodeInvite`). It travels as
text or as a QR code.

The reference server prints the **owner invite** when it first starts.
Whoever brings it is made the owner.

## The table layer: lockstep `v` 2

These are DM9's lockstep messages (`docs/proposals/dm-scenarios.md`, "DM9
as built"), scoped to a room. Every message has `v: 2`, `build` (the app's
version and commit, 1 to 64 characters), `room` (6 characters of the share
codes' alphabet) and `t`.

**A relay reads only the envelope** (`readRelayIn`). That means the kind,
the room, the build, the sequence numbers, and an `open`'s players and
host. It carries the payloads unread: an `open`'s `setup` and a
`propose`'s `input`. It measures them:

- any JSON value nested at most 16 deep;
- no `__proto__`, `constructor` or `prototype` key;
- copied, never kept as received.

Every phone reads every payload strictly (`readToPhone`). An entry whose
input no phone can read is dropped by every phone alike (verdict
`garbled`), so the table goes on.

| A phone sends           | Meaning                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `gather { lobby }`      | The host gathers a table before it opens, and again on each change |
| `sit { name }`          | A phone sits down at a table being gathered                        |
| `claim { seat, take }`  | A player takes a free seat, or leaves one of theirs                |
| `open { setup }`        | The host opens the room. After a lobby, everyone who sat is seated |
| `join { player, have }` | Take player `player`'s place, holding `have` entries               |
| `propose { input }`     | An input for the relay to put in order                             |
| `print { seq, fp }`     | This phone's fingerprint after entry `seq`                         |
| `want { from }`         | The log from entry `from`                                          |
| `bye`                   | Leaving                                                            |

| The relay sends                                 | Meaning                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `lobby { lobby, you }`                          | The table being gathered, to each who sat, with which player they are     |
| `welcome { player, setup, from, log, present }` | Seated: the setup and the log from what the phone holds                   |
| `sync { setup, from, log }`                     | The log asked for                                                         |
| `entry { entry }`                               | `{ seq, from, input }`: an input in order, to every phone, the sender too |
| `print { player, seq, fp }`                     | A phone's fingerprint, passed on                                          |
| `presence { present }`                          | Which players have a phone here                                           |
| `refuse { reason, want }`                       | Turned away. `want` is the room's build (`-` before a room opens)         |

Refusals (`RefuseReason`): `build`, `protocol`, `no-room`, `open`, `taken`,
`player`, `full`, `garbled`, `crowd`, `name`, `slow`, `closed`.

**Rules a relay keeps:**

- A room admits one build: the host's.
- The relay numbers each input from 0 and sends it to every seated phone.
- A room's log holds at most 5,000 entries (`full`).
- **On a server, a seat belongs to a person.** It belongs to the member
  whose connection first took it. That member may take it back from another
  connection, and nobody else may take it (`taken`).
- **A room has a server around it.** Any member may ask for a room code
  (`table`). The room is listed in `tables` while it gathers and while it
  plays. It closes after 24 hours idle. A message to a closed or unknown
  room is refused with `no-room`.

**Rules every phone keeps** (the relay doesn't need them):

- Apply entries only in order, and only at settled points.
- Compare prints with the host's after every entry.
- On a difference, replay from the log once; if it still differs, the
  table is `broken`.
- Only the host sends `control`.
- An entry stamped with this phone's player that it never proposed is
  shown: "This server played a move as you".

## Hidden information

Only hero decisions travel, plus one print per entry. No message, and no
pause, comes from a monster's turn, hidden or seen. Every phone holds the
whole fight, and so does a server's operator, who can read any setup and
log.

## Conformance

A server that passes the conformance suite works with the app
(`packages/server`, `conformance.test.ts`; later `npx … conformance
wss://…`). The suite covers:

- hello: owner, invite, open, refusals;
- a table gathered, opened and played to its end, with the same prints on
  both phones;
- a reconnect replayed on a new connection;
- each refusal;
- the caps.
