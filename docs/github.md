# GitHub integration: token permissions

Pandeck stores one GitHub PAT in Settings → GitHub (`github.token`). The same
server-side credential powers GitHub tools, background signals, private GHCR
container pulls, and the package proxy. It is never passed to agent shells or
shown back to the browser; the first-run Assistant collects it through a private
`settings_request_input` card, not chat. Git authentication for repository
`clone`/`push` is separate (for example SSH); a GitHub API PAT does not
configure Git on the host.

## Recommended classic PAT

For the **full** GitHub feature set, create a **personal access token
(classic)**. Pandeck uses APIs and registries that fine-grained PATs do not
fully support, notably GitHub Packages and parts of the Checks API. The
first-run `github_pat_setup_link` tool generates this prefilled link after
asking for the GitHub login:

[Create a Pandeck classic PAT](https://github.com/settings/tokens/new?description=Pandeck&scopes=repo%2Cworkflow%2Cread%3Apackages%2Cnotifications)

| Classic scope   | Why Pandeck offers it                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`          | Private repository access, code search, issues/PRs, project creation, branch/commit and CI operations. This grants **broad read/write access** to repositories the user can access.               |
| `notifications` | Read the user's notification inbox and its daily-scan signals. This is separate from `repo`.                                                                                                      |
| `read:packages` | Download private GHCR images and packages through the package proxy. Not needed if those features are unused.                                                                                     |
| `workflow`      | Add or update `.github/workflows/*` using a PAT-authenticated Git push/API operation. Not needed merely to view or re-run Actions; omit if workflow files will not be changed through this token. |

The URL **preselects** scopes; it does not grant them automatically. Review the
checkboxes, remove optional scopes for features you do not use, set an
expiration, and generate the token in GitHub. No `write:packages`,
`delete:packages`, `delete_repo`, `admin:org`, or `user` scope is required by
these features. If your organization requires SAML SSO authorization, authorize
the PAT for that organization after creating it. Organization policies may
prohibit classic tokens entirely; in that case a fine-grained token may support
**some** repository operations but cannot provide the full integration with one
token. Pandeck currently supports only one GitHub token.

The classic PAT form belongs to the **GitHub account currently signed into the
browser**. Unlike the fine-grained form, its link has no `target_name`
parameter: the username Larry asks for sets the default repository owner and is
checked against the login returned by the connection test; it does not switch
the GitHub account. Check the account shown by GitHub before generating the
token. The Settings → GitHub **Test** calls `/user`, reports the authenticated
login and any scopes GitHub exposes, and checks package-pull readiness. A
successful `/user` result proves authentication, **not** that every repository
or package operation is authorized; missing scope, SSO authorization, repository
rights or organization policy can still cause a later 403.

GitHub recommends repository-restricted fine-grained tokens where their
permissions cover the task. A classic PAT is wider: treat it like a password,
keep it short-lived and revoke it from GitHub if compromised.

## Sources

- [GitHub: Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
  — classic vs fine-grained limitations, expiration and SSO.
- [GitHub: Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
  — `repo`, `notifications`, `read:packages`, and `workflow` scope definitions.
- [GitHub: About permissions for GitHub Packages](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)
  — packages require a classic PAT with `read:packages` to download.
