# Security Policy

## Reporting a vulnerability

Email **marc.hyett@gmail.com** with the details. Please do **not** open a
public GitHub issue for security-related reports.

Acknowledgement within five business days. If the issue is confirmed,
a fix and a coordinated disclosure window will be agreed before any
public write-up.

## Scope

The following components are in scope:

- The CLI and GitHub Action under `src/`, `dist/`, `action.yml`.
- The reviewer web app under `web/` (auth handling, the test-mode bypass
  route at `web/src/app/api/test-bootstrap/`, and the bypass logic in
  `web/src/lib/bypass.ts`).
- The bundled demo at `examples/todo-app/` is intentionally minimal and
  exists only as a self-test target — out of scope.

## Notes on the test-mode bypass

`/api/test-bootstrap` mints a session cookie via a signed time-bound URL.
The full threat model and defence layers are documented inline in
`web/src/lib/bypass.ts`. If you find a way to:

- Mint a session without a valid HMAC,
- Extend a bypass session past the 30-minute server-side cap,
- Bypass the redirect allowlist (only `/` and `/r/<owner>/<repo>` are
  permitted),
- Distinguish a probe of the route from a 404 on a non-existent path,

please report it. The intended worst-case from a fully leaked bypass session
is "read the same data anyone with a fine-grained read-only PAT for the one
allowlisted repo could read" — anything that exceeds that is in scope.

## Supported versions

Only the latest published commit on `main` is supported. There are no
maintained release branches.
