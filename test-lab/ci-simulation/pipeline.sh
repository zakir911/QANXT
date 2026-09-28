#!/usr/bin/env bash
#
# A CI pipeline, with no CI system.
#
# This is the local equivalent of the files in infrastructure/ci/examples: the same stages
# in the same order, running the same commands, against the lab bank instead of a
# deployment. What a GitHub Actions workflow or a Jenkinsfile adds on top is syntax, a
# runner and credentials — none of which change what QA NXT is asked to do or what it
# answers. That is the part worth executing, and it is what this script executes.
#
# It is deliberately a shell script rather than a Node program. The examples are shell in
# YAML; if the sequence only worked when driven from JavaScript, it would not be evidence
# about them.
#
#   QANXT_API_URL=http://127.0.0.1:5080 QANXT_TOKEN=… QANXT_PROJECT_ID=… \
#   APP_URL=http://localhost:4300 TEST_IDS="<uuid> <uuid>" \
#   ./pipeline.sh
#
# Stages are announced on stdout as `::stage::<name>::<result>` so a driver can assert the
# sequence — that a run never happened after a failed health check, for instance. A person
# reading the log sees them too, which is the point of putting the marker in the log rather
# than in a side channel.
#
set -uo pipefail

ARTIFACTS="${ARTIFACTS:-ci-artifacts}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
REVIEW_BLOCKS="${REVIEW_BLOCKS:-false}"
MODE="${MODE:-impacted}"
QA NXT="${QANXT_CLI:-node $(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/packages/cli/dist/qanxt.js}"

