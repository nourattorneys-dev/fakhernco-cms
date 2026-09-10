#!/bin/bash
#
# Pull the CI-built release and restart Strapi. Runs ON the cPanel box, from a
# cPanel cron job.
#
# WHY THIS EXISTS
# The obvious deploy — GitHub Actions rsyncs over SSH — cannot work here. SSH
# on this account answers "connection refused" on 22 and times out on 2222,
# FTP is closed, and WHM is not accessible. Nothing inbound is reachable.
#
# So the direction is reversed: the server reaches OUT to GitHub. Cron is the
# only scheduler cPanel reliably exposes, and it runs shell as the account
# user, which is all this needs. No ports, no firewall rules, no deploy key.
#
# The repository is PUBLIC, so the clone needs no credentials at all. If it is
# ever made private this script needs a token and should be revisited — do not
# paste one in here, it would be world-readable on a shared box.
#
# WHAT IT PULLS
# The `deploy` branch, which CI force-pushes as a single orphan commit
# containing source plus the compiled `dist/`. Orphan and force-pushed on
# purpose: the branch never accumulates history, so the clone stays ~15MB
# instead of growing by the size of `dist/` on every deploy.
#
# It deliberately does NOT build. `strapi build` peaks at 1.69GB RSS against a
# 2GB account shared with Passenger and MySQL — that is the whole reason the
# build happens in CI.
#
# SETUP (cPanel -> Cron Jobs), every THIRTY minutes.
#
# It used to be every five. Two things make that a bad idea on this account:
# a failing run could outlast its own interval and overlap itself (see the lock
# below), and every curl attempt counts as a cPanel "entry process" — a limit
# this account reaches long before it runs out of memory. Deploys are rare;
# waiting half an hour for one costs nothing.
#
# This clones itself on the first run, so there is nothing to prepare — which
# matters, because Terminal is not available on this account:
#
#   cd "$HOME" && { [ -d cms-deploy/.git ] || git clone --depth=1 -b deploy \
#     https://github.com/nourattorneys-dev/fakhernco-cms.git cms-deploy; \
#     /bin/bash cms-deploy/scripts/cpanel-pull.sh; } >> "$HOME/cms-deploy.log" 2>&1
#
# Note the braces: the redirect has to cover the clone too, or a failure there
# goes to cron's email instead of the log. That cost a debugging round.

set -euo pipefail

# Cron runs with a near-empty PATH — typically just /usr/bin:/bin. On a cPanel
# box with the Node.js selector, `node` and `npm` are not on it at all. Add the
# usual locations before anything looks for a binary.
PATH="$PATH:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin"
for nodedir in /opt/alt/alt-nodejs*/root/usr/bin; do
  [ -d "$nodedir" ] && PATH="$PATH:$nodedir"
done
export PATH

REPO_URL="https://github.com/nourattorneys-dev/fakhernco-cms.git"
BRANCH="deploy"
CLONE="$HOME/cms-deploy"
APP="$HOME/cms"
STAMP="$HOME/.cms-deployed-sha"
SYNC_STAMP="$HOME/.cms-synced-sha"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

# ------------------------------------------------------------------- lock
#
# One run at a time.
#
# The health loop below now runs for at most 2.5 minutes against a 30-minute
# cron, so overlap should be impossible on timing alone. The lock stays anyway,
# because it is the thing that makes that guarantee rather than assumes it.
#
# It was not always so. The loop was 20 attempts of (curl --max-time 20 +
# sleep 6) — up to 8.7 minutes — while cron fired every 5. A deploy that could
# not go healthy therefore overlapped ITSELF, and each concurrent run executed
# `rm -rf "$APP/dist"` and untarred into the same directory. Strapi was being
# asked to boot out of a folder that two other processes were deleting and
# rewriting underneath it, which guaranteed the failure the runs were retrying.
# It cost a two-hour outage: 40+ redeploys of one commit, every one of them
# logging the same "deploying be8a927 -> f573b7b" because the stamp is only
# written on success.
#
# mkdir is the atomic primitive here. flock is not installed on this box.
LOCK="$HOME/.cms-pull.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # A lock older than 30 minutes cannot belong to a live run: the longest
  # possible run is the 2.5-minute health loop plus an npm ci, and npm ci is
  # the only part that could plausibly take minutes. Treat it as a crashed
  # holder rather than blocking deploys forever.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    log "stale lock — previous run died, taking over"
    rmdir "$LOCK" 2>/dev/null || true
    mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# ---------------------------------------------------------------- bootstrap
if [ ! -d "$CLONE/.git" ]; then
  log "no clone at $CLONE — cloning $BRANCH"
  rm -rf "$CLONE"
  git clone --depth=1 -b "$BRANCH" "$REPO_URL" "$CLONE"
fi

cd "$CLONE"

# --------------------------------------------------------------- fetch head
# --depth=1 against a force-pushed orphan branch: there is no shared history to
# reconcile, so fetch + reset is the only thing that works. A `git pull` would
# fail with "refusing to merge unrelated histories" on every single deploy.
git fetch --depth=1 origin "$BRANCH" --quiet
git reset --hard "origin/$BRANCH" --quiet
git clean -fd --quiet

NEW_SHA="$(cat "$CLONE/DEPLOY_SHA" 2>/dev/null || git rev-parse --short HEAD)"
OLD_SHA="$(cat "$STAMP" 2>/dev/null || echo none)"

if [ "$NEW_SHA" = "$OLD_SHA" ]; then
  # Quiet on the common path. This runs every half hour; logging "nothing to
  # do" 48 times a day would bury the one line that matters.
  exit 0
