# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 5.x | Yes |
| < 5.0 | No |

Fixes land on the latest 5.x release. There are no long-term support branches.

## Reporting a vulnerability

Report privately through GitHub's [security advisory
form](https://github.com/dat999zx/knowl/security/advisories/new). Do not open a public
issue for a vulnerability.

Include what you can: the version, the platform, the steps that reproduce it, and what an
attacker gets out of it. A first response should arrive within seven days.

## What Knowl touches

Knowl is a local-first tool. It is worth knowing what it reaches, because that is the
surface worth reporting on.

- **The store is a local SQLite file** at `.knowl/knowl.db` in the project. It holds
  whatever knowledge was written to it, so it inherits the filesystem's permissions and
  nothing stronger.
- **Writes are secret-validated.** Content matching known credential shapes is refused
  rather than stored. A bypass of that check is a vulnerability worth reporting.
- **Skills can execute commands.** `knowl skill run` executes an entrypoint declared in a
  skill manifest, with an allowlisted environment. Only run skills you trust; treat a path
  that runs one without that intent as a vulnerability.
- **The viewer binds to localhost** and is cookie-gated for the local session.
- **Cloud sync is opt-in.** Nothing leaves the machine until a repository is connected, and
  knowledge written with `local: true` is never published.

## Scope

In scope: anything that reads or writes the store outside the documented paths, escapes the
skill sandbox, leaks knowledge marked local, defeats secret validation, or exposes the
viewer beyond localhost.

Out of scope: findings that require an attacker to already have write access to the project
directory or the machine, and reports from automated scanners without a working reproduction.
