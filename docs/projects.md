# Creating Projects

A Project is a registry record (`projectRegistry.ts`): name, display key,
description, Jira links, and the local paths that make one of its checkouts the
main checkout worktrees branch from. This document covers how one comes into
existence.

## Who creates a Project

- **The user**, in the web UI, directly. A user action needs no confirmation.
- **An agent**, only through `project_create`, which stages an approval card
  (`projectCreate` kind in `pendingApprovals.ts`). The proposal writes nothing;
  approving executes it server-side. `project_registry_write` refuses
  `upsertProject` for an id that does not exist yet and points the agent at
  `project_create`. It still updates, links, clones and archives existing
  Projects directly.

The card is the point: a new Project may also mean a new repository on a hosted
provider and a clone on disk, and the user should see all of that before any of
it happens.

## What approval does

In order, stopping at the first failure:

1. **Repository.** Either
   - _create_ it on GitHub or Forgejo under `owner` (default: the account of the
     configured token; a different owner is treated as an organization), private
     unless the agent asked otherwise, with the provider's README initialization
     (`auto_init`), so it starts with one commit; or
   - _link_ an existing clone URL. When that URL belongs to a configured
     provider (a Forgejo base-path prefix is stripped from HTTPS URLs) and the
     repository has no commits AT APPROVAL, a `README.md` is committed through
     the provider's contents API; what the proposal saw only informs the card.
     The URL must carry no credentials, query or fragment: it is stored and
     shown, and git authenticates through the host's own setup.
2. **Registry.** The Project is registered with the repository's clone URL as
   `repoUrl` (the provider's SSH URL; Forgejo's HTTPS URL when SSH is off).
3. **Clone.** Unless the agent passed `clone: false`, the repository is cloned
   into `settings.projectsRoot/<id>` and that path is registered, making it the
   main checkout.

The proposal is validated before the card exists (id free, key valid, provider
configured, repository name free, clone folder absent). Approval re-checks,
before any remote write, that the id is still free, that the clone folder is
still the one the card shows (the projects root may have changed) and still
absent; the folder is checked once more right before cloning, because the clone
helper reuses any checkout it finds. A failure after step 1 names what already
exists, and the failed card keeps the repository's clone URL, so the agent
finishes with `project_registry_write` instead of creating a second repository.

## Why an empty repository matters

A worktree branches from the main checkout's `HEAD`, and a clone of a repository
with no commits has none. Agents cannot push to a default branch, so before this
flow an empty repository was a dead end they could only report. Created
repositories therefore always carry a commit, linked empty ones get one on
approval, and a clone that is still empty (a URL on no configured provider) is
called out in the card's result. `worktree_create` and Workflow Run start say
"has no commits yet" for such a checkout rather than "not a git repository".
