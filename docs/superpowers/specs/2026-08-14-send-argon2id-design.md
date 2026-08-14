# `knowl send` — Argon2id derivation, and the rest of issue #102

Status: accepted, 2026-08-14. Supersedes the derivation section of
[`2026-08-13-send-receive-cli-design.md`](2026-08-13-send-receive-cli-design.md); everything else
in that document stands.

## The gap

The code is five BIP-39 words, about 2⁵⁵. Both the mailbox id and the sealing key come off it
through HKDF-SHA256 — which is fast by design, because that is what a KDF for an already-strong
key is for.

Given a database snapshot, a serious GPU rig enumerates 2⁵⁵ against stored mailbox ids in
hours-to-days: **inside a mailbox's own 24–72 hour lifetime**. The cheap KDF then yields the
sealing key from the same code, so the ciphertext goes with the id.

The original reasoning is correct as far as it goes — a drop box can be ground offline, unlike an
interactive SPAKE2 exchange, so the entropy has to live in the code. What it did not account for
is that **2⁵⁵ is only expensive if each guess is expensive.**

Bitwarden Send, Yopass and ffsend are structurally immune: their keys are 128 *random* bits in a
URL fragment, derived from nothing. We took a human-typed code instead, which is the right product
call — and is exactly why the entropy has to be defended rather than assumed sufficient.

## The derivation

### One memory-hard pass, then a cheap split

```
master = Argon2id(normalizeCode(code), salt "knowl-send:v2", m=64 MiB, t=3, p=1) → 32 bytes
id     = hex( HKDF-SHA256(master, "knowl-send:id:v2",  16) )
key    =      HKDF-SHA256(master, "knowl-send:key:v2", 32)
```

The issue reads as two Argon2id calls, one per domain string. It is one, and the difference is
free: **an attacker grinding the codespace against stored mailbox ids only ever needs the id
derivation.** They compute one Argon2id per guess under either construction. Two separate calls
cost the honest client double and the attacker nothing — 1.2 s instead of 0.6 s per send on Node
24, 2.8 s instead of 1.4 s on Node 22.

The versioned domain strings survive as the HKDF labels, which is where they do their work. `id`
still cannot disclose `key`: `id` is a 16-byte HKDF output over a 256-bit master, so recovering
`master` from the public id is the same infeasible step the v1 design already relied on.

### Parameters, and why these

`m=64 MiB, t=3, p=1` — measured at **603 ms** on the developer machine via the built-in, which is
the middle of the 0.5–1 s the issue asks for. At 64 MiB per guess, 2⁵⁵ stops being economical for
a large rig, which is the entire point of the change.

`p=1` deliberately: parallelism helps a defender with cores to spare and helps an attacker with
thousands, and a CLI deriving one key has nothing to parallelise.

The salt is a fixed published constant, for the same reason it was in v1 — there is no per-user
salt two humans can agree on out of band, and the code carries all the entropy. Its job is domain
separation, and the `:v2` in it is what keeps a v2 master from ever colliding with a v3 one.

### The backend

`crypto.argon2Sync` when it exists (Node ≥ 24.7), `@noble/hashes` argon2id otherwise.

The repository treats a package added for ten lines as a supply-chain surface added for ten lines,
and the honest accounting is that this one is not for ten lines — it is the only way to keep the
declared `engines: node >=22` floor while shipping a memory-hard KDF. `@noble/hashes` is audited,
has zero dependencies of its own, and its argon2id was verified byte-identical to Node's before it
was chosen. A test pins that equality on any runtime that has both, so the fallback cannot drift
into deriving a different key from the same code.

Rejected: bumping `engines` to `>=24.7` (drops Node 22 LTS, supported until April 2027, for every
knowl user and needs a major); noble everywhere (1380 ms on a runtime with a 603 ms implementation
sitting in its standard library); `scryptSync` (memory-hard and dependency-free, but not Argon2id,
weaker against time-memory trade-off, and with no precedent in this tool class).

## Staying compatible with v1

### The receiver tries v2, then v1

**The id is the lookup key, so the receiver has to choose a derivation before it can read
anything.** No amount of self-description inside the bundle helps, because the bundle is only
reachable once the id is already known.

