#!/usr/bin/env bash
#
# AIRA in a pipeline, with nothing CI-specific about it.
#
# The other example pipelines are this script with their system's syntax around it. If your
# CI system is not one of the four, start here: it needs a shell, curl and the aira command.
#
#   AIRA_API_URL=https://aira.example.com \
#   AIRA_TOKEN=… AIRA_PROJECT_ID=… APP_URL=https://app-pr-1234.example.com \
#   ./generic.sh
#
set -uo pipefail

: "${AIRA_API_URL:?set AIRA_API_URL to the control plane}"
: "${AIRA_TOKEN:?set AIRA_TOKEN to a service account token}"
: "${AIRA_PROJECT_ID:?set AIRA_PROJECT_ID to the project to run in}"
: "${APP_URL:?set APP_URL to the deployment under test}"

BASE_REF="${BASE_REF:-origin/main}"
ARTIFACTS="${ARTIFACTS:-aira-artifacts}"
MODE="${MODE:-impacted}"
REVIEW_BLOCKS="${REVIEW_BLOCKS:-false}"

# --- 2. Wait for the deployment to be healthy -------------------------------
#
# Before this, not after. A test run against an application that has not finished starting
# reports failures that belong to the deployment, and someone spends the morning reading
# them as defects.
echo "Waiting for $APP_URL to answer…"
deadline=$(( $(date +%s) + 180 ))
until curl -fsS --max-time 5 "$APP_URL/health" >/dev/null 2>&1; do
  if [[ $(date +%s) -ge $deadline ]]; then
    echo "::error:: $APP_URL did not become healthy within 180s. Not running any tests."
    exit 5    # INFRASTRUCTURE_ERROR: the deployment, not the application's behaviour
  fi
  sleep 3
done
echo "Healthy."

mkdir -p "$ARTIFACTS"

# --- 3 & 4. Select the tests the change needs, and run them -----------------
#
# One command: it selects, writes the selection as an artifact, runs what it selected and
# waits for the verdict. --explain puts the reasoning in the build log, where it is read
# by whoever wonders why a test did not run.
aira regression run \
  --since "$BASE_REF" \
  --mode "$MODE" \
  --explain \
  --report-dir "$ARTIFACTS" \
  --ci-provider "${CI_PROVIDER:-generic}" \
  --ci-build "${BUILD_ID:-local}" \
  --ci-commit "${COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}" \
  --ci-branch "${BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)}"

status=$?

# --- 5 & 6. Publish, and decide -------------------------------------------
#
# The artifacts are published whatever happened. A failed run is the one whose evidence
# somebody actually needs.
echo "Artifacts in $ARTIFACTS:"
ls -1 "$ARTIFACTS" 2>/dev/null || true

case $status in
  0) echo "PASS" ;;
  1) echo "::error:: Tests failed. See $ARTIFACTS/summary.md." ;;
  2) echo "::error:: The quality gate blocked this run. Every test was within tolerance and a rule stopped it anyway." ;;
  3) echo "::error:: AIRA was configured wrongly. Whoever edited this pipeline should look." ;;
  4) echo "::error:: AIRA rejected the credentials. Whoever holds AIRA_TOKEN should look." ;;
  5) echo "::error:: AIRA could not be used. The platform operator should look." ;;
  6) echo "::error:: A security policy refused this run. Do not retry without reading why." ;;
  7)
    echo "::warning:: This run needs a person to look at it. See $ARTIFACTS/summary.md."
    if [[ "$REVIEW_BLOCKS" != "true" ]]; then
      # REVIEW is not a failure. Whether it stops the pipeline is the team's decision,
      # and making it here rather than in the CLI is why the code is its own number.
      status=0
    fi
    ;;
  8) echo "::error:: AIRA failed internally. This is a defect in AIRA, not in the application." ;;
esac

# The summary is written whether the run passed or failed; posting it is your CI system's
# job, because it already has the credentials to comment and AIRA should not need a second
# set. For example:
#
#   gh pr comment "$PR_NUMBER" --body-file "$ARTIFACTS/summary.md"
#
if [[ -f "$ARTIFACTS/summary.md" ]]; then
  echo "Pull request summary written to $ARTIFACTS/summary.md"
fi

exit $status
