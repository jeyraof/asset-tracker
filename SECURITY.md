# Security Policy

This repository is a **public** Cloudflare Worker project. Treat every file,
commit message, and git object as world-readable. The rules below are binding for
all future work.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for
anything that could expose credentials, account data, or infrastructure. Use
GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). We aim to acknowledge reports promptly.

## What must never be committed

- Real account identifiers: broker account numbers / external ids (KIS
  `CANO-PRDT`, Kiwoom account numbers, etc.).
- Credentials and secrets of any kind: API keys, app keys/secrets, access
  tokens, relay secrets, admin tokens.
- Real infrastructure details: hostnames, VPS/proxy domains, D1 database ids,
  KV namespace ids, account/zone ids.
- Personal data: emails, names, phone numbers, or anything that identifies a
  person.
- Raw provider responses or database rows copied from production (they contain
  the above).

## How secrets are handled

- Secrets live **only** as Wrangler secrets: `KIS_CREDENTIALS`,
  `KIWOOM_CREDENTIALS`, `KIWOOM_RELAY_SECRET`, `KOREAEXIM_API_KEY`,
  `ADMIN_TOKEN`.
- Locally, secrets go in gitignored files: `.dev.vars`, `.kis-credentials.json`,
  `.kiwoom-credentials.json`, and the token caches.
- `wrangler.jsonc` (D1/KV ids, proxy host) and generated `seeds/*.sql` are
  gitignored. Do not weaken `.gitignore`.
- Never log a full URL that carries a key in the query string (for example the
  Korea Eximbank `authkey`); log the host/path or a masked value only.

## Placeholders and fixtures

- Docs and examples use placeholders only: `<subdomain>`, `example.com`,
  `<8-digit-CANO>`, `<d1-database-id>`, `<RELAY_SECRET>`.
- Tests use obviously fake values (`11111111-01`, `KEY-A`, `TESTKEY`). Never
  paste real values from production.

## Pre-commit checklist

1. Review `git diff --cached`.
2. Scan for account-number, hostname, email, and key-like patterns.
3. Confirm new files are not supposed to be gitignored.

## Incident response

If a secret or PII reaches the repository:

1. **Rotate** the exposed secret/value immediately (issue a new key, revoke the
   old one, update the Wrangler secret).
2. **Purge** it from history (`git filter-repo` or `git filter-branch`) and
   force-push.
3. **Notify** affected parties if required.
4. Treat any value that was pushed as compromised, even if history is rewritten —
   caches, forks, and clones may retain it.
