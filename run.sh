#!/usr/bin/env bash
#
# Run the DAWN Hero UI dev server (Vite, HTTPS on :5273).
#
# Foreground by default (Ctrl-C to stop); pass -b to detach into the background.
# A backgrounded server writes a PID + log next to this script so stop/status/logs
# can find it, and is torn down by process group so Vite never orphans under npm.
#
#   ./run.sh                 start in the foreground
#   ./run.sh -b              start in the background
#   ./run.sh stop            stop the background server
#   ./run.sh restart -b      restart (honors -b)
#   ./run.sh status          is a background server running?
#   ./run.sh logs -f         tail the background server's log
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PIDFILE="$ROOT/.run.pid"
LOGFILE="$ROOT/.run.log"
URL="https://localhost:5273"

usage() {
   sed -n '3,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# True when a background server we started is still alive.
is_running() {
   [ -f "$PIDFILE" ] || return 1
   local pid
   pid="$(cat "$PIDFILE" 2>/dev/null)" || return 1
   [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

ensure_deps() {
   command -v npm >/dev/null 2>&1 || { echo "npm not found in PATH." >&2; exit 1; }
   [ -d node_modules ] || { echo "Dependencies not installed. Run: npm install" >&2; exit 1; }
}

start() {
   local bg="$1"
   ensure_deps
   if is_running; then
      echo "Already running in the background (pid $(cat "$PIDFILE")). Use './run.sh stop' first." >&2
      exit 1
   fi

   if [ "$bg" = 0 ]; then
      echo "Starting DAWN Hero UI (foreground) on $URL - Ctrl-C to stop."
      exec npm run dev
   fi

   # Background: run in a fresh session (setsid) so npm + its Vite child share one
   # process group we can signal as a unit. The child records its own PID (the group
   # leader) before exec'ing, so $PIDFILE holds the PGID for a clean group kill.
   setsid bash -c "echo \$\$ > '$PIDFILE'; exec npm run dev" >"$LOGFILE" 2>&1 </dev/null &

   # Give it a moment; if it died immediately, surface why instead of lying "started".
   sleep 1
   if ! is_running; then
      echo "Dev server failed to start. Last log lines:" >&2
      tail -n 20 "$LOGFILE" >&2 || true
      rm -f "$PIDFILE"
      exit 1
   fi
   echo "DAWN Hero UI running in the background (pid $(cat "$PIDFILE"))."
   echo "  URL:   $URL"
   echo "  Logs:  ./run.sh logs -f"
   echo "  Stop:  ./run.sh stop"
}

stop() {
   if ! is_running; then
      echo "Not running."
      rm -f "$PIDFILE"
      return 0
   fi
   local pid
   pid="$(cat "$PIDFILE")"
   # Negative PID targets the whole process group (npm + vite).
   kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
   for _ in $(seq 1 20); do
      is_running || break
      sleep 0.25
   done
   if is_running; then
      kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
      sleep 0.25
   fi
   rm -f "$PIDFILE"
   echo "Stopped."
}

status() {
   if is_running; then
      echo "running (pid $(cat "$PIDFILE")) - $URL"
   else
      echo "stopped"
      rm -f "$PIDFILE" 2>/dev/null || true
   fi
}

logs() {
   [ -f "$LOGFILE" ] || { echo "No log file yet ($LOGFILE)." >&2; exit 1; }
   if [ "$1" = 1 ]; then
      tail -f "$LOGFILE"
   else
      tail -n 50 "$LOGFILE"
   fi
}

CMD="start"
BG=0
FOLLOW=0
while [ $# -gt 0 ]; do
   case "$1" in
      start|stop|restart|status|logs) CMD="$1" ;;
      -b|--background) BG=1 ;;
      -f|--follow) FOLLOW=1 ;;
      -h|--help) usage; exit 0 ;;
      *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
   esac
   shift
done

case "$CMD" in
   start)   start "$BG" ;;
   stop)    stop ;;
   restart) stop; start "$BG" ;;
   status)  status ;;
   logs)    logs "$FOLLOW" ;;
esac