fi

log "deploying $OLD_SHA -> $NEW_SHA"

# ------------------------------------------------------------- dependencies
#
# node_modules is ~800MB and is NOT in git — far too large, and it would have to
# be rebuilt into the branch on every commit.
#
# It changes only when the lockfile does, which is rare. `npm ci --omit=dev` is
# a download-and-unpack, not a compile, so it is far lighter than the build this
# script exists to avoid — but it is still the heaviest thing here. Guarded so
# it runs only when the lockfile genuinely moved.
if [ ! -d "$APP/node_modules" ] || ! cmp -s "$CLONE/package-lock.json" "$APP/package-lock.json"; then
  log "lockfile changed (or node_modules missing) — installing production deps"
  cp "$CLONE/package.json" "$CLONE/package-lock.json" "$APP/"
  ( cd "$APP" && npm ci --omit=dev --no-audit --no-fund )
  log "dependencies installed"
fi

# --------------------------------------------------------------------- sync
#
# rsync is NOT installed on this box — the first live run failed with
# "rsync: command not found", which is why this uses tar. tar is in coreutils
# and has been present everywhere cPanel runs.
#
# The exclusions are the safety mechanism. public/uploads/ is the firm's media
# library: 154 files, gitignored, on this disk and nowhere else, with no undo.
# tar makes that safer than rsync did, not less — it only ever adds and
# overwrites, so there is no --delete to get wrong and no way for an excluded
# path to be removed.
#
# The tradeoff is that a file deleted from the repo lingers on the server. For
# source that is harmless. For dist/ it is not — stale admin-panel chunks would
# accumulate every build — so dist/ is replaced wholesale rather than merged
# into. It is pure build output, reproduced in full by every deploy. See the
# swap below for why "replaced" is not the same as "deleted, then rewritten".
EXCLUDES="
--exclude=./.git
--exclude=./.env
--exclude=./.env.local
--exclude=./.env.production
--exclude=./node_modules
--exclude=./public/uploads
--exclude=./.tmp
--exclude=./tmp
--exclude=./logs
--exclude=./migration/data
--exclude=./.seed-token
"

#
# "The files are in place" and "the app is healthy" are separate facts, and
# conflating them is what made a failed health check destructive. The stamp
# further down is only written on a 204, so a boot failure meant the next tick
# re-ran this whole block — deleting a dist/ that was already correct. Recording
# the sync separately means a retry restarts and re-checks, and stops there.
if [ "$(cat "$SYNC_STAMP" 2>/dev/null || true)" = "$NEW_SHA" ]; then
  log "$NEW_SHA is already on disk — restarting and re-checking health only"
else
  # dist/ is swapped, not rewritten in place.
  #
  # The old order was `rm -rf dist` then untar into $APP. Between those two
  # steps the server has NO admin panel, and if the untar dies midway it has
  # half of one — which is indistinguishable, to Passenger, from a broken
  # build. Staging the new dist/ beside the live one and renaming keeps the
  # window to a single rename() syscall: either the old tree or the new one,
  # never a partial. Source files still overwrite in place, which is fine —
  # they are individually replaced, not collectively removed first.
  rm -rf "$APP/dist.incoming" "$APP/dist.old"

  # shellcheck disable=SC2086
  ( cd "$CLONE" && tar $EXCLUDES -cf - . ) | ( cd "$APP" && tar -xf - --transform='s,^\./dist\($\|/\),./dist.incoming\1,' )

  if [ ! -f "$APP/dist.incoming/build/index.html" ]; then
    log "ERROR: staged dist/ has no admin panel (dist.incoming/build/index.html missing) — refusing to swap"
    rm -rf "$APP/dist.incoming"
    exit 1
  fi

  [ -d "$APP/dist" ] && mv "$APP/dist" "$APP/dist.old"
  mv "$APP/dist.incoming" "$APP/dist"
  rm -rf "$APP/dist.old"

  echo "$NEW_SHA" > "$SYNC_STAMP"
fi

# ------------------------------------------------------------------ restart
#
# Passenger ignores `npm start` entirely and watches tmp/restart.txt. cPanel
# does not create that directory, so mkdir -p first or the touch silently
# no-ops and the old code keeps serving a deploy that looked successful.
mkdir -p "$APP/tmp" "$APP/public/uploads"
touch "$APP/tmp/restart.txt"

# ------------------------------------------------------------------- verify
#
# Passenger restarts lazily, on the next request — so this both triggers the
# restart and proves it worked. Without it, "deployed" would mean "files
# copied", which is not the same thing.
for i in $(seq 1 10); do
  if command -v curl >/dev/null 2>&1; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://cms.fakhernco.com/_health || true)"
  elif command -v wget >/dev/null 2>&1; then
    code="$(wget -q -S -O /dev/null --timeout=10 https://cms.fakhernco.com/_health 2>&1 | awk '/HTTP\//{c=$2} END{print c}' || true)"
  else
    # No HTTP client. Restarting still worked; we simply cannot prove it.
    log "no curl or wget — cannot verify; assuming the restart took"
    echo "$NEW_SHA" > "$STAMP"
    exit 0
  fi
  if [ "$code" = "204" ]; then
    echo "$NEW_SHA" > "$STAMP"
    log "healthy — $NEW_SHA is live"
    exit 0
  fi
  log "attempt $i: /_health -> $code"
  sleep 5
done

# Deliberately do NOT stamp on failure: the next cron tick retries rather than
# concluding the bad revision is deployed.
log "ERROR: CMS did not return healthy after deploying $NEW_SHA"
exit 1
