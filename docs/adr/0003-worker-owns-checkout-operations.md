---
status: accepted
---

# The Worker owns every checkout operation

Checkouts belong to the account agents run as, so every operation on them goes
through the Worker: git, status, diff, the watcher, served files, worktree
creation and removal, commit and push, including the work the server does on its
own behalf today. Each Project's checkouts belong to exactly one Worker at a
time. The `pandeck` account then holds no standing grant into the user's home,
push keeps using the user's SSH keys, and a Worker on another machine works the
same way as a local one.

## Considered options

- **Shared access**: `pandeck` gets ACL read and write on the project
  directories and keeps running git itself. Rejected: mixed file ownership,
  `safe.directory` exceptions, push credentials held by the server, and nothing
  that reaches a remote Worker.
- **Hybrid**: the server reads through a read-only ACL and writes go through the
  Worker. Rejected: a standing grant into the home all the same, and the same
  dead end for remote Workers.

## Consequences

About 46 server modules run git or read checkouts directly. They move behind one
checkout port, in-process first, before any process or account split.
