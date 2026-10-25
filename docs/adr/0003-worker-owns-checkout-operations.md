---
status: accepted
---

# The Worker owns every checkout operation

Checkouts belong to the account a Worker runs under, so every operation on them
goes through the Worker: git, status, diff, the watcher, served files, worktree
creation and removal, commit and push, including the work the server does on its
own behalf. Each checkout belongs to exactly one Worker at a time. The server's
account then needs no standing grant to the Worker account's files, push uses
whatever credentials the Worker's account holds, and a Worker on another machine
works the same way as a local one.

## Considered options

- **Shared access**: the server's account gets ACL read and write on the
  checkouts and keeps running git itself. Rejected: mixed file ownership,
  `safe.directory` exceptions, push credentials held by the server, and nothing
  that reaches a remote Worker.
- **Hybrid**: the server reads through a read-only ACL and writes go through the
  Worker. Rejected: a standing grant all the same, and the same dead end for
  remote Workers.

## Consequences

Dozens of server modules run git or read checkouts directly. They move behind
one checkout port, in-process first, before any process or account split.
