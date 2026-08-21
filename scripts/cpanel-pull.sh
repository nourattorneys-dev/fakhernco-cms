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
# SETUP (cPanel -> Cron Jobs), every five minutes:
#   */5 * * * * /bin/bash "$HOME/cms-deploy/scripts/cpanel-pull.sh" >> "$HOME/cms-deploy.log" 2>&1
#
# The first run clones, so there is nothing to set up by hand. Bootstrap it by
# pasting this one-liner into cPanel -> Terminal, or just let the cron fire:
#   git clone --depth=1 -b deploy https://github.com/nourattorneys-dev/fakhernco-cms.git "$HOME/cms-deploy"

set -euo pipefail

REPO_URL="https://github.com/nourattorneys-dev/fakhernco-cms.git"
BRANCH="deploy"
CLONE="$HOME/cms-deploy"
APP="$HOME/cms"
STAMP="$HOME/.cms-deployed-sha"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

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
  # Quiet on the common path. This runs every five minutes; logging "nothing to
  # do" 288 times a day would bury the one line that matters.
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
# EVERY --exclude BELOW IS ALSO PROTECTED FROM --delete. That is rsync's rule,
# and for public/uploads/ it is the only thing between a deploy and the firm's
# media library — 154 files that are gitignored, live on this disk and nowhere
# else, and have no undo.
#
# NEVER add --delete-excluded.
rsync -a --delete \
  --exclude '.git/' \
  --exclude '.env' --exclude '.env.*' \
  --exclude 'node_modules/' \
  --exclude 'public/uploads/' \
  --exclude '.tmp/' --exclude 'tmp/' --exclude 'logs/' \
  --exclude 'migration/data/' --exclude '.seed-token' \
  "$CLONE/" "$APP/"

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
for i in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://cms.fakhernco.com/_health || true)"
  if [ "$code" = "204" ]; then
    echo "$NEW_SHA" > "$STAMP"
    log "healthy — $NEW_SHA is live"
    exit 0
  fi
  log "attempt $i: /_health -> $code"
  sleep 6
done

# Deliberately do NOT stamp on failure: the next cron tick retries rather than
# concluding the bad revision is deployed.
log "ERROR: CMS did not return healthy after deploying $NEW_SHA"
exit 1