stage() { printf '::stage::%s::%s\n' "$1" "$2"; }
say()   { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

# Every exit goes through here, so a stage can never be left unreported and the code the
# pipeline finishes with is always printed next to the reason.
finish() {
  local code="$1" reason="$2"
  printf '::verdict::%s::%s\n' "$code" "$reason"
  exit "$code"
}

# --- 1. Checkout -----------------------------------------------------------
#
# In a real pipeline the CI system has already done this. Here it means: work out what we
# claim to be testing, so the run records it and a failure months from now can be traced
# back to a commit.
say "Checkout"
COMMIT_SHA="${COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)}"
BUILD_ID="${BUILD_ID:-local-$(date +%s)}"
CI_PROVIDER="${CI_PROVIDER:-simulation}"
echo "commit ${COMMIT_SHA:0:8} on $BRANCH, build $BUILD_ID"
stage checkout ok

# --- 2. Deploy -------------------------------------------------------------
#
# The lab bank stands in for the deployment. Resetting it is the honest local equivalent of
# a fresh deploy: known data, no faults carried over from whatever ran last. FAULTS injects
# a defect into that deployment, which is how a scenario produces a genuine test failure
# rather than a test that was written to fail.
say "Deploy"
if [[ -n "${APP_URL:-}" ]]; then
  curl -fsS --max-time 10 -X POST "$APP_URL/__reset" >/dev/null 2>&1 \
    && echo "Reset $APP_URL to a known state." \
    || echo "Could not reset $APP_URL — it may not be up yet; the health check decides."
  if [[ -n "${FAULTS:-}" ]]; then
    curl -fsS --max-time 10 -X POST "$APP_URL/__faults" \
      -H 'content-type: application/json' -d "$FAULTS" >/dev/null 2>&1 \
      && echo "Injected $FAULTS into the deployment." \
      || echo "Could not inject faults."
  fi
fi
stage deploy ok

# --- 3. Health check -------------------------------------------------------
#
# Before the tests, not after. A run against an application that has not finished starting
# reports failures that belong to the deployment, and someone spends the morning reading
# them as defects. This is the one stage that can stop the pipeline before QA NXT is involved
# at all, and it exits 5 because nothing is yet known about quality.
say "Health check"
if [[ -z "${APP_URL:-}" ]]; then
  stage health skipped
else
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  healthy=false
  until curl -fsS --max-time 5 "$APP_URL/health" >/dev/null 2>&1; do
    if [[ $(date +%s) -ge $deadline ]]; then break; fi
    sleep 2
  done
  curl -fsS --max-time 5 "$APP_URL/health" >/dev/null 2>&1 && healthy=true

  if [[ "$healthy" != true ]]; then
    stage health failed
    echo "::error:: $APP_URL did not answer within ${HEALTH_TIMEOUT}s. No tests were run."
    finish 5 "the deployment never became healthy"
  fi
  echo "$APP_URL is healthy."
  stage health ok
fi

mkdir -p "$ARTIFACTS"

# --- 4. Select -------------------------------------------------------------
#
# What the change needs. A scenario that names its tests explicitly skips this, the way a
# nightly full run would; otherwise the selection is written as its own artifact so that
# "why did that test not run?" has an answer on the build page rather than in someone's
# memory.
say "Select"
if [[ -n "${TEST_IDS:-}" ]]; then
  echo "Explicit test list; no selection to make."
  stage select skipped
else
  # shellcheck disable=SC2086
  $QA NXT regression select \
    --since "${BASE_REF:-HEAD~1}" \
    --mode "$MODE" \
    --explain \
    --selection-out "$ARTIFACTS/regression-selection.json"
  select_status=$?
  if [[ $select_status -ne 0 ]]; then
    stage select failed
    finish $select_status "the selection could not be made"
  fi
  stage select ok
fi

# --- 5. Test ---------------------------------------------------------------
#
# The whole of QA NXT's part: execution, failure analysis, self-healing where it is safe,
# evidence, and the quality gate. One command, one exit code.
say "Test"
args=(--report-dir "$ARTIFACTS" --timeout "${RUN_TIMEOUT:-300}"
      --ci-provider "$CI_PROVIDER" --ci-build "$BUILD_ID"
      --ci-commit "$COMMIT_SHA" --ci-branch "$BRANCH")
[[ -n "${APP_BUILD:-}" ]] && args+=(--app-build "$APP_BUILD")

if [[ -n "${TEST_IDS:-}" ]]; then
  for id in $TEST_IDS; do args+=(--test "$id"); done
  # shellcheck disable=SC2086
  $QA NXT run "${args[@]}"
else
  # shellcheck disable=SC2086
  $QA NXT regression run --since "${BASE_REF:-HEAD~1}" --mode "$MODE" "${args[@]}"
fi
status=$?
stage test "exit-$status"

# --- 6. Publish ------------------------------------------------------------
#
# Whatever happened. A failed run is the one whose evidence somebody actually needs, and a
# pipeline that only uploads artifacts on success is a pipeline that throws away the
# artifacts that matter.
say "Publish"
if [[ -d "$ARTIFACTS" ]]; then
  ls -1 "$ARTIFACTS"
  stage publish ok
else
  echo "No artifacts were written."
  stage publish failed
fi

# --- 7. Decide -------------------------------------------------------------
#
# The exit code is QA NXT's answer. What the pipeline does with it is the team's decision,
# and making it here rather than inside the CLI is the whole reason REVIEW has a code of
# its own.
say "Decide"
case $status in
  0) echo "PASS — tests passed and the quality gate passed."
     finish 0 "pass" ;;
  1) echo "::error:: TEST_FAILURE — one or more tests failed. See $ARTIFACTS/summary.md."
     finish 1 "tests failed" ;;
  2) echo "::error:: QUALITY_GATE_FAILURE — every test was within tolerance and a rule stopped it anyway."
     finish 2 "the quality gate blocked this run" ;;
  3) echo "::error:: CONFIGURATION_ERROR — QA NXT was configured wrongly. Whoever edited this pipeline should look."
     finish 3 "bad configuration" ;;
  4) echo "::error:: AUTHENTICATION_ERROR — QA NXT rejected the credentials. Whoever holds QANXT_TOKEN should look."
     finish 4 "bad credentials" ;;
  5) echo "::error:: INFRASTRUCTURE_ERROR — QA NXT could not be used. The platform operator should look."
     echo "Nothing is known about quality. Do not read this as a pass."
     finish 5 "the platform could not be reached" ;;
  6) echo "::error:: SECURITY_POLICY_VIOLATION — a security policy refused this run."
     echo "The run did not happen, and that is the correct outcome. Read why before retrying."
     finish 6 "a security policy refused this run" ;;
  7) echo "::warning:: HUMAN_REVIEW_REQUIRED — this run needs a person to look at it. See $ARTIFACTS/summary.md."
     if [[ "$REVIEW_BLOCKS" == "true" ]]; then
       finish 7 "review required, and this pipeline blocks on review"
     fi
     echo "This pipeline does not block on review. Continuing."
     finish 0 "review required, and this pipeline does not block on review" ;;
  8) echo "::error:: QANXT_INTERNAL_ERROR — QA NXT itself failed. This is a defect in QA NXT, not a finding about the application."
     finish 8 "QA NXT failed internally" ;;
  *) echo "::error:: Unrecognised exit code $status from QA NXT. Treating it as a failure."
     finish "$status" "unrecognised exit code" ;;
esac