So: derive the v2 id and peek; on a miss, derive the v1 id and peek again. One round trip for a v2
bundle, two for a v1 bundle or a mistyped code. No change to the code format, no change to the
server, and a 5.1.0 sender keeps working against a 5.2.0 receiver indefinitely — which matters,
because 5.1.0 clients stay in the wild long after the last v1 bundle expires.

Rejected: a version marker inside the code (changes what a human reads aloud, and `normalizeCode`
splitting on `-` makes a prefix token fragile); sending both candidate ids in one request (needs a
server change, and the issue's premise is that the server needs none); dropping v1 outright (a
5.1.0 sender and an upgraded receiver would fail silently, forever).

### The version byte is a cross-check, not the discriminator

Because the version is already established by *which id hit*, the byte in the bundle does a
narrower job than "self-describe the derivation" suggests — and it is worth keeping anyway, as the
thing that makes `unseal` assert rather than assume.

```
v2:  0x02 || nonce(12) || ciphertext || tag(16)      AAD = 0x02
v1:          nonce(12) || ciphertext || tag(16)      no AAD
```

**Bound as GCM additional authenticated data, not merely prefixed.** A prefix a receiver reads and
trusts is a byte an attacker can flip to steer the key schedule; AAD makes flipping it fail the
tag. `unseal(sealed, code, version)` takes the version explicitly from the peek that succeeded and
checks the prefix agrees with it.

A version byte could not have been the discriminator regardless: a v1 bundle opens with a random
nonce, whose first byte is `0x02` once in 256.

### Deriving once per command

`previewSend` returns the resolved `{ preview, mailboxId, version }` and `receiveKnowledge` takes
it, rather than each deriving from the code independently. Without that, `knowl cloud receive`
pays for four Argon2id passes — peek v2, peek v1, claim v2, claim v1 — where one will do.

Threaded explicitly rather than memoised in a module-level cache: a process-lifetime map keyed by
code, holding sealing keys, is a worse artefact than an extra function parameter.

## The rest of #102

### Unknown `reason` strings degrade to the server's message

`SendRefusal` gains `conflict` and `rate_limited` and stops being a closed union.

**This is a live bug, not future-proofing.** knowl-cloud v0.7.0 returns `rate_limited` for a full
outbox today; the shipped 5.1.0 client's message map has no such key, so a sender at their quota
is told "No bundle waiting on that code." Anything unrecognised now falls through to the `message`
the server sent, so a future addition degrades to showing the truth rather than a wrong answer.

### `--list` and `--revoke`

`GET /v1/send` and `DELETE /v1/send/:id`, both live since knowl-cloud v0.7.0.

`--list` is a **detection** surface before it is a convenience: a bundle the sender never handed
off showing `claimedAt` is the tamper-evidence signal for a leaked or guessed code, and is printed
as that rather than as a column.

The listed ids are opaque to the sender — codes are never stored, which is deliberate and stays
that way — so `--revoke` accepts **either** a mailbox id copied from the list **or** the code
itself, resolving a code through the same v2-then-v1 walk the receiver uses.

### The optional sixth word

`--words 6` takes the code to 2048⁶ ≈ 2⁶⁶. Default stays 5.

Cheap alongside Argon2id and pointless instead of it: the reason 2⁵⁵ was reachable was the cost
per guess, and a sixth word buys 11 bits against an attack that Argon2id makes uneconomic outright.
Nothing downstream changes — the derivation's output width is fixed, so the server never learns
how long the code was.

## Testing

The properties that matter, in the layer only this repository can check:

- Both Argon2id backends return identical bytes, skipped where only one exists.
- A v2 bundle round-trips; a v1 bundle still round-trips under the v1 derivation.
- A flipped version byte throws rather than selecting another key schedule.
- A wrong code throws rather than returning plausible noise for `importKnowledge` to write.
- The v2 id is 32 lowercase hex — the width the server's contract accepts.
- A six-word code generates six words and derives without special-casing.
- An unknown `reason` string reaches the user as the server's own message.

Argon2id at 64 MiB is ~0.6–1.4 s per call, so cases that derive are kept few and deliberate. The
suite's 30 s timeout covers them.
