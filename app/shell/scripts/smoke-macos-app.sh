#!/usr/bin/env bash
# Launch a built Pandeck.app in local mode and check what the bundled server
# does: it becomes ready under the app, answers only on loopback with auth and
# host checks, keeps its origin and data when the app is replaced, and is gone
# once the app quits. macOS only; CI runs it in the runner's GUI session
# (`.github/workflows/ci.yml`, job `desktop-macos-arm64`).
#
#   smoke-macos-app.sh APP_PATH EVIDENCE_DIR
#
# The app's local data lives under ~/Library/Application Support/<bundle id>,
# so run it only where that is disposable: a CI runner, never a user's Mac.
set -euo pipefail

app=$(cd "$1" && pwd)
evidence=$2
mkdir -p "$evidence"
receipt="$evidence/receipt-ci-gui-session.txt"
: >"$receipt"

plist="$app/Contents/Info.plist"
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")
support="$HOME/Library/Application Support/$bundle_id/local-server"
log="$support/logs/server.log"

note() { echo "[receipt] $*" | tee -a "$receipt"; }
fail() {
  note "FAILED: $*"
  [ -f "$log" ] && tail -n 80 "$log" | sed 's/^/  log| /' | tee -a "$receipt"
  exit 1
}

if [ -e "$support" ]; then
  fail "$support already exists; this smoke needs a clean account"
fi

# Lines already in the log, so each launch reads only its own.
log_mark() { if [ -f "$log" ]; then wc -l <"$log" | tr -d ' '; else echo 0; fi; }

# Wait for this launch's shell verdict: `ready` sets PID and PORT.
wait_for_server() {
  local mark=$1 deadline=$((SECONDS + 150)) line
  while [ $SECONDS -lt $deadline ]; do
    if [ -f "$log" ]; then
      line=$(tail -n +"$((mark + 1))" "$log" | grep -m1 -E '^\[shell\] local server (ready|start failed)' || true)
      case $line in
        *"local server ready: pid "*)
          PID=$(sed -E 's/.*pid ([0-9]+),.*/\1/' <<<"$line")
          PORT=$(sed -E 's/.*127\.0\.0\.1:([0-9]+).*/\1/' <<<"$line")
          return 0
          ;;
        *"start failed"*)
          FAILURE=$line
          return 1
          ;;
      esac
    fi
    sleep 1
  done
  FAILURE="no verdict from the shell within 150s"
  return 1
}

app_pid() { pgrep -n -f "^$1/Contents/MacOS/$executable" || true; }

status_of() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" || echo 000
}

check_server() {
  local where=$1
  local command parent listen
  command=$(ps -o command= -p "$PID" || true)
  case $command in
    "$where/Contents/Resources/pandeck-runtime/personal-assistant-server"*) ;;
    *) fail "pid $PID is not the bundled server: $command" ;;
  esac
  parent=$(ps -o ppid= -p "$PID" | tr -d ' ')
  [ "$parent" = "$APP_PID" ] || fail "server parent is $parent, not the app $APP_PID"
  note "server pid $PID is the bundled runtime, child of app pid $APP_PID"

  listen=$(lsof -nP -a -p "$PID" -iTCP -sTCP:LISTEN | tail -n +2 || true)
  printf '  lsof| %s\n' "$listen" >>"$receipt"
  grep -q "127.0.0.1:$PORT " <<<"$listen" || fail "not listening on 127.0.0.1:$PORT"
  if grep -vq "127.0.0.1:" <<<"$listen"; then fail "listens beyond loopback"; fi
  note "listens on 127.0.0.1:$PORT only"

  local base="http://127.0.0.1:$PORT"
  [ "$(status_of "$base/api/health")" = 200 ] || fail "health did not answer 200"
  note "GET /api/health -> 200"
  [ "$(status_of "$base/api/shell-launch-probe")" = 401 ] || fail "unauthenticated API was not 401"
  note "GET /api/shell-launch-probe without token -> 401"
  [ "$(status_of -H "Host: rebind.example:$PORT" "$base/api/health")" = 421 ] ||
    fail "a foreign Host was not refused with 421"
  note "foreign Host header -> 421"
}

launch() {
  local where=$1 label=$2 mark
  mark=$(log_mark)
  note "launch $label: $where"
  # `open` is the supported way in (LaunchServices, as Finder does). It passes
  # the CI PATH so the host-tool gate sees the provisioned GNU tools; a Finder
  # launch does not (see `finder_path_launch`).
  if ! open -n --env "PATH=$PATH" "$where"; then
    note "$label: open --env failed; running the executable directly"
    "$where/Contents/MacOS/$executable" >/dev/null 2>&1 &
  fi
  if ! wait_for_server "$mark"; then fail "$label: $FAILURE"; fi
  APP_PID=$(app_pid "$where")
  [ -n "$APP_PID" ] || fail "no app process for $where"
  note "$label ready: app pid $APP_PID, server pid $PID, http://127.0.0.1:$PORT"
}

