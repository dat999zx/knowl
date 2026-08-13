# `knowl send` / `knowl receive` — the client half

Status: accepted, 2026-08-13. Server half: knowl-cloud PR #50.

## What this is for

`cloud push` says *everyone on this team should have this, permanently*. `send` says *you,
specifically, right now*. Both are needed and today only the first exists.

The distinction survives knowl #96 removing the default-branch publish gate: push still reaches a
**workspace**, and its unit is the whole team forever. Handing three atoms to one person, once,
with an expiry, is a different act.

## Who can receive

**A Knowl Cloud account, and nothing more.** Not anonymous, and not a shared workspace.

This is a deliberate change to PR #50's premise, which says *"receiving is open because the entire
point is reaching somebody with no account"*. Decision: `8b24a27615914365`. It requires one
server-side change, listed under **Server changes** below.

Same-workspace was considered and rejected: `cloud push` already reaches that audience, so `send`
would have had nothing left to do.

## What the client owns

All of it. The server stores an opaque blob under a client-chosen id and can validate none of the
properties below — a client that sealed weakly, or not at all, passes every test in PR #50. That
asymmetry is why this document exists.

### The code

**Five words from the BIP-39 English list**, joined with `-`. 2048⁵ ≈ 2⁵⁵.

BIP-39 rather than a hand-rolled list because it is designed for exactly this: no two words share
a four-letter prefix, no plurals-of-each-other, and it is already audited by more people than will
ever read this repository. Shipped as a source module (~13 KB), not fetched.

The entropy is retained **even though auth now bounds guessing**. Requiring an account makes
grinding rate-limited (300/min per caller) and attributable, which removes the anonymous
distributed guesser the 2⁵⁵ was sized for. So the code is stronger than it now needs to be — which
is the right direction for a property that is expensive to add back, and it survives auth being
relaxed later.

Generated with `randomInt` per word, never `Math.random`.

### Deriving the id and the key from one code

Both come from the code, so the derivation must not let the id disclose the key. `hkdfSync`
(SHA-256) with distinct `info` labels, which is the standard construction for exactly this:

```
mailboxId = hex( HKDF(code, salt, "knowl-send:id:v1",  16) )
key       =      HKDF(code, salt, "knowl-send:key:v1", 32)
```

`salt` is a fixed published constant, not a secret: there is no per-user salt to agree on out of
band, and the code itself carries the entropy.

PR #50's body says `mailbox_id = sha256(code)`. That is also safe — SHA-256 is one-way, so the id
does not leak the key — but two labelled HKDF outputs state the independence rather than relying
on the reader to notice it. The server stores whatever id it is given, so this is a client-side
choice with no contract impact.

### Sealing

**AES-256-GCM** from `node:crypto`. No dependency: this repository treats a package added for ten
lines as a supply-chain surface added for ten lines, and `hkdfSync`, `randomBytes` and
`aes-256-gcm` are all present.

Wire format, then base64 for transport:

```
nonce(12) || ciphertext || tag(16)
```

The nonce is random per send. Key reuse across sends cannot happen — the key derives from a
freshly generated code every time.

## What the client does NOT own

Provenance, and that is already solved. `importKnowledge` stamps arriving rows with
`import:<workspace>/<repo>`, a value no repo name can equal because a repo name matches
`^[a-z0-9][a-z0-9-]*$`. `promoteItems`, `assertOwnedItem` and `backfillOriginRepo` already treat
such a value as foreign, so **received atoms cannot be promoted or published as this repo's own**
without anybody writing new policy. Provenance laundering — the risk named in the contributor's
design doc — is structurally prevented by machinery that predates this feature.

This is the reason the receive half is small.

## The two verbs

Both are thin. The payload is an export file and the merge is an import.

```
knowl send [--query <text> | --id <ids...> | --category <list>] [--expires-in <hours>]
  → selects atoms, exportKnowledge to a temp file, seal, POST /v1/send
  → prints the code, and only the code, for the human to hand over

knowl receive <code>
  → derive id, GET /v1/send/:id for the preview, show sender and count
  → confirm, POST /v1/send/:id to claim, unseal, importKnowledge
```

Selection is deliberately split, because the two flag families answer different questions:

- `--id` and `--category` go through `selectOwnedItems`, the same path `cloud stage` uses, so the
  two sharing verbs agree about what is yours to share.
- `--query` runs `queryKnowledgeForAgent` and sends the hits. This is the flag the motivating
  incident needed — *"I couldn't get pricing research to a teammate"* — and it is the one that
  makes `send` usable without knowing ids.

`--query` prints what it matched and asks before sealing. A retrieval-shaped selection is a fuzzy
one, and sending the wrong three atoms to a colleague is not recoverable by an expiry.

Receiving into a project is required — `importKnowledge` needs a project id — and the command
refuses outside one rather than inventing a store.

The preview before the claim is what makes `[a]ccept / [s]elect / [r]eject` possible without
spending the single claim. `peekMailbox` exists for this and does not consume the bundle.

## Server changes

One, in knowl-cloud:

- `GET|POST /v1/send/:id` gains `preHandler: requirePrincipal`. Membership is deliberately **not**
  checked — cross-workspace sending is the point.

Everything else in PR #50 stands, including the sealing it cannot verify.

## Testing

- **Round trip through the real primitives**: generate a code, seal an export, unseal it, assert
  byte-for-byte equality. No mocked crypto.
- **The id does not disclose the key**: derive both from one code and assert they differ and that
  neither is a prefix of the other. A weak assertion, but it fails loudly if someone "simplifies"
  the two HKDF labels into one.
- **A wrong code fails closed**: unsealing with a different code raises rather than returning
  garbage. This is GCM's job; the test pins that authentication is actually checked.
- **Received atoms are stamped foreign**: import a bundle and assert `isImportedOrigin` on every
  row, then assert `promoteItems` selects none of them.
- **The code never appears in a request**: capture the outbound payloads and assert neither the
  code nor the key is in them. The one property the server cannot check for itself.

## Rejected alternatives

- **A hand-rolled wordlist.** Cheaper to ship, worse in every way that matters — prefix collisions
  and near-homophones are what make a spoken code unreliable, and BIP-39 already solved it.
- **libsodium / `@noble/ciphers`.** Better APIs than `node:crypto`, but a dependency for one
  encrypt and one decrypt, in a repository that pins deliberately.
- **Re-using `cloud push`'s payload shape.** It is workspace-scoped, versioned per atom and built
  to converge replicas. An export file is a snapshot handed over once, which is what this is.
- **A merge/diff UI on receive** (the contributor's v1). Deferred, on his own staging proposal:
  ship transport, see whether anyone sends twice. `importKnowledge` already reconciles.
