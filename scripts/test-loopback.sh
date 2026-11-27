#!/bin/sh
# pnpm test:loopback <command> [args...]: run a test command where nothing can
# leave this machine. It enters a fresh network namespace with only loopback up,
# maps back to your own uid and gid so files keep their owner, and drops the
# proxy, token, askpass, CA and injected git config variables the server's test
# setup drops (docs/child-processes.md#test-environment). Linux only; it refuses
# to run where it cannot build that namespace.
#
#   pnpm test:loopback pnpm --filter @assistant/server exec vitest run src/relay/gitCredentialGit.test.ts
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: pnpm test:loopback <command> [args...]" >&2
  exit 2
fi
if [ "$(uname -s)" != Linux ]; then
  echo "test:loopback needs Linux network namespaces" >&2
  exit 2
fi

uid=$(id -u)
gid=$(id -g)
exec unshare --user --map-root-user --net -- sh -c '
  set -eu
  uid=$1 gid=$2
  shift 2
  ip link set lo up
  if ip -o link show | grep -qv ": lo:"; then
    echo "test:loopback: an interface other than lo is visible; refusing" >&2
    exit 3
  fi
  exec unshare --user --map-user="$uid" --map-group="$gid" -- env \
    -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    -u http_proxy -u https_proxy -u all_proxy \
    -u NODE_USE_ENV_PROXY -u GIT_PROXY_COMMAND \
    -u GITHUB_TOKEN -u GH_TOKEN \
    -u GIT_ASKPASS -u SSH_ASKPASS -u SSH_AUTH_SOCK \
    -u NODE_EXTRA_CA_CERTS -u SSL_CERT_FILE -u SSL_CERT_DIR -u CURL_CA_BUNDLE \
    -u GIT_SSL_CAINFO -u GIT_SSL_CAPATH -u GIT_SSL_NO_VERIFY \
    -u NODE_TLS_REJECT_UNAUTHORIZED \
    -u GIT_CONFIG_PARAMETERS -u GIT_CONFIG_COUNT \
    GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 NO_PROXY="*" no_proxy="*" \
    "$@"
' test-loopback "$uid" "$gid" "$@"