# Quit as a user would; fall back to SIGTERM, which leaves the server to its
# stdin lifeline. Either way every process from the runtime must be gone.
quit_app() {
  local where=$1 label=$2 deadline
  if timeout 20 osascript -e "tell application id \"$bundle_id\" to quit" >/dev/null 2>&1; then
    note "$label: asked the app to quit (Apple Event)"
  else
    note "$label: Apple Event quit unavailable; sending SIGTERM to app pid $APP_PID"
    kill -TERM "$APP_PID" 2>/dev/null || true
  fi
  deadline=$((SECONDS + 30))
  while [ $SECONDS -lt $deadline ]; do
    if ! kill -0 "$APP_PID" 2>/dev/null && ! kill -0 "$PID" 2>/dev/null; then break; fi
    sleep 1
  done
  if kill -0 "$APP_PID" 2>/dev/null; then
    note "$label: app still running after 30s; SIGKILL"
    kill -KILL "$APP_PID" 2>/dev/null || true
  fi
  kill -0 "$PID" 2>/dev/null && fail "$label: server $PID outlived the app"
  sleep 1
  local strays
  strays=$(pgrep -f "$where/Contents/Resources/pandeck-runtime" || true)
  [ -z "$strays" ] || fail "$label: runtime processes remain: $strays"
  [ "$(status_of "http://127.0.0.1:$PORT/api/health")" = 000 ] || fail "$label: port $PORT still answers"
  local how
  how=$(grep -E '^\[shell\] local server stopped|supervising shell is gone' "$log" | tail -n1 || true)
  note "$label: app and server gone, port closed (${how:-no stop line})"
}

touch "$evidence/.before-launch"
sleep 1
launch "$app" "first launch"
check_server "$app"
first_port=$PORT
data_entries=$(find "$support/data" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
[ "$data_entries" -gt 0 ] || fail "nothing written under $support/data"
note "data dir $support/data has $data_entries entries"
if find "$app" -newer "$evidence/.before-launch" | grep -q .; then
  fail "the app bundle was written to"
fi
note "bundle unchanged by the run"
if screencapture -x "$evidence/first-launch.png" 2>/dev/null; then
  note "screenshot first-launch.png"
else
  note "screenshot unavailable"
fi
quit_app "$app" "first launch"

# Replace the app, as an update or a drag to /Applications would: the copy
# must find the same data and keep its origin (and so the page's storage).
replaced="$evidence/replaced/$(basename "$app")"
mkdir -p "$(dirname "$replaced")"
ditto "$app" "$replaced"
launch "$replaced" "replaced app"
check_server "$replaced"
[ "$PORT" = "$first_port" ] || fail "origin changed: port $first_port became $PORT"
note "replaced app kept origin http://127.0.0.1:$PORT and data dir"
quit_app "$replaced" "replaced app"
rm -rf "$evidence/replaced" "$evidence/.before-launch"

# What a Finder launch sees: LaunchServices' own PATH, without the CI tools.
# Informational. The host-tool distribution policy is undecided, so this
# records whether the actionable prerequisite failure appears, without failing.
finder_path_launch() {
  local mark
  mark=$(log_mark)
  note "finder-PATH launch (informational): open without --env"
  open -n "$app"
  if wait_for_server "$mark"; then
    APP_PID=$(app_pid "$app")
    note "finder-PATH launch became ready on port $PORT"
    quit_app "$app" "finder-PATH launch"
  else
    note "finder-PATH launch did not start: $FAILURE"
    tail -n +"$((mark + 1))" "$log" | grep -A8 'Required host tools' | sed 's/^/  log| /' >>"$receipt" || true
    APP_PID=$(app_pid "$app")
    if [ -n "$APP_PID" ]; then
      timeout 20 osascript -e "tell application id \"$bundle_id\" to quit" >/dev/null 2>&1 ||
        kill -TERM "$APP_PID" 2>/dev/null || true
      sleep 3
      kill -KILL "$APP_PID" 2>/dev/null || true
    fi
    strays=$(pgrep -f "$app/Contents/Resources/pandeck-runtime" || true)
    [ -z "$strays" ] || fail "finder-PATH launch left runtime processes: $strays"
    note "finder-PATH launch left no runtime processes"
  fi
}
finder_path_launch

cp "$log" "$evidence/server.log"
note "PASS"
