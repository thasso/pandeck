# GitHub token

Pandeck holds one GitHub personal access token, `github.token` in Settings →
GitHub. The server uses it for the GitHub agent tools, pull requests and their
checks, notifications and background signals, private GHCR image pulls
(`container-images.md`) and the package proxy (`package-proxy.md`). It is never
passed to agent shells or sent back to the browser.

The token does not authenticate `git clone`, `fetch` or `push`. Those use the
host's own Git credentials (an SSH key, a credential helper), which Pandeck
neither sets up nor reads.

## Which token, and which scopes

Pandeck asks for a **classic** token. Fine-grained tokens cannot read GitHub
Packages, so private image pulls and the package proxy would not work with one.

The scopes live in one list, `GITHUB_CLASSIC_PAT_SCOPES` in
`app/shared/settingsRegistry.ts`, and `GITHUB_CLASSIC_PAT_URL` is GitHub's new
classic token form with them preselected:

<https://github.com/settings/tokens/new?description=Pandeck&scopes=repo%2Cworkflow%2Cread%3Apackages%2Cnotifications>

| Scope           | Why Pandeck asks for it                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`          | Repositories, code search, issues, pull requests (create, review, merge), checks and Actions runs, private ones included. It is broad: read and write access to every repository the account can reach. |
| `workflow`      | Merging a pull request that adds or changes a file under `.github/workflows/`. GitHub refuses that merge to a token without it. Reading and re-running Actions need only `repo`.                        |
| `read:packages` | Pulling private GHCR images and private packages through the package proxy. The connection test reports whether the token has it.                                                                       |
| `notifications` | Reading the user's notification inbox (`github_list_notifications`) and the signals built on it.                                                                                                        |

Nothing needs `read:org`, `admin:org`, `user`, `delete_repo` or any
`write:packages`/`delete:packages` scope. Team review requests are read through
REST `/user/teams`, which `repo` covers (`pull-requests.md`).

The link preselects the scopes; it grants nothing. The user can uncheck one
whose features they will not use, and should set an expiration. A token for an
organization that enforces SAML SSO must be authorized for it afterwards
(Configure SSO on the token's GitHub page). An organization that forbids classic
tokens leaves Pandeck without a token that covers everything; only one token is
supported.

## Which account

A classic token belongs to whichever GitHub account is signed in to the browser
that opens the form. The URL has no account parameter, so the username the user
gives does not choose the account. The connection test (Settings → GitHub
**Test**, or `settings_update` with `test: ["github"]`) calls `/user` and
reports "Authenticated as `<login>`." along with package-pull readiness. A
passing test proves the token authenticates, not that every repository or
package is reachable: a missing scope, SSO authorization or organization policy
still shows up later as a 403.

## Where the link appears

The same URL reaches the user three ways, all from the registry constants:

- guided setup's `github_pat_setup_link` tool, which Larry calls after the user
  gives their GitHub username and whose result lists each scope's purpose
  (`onboarding.md`);
- the `github.token` card that `settings_request_input` raises, which shows the
  link above its private field through the descriptor's `setupLink`, whatever
  the assistant wrote (`settings.md`);
- the Settings → GitHub page's token link.
