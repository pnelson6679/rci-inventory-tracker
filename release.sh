#!/usr/bin/env bash
# release.sh — commit, push to GitHub, push to Apps Script, deploy to fixed URL
#
# Usage:
#   ./release.sh "your commit message"
#
# First-time setup:
#   1. Run this script once — it will create the initial deployment and save the
#      deployment ID to .deployment-id, then commit that file to the repo.
#   2. All future runs update that same deployment, keeping the URL constant.
#
# Requirements:
#   - clasp installed: npm install -g @google/clasp
#   - clasp logged in: clasp login
#   - git remote set up

set -euo pipefail

# ── helpers ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()    { echo -e "${GREEN}▶${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✖${NC}  $*" >&2; exit 1; }
success() { echo -e "${GREEN}✔${NC} $*"; }

# ── commit message ─────────────────────────────────────────────────────────────
COMMIT_MSG="${1:-}"
if [ -z "$COMMIT_MSG" ]; then
  # If no argument, prompt for one
  read -rp "Commit message: " COMMIT_MSG
  [ -z "$COMMIT_MSG" ] && error "Commit message cannot be empty."
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOYMENT_ID_FILE="$SCRIPT_DIR/.deployment-id"

# ── 1. Git: stage, commit, push ────────────────────────────────────────────────
info "Staging all changes..."
git -C "$SCRIPT_DIR" add -A

# Only commit if there are staged changes
if git -C "$SCRIPT_DIR" diff --cached --quiet; then
  warn "Nothing to commit — working tree clean."
else
  info "Committing: \"$COMMIT_MSG\""
  git -C "$SCRIPT_DIR" commit -m "$COMMIT_MSG"
fi

info "Pushing to GitHub..."
git -C "$SCRIPT_DIR" push origin main
success "GitHub up to date."

# ── 2. clasp push ──────────────────────────────────────────────────────────────
info "Pushing source to Apps Script..."
(cd "$SCRIPT_DIR" && clasp push --force)
success "clasp push complete."

# ── 3. Deploy to fixed URL ─────────────────────────────────────────────────────
TIMESTAMP="$(date '+%Y-%m-%d %H:%M')"
DEPLOY_DESC="release: $COMMIT_MSG ($TIMESTAMP)"

if [ -f "$DEPLOYMENT_ID_FILE" ]; then
  DEPLOYMENT_ID="$(cat "$DEPLOYMENT_ID_FILE")"
  info "Updating deployment $DEPLOYMENT_ID ..."
  clasp deploy --deploymentId "$DEPLOYMENT_ID" --description "$DEPLOY_DESC"
  success "Deployed to existing URL (deployment ID: $DEPLOYMENT_ID)"
else
  warn "No .deployment-id found — creating initial deployment..."
  OUTPUT="$(clasp deploy --description "$DEPLOY_DESC")"
  echo "$OUTPUT"

  # Parse the deployment ID from clasp output:
  # clasp prints: "Created version X." then "- <deploymentId> @X."
  DEPLOYMENT_ID="$(echo "$OUTPUT" | grep -oE '[A-Za-z0-9_-]{20,}' | head -1)"

  if [ -z "$DEPLOYMENT_ID" ]; then
    error "Could not parse deployment ID from clasp output. Run 'clasp deployments' to find it, then save it to .deployment-id manually."
  fi

  echo "$DEPLOYMENT_ID" > "$DEPLOYMENT_ID_FILE"
  info "Saved deployment ID to .deployment-id"

  # Commit .deployment-id so the whole team (and CI) share the same URL
  git -C "$SCRIPT_DIR" add .deployment-id
  git -C "$SCRIPT_DIR" commit -m "chore: pin deployment ID for fixed release URL"
  git -C "$SCRIPT_DIR" push origin main
  success "Initial deployment created and pinned. Future releases will update this same URL."
fi

# ── 4. Print the web app URL ───────────────────────────────────────────────────
echo ""
info "Web app URL:"
clasp deployments | grep "$DEPLOYMENT_ID" || true
echo ""
success "Release complete!"
