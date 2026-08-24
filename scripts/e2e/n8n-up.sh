#!/usr/bin/env bash
# Brings up n8n in Docker with this node installed, for the end-to-end checklist.
#
# The node's package is installed INSIDE the container on purpose: the Claude Code SDK ships
# platform-specific CLI binaries as optional dependencies, so installing on the macOS host would
# fetch the darwin build and it would not run on linux.
#
# Credentials: the host stores Claude credentials in the macOS Keychain, which a linux container
# cannot read. Pass a token in via the environment before running:
#   export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)   # or
#   export ANTHROPIC_API_KEY=sk-ant-...
#
# The token is never written to a file, an image layer or the repo — only passed as a run-time
# `-e` flag. Nothing in scripts/e2e/ is committed (see .gitignore).
#
# Overridable:
#   E2E_PORT       host port for the n8n UI          (default 5690)
#   E2E_CONTAINER  container name                    (default n8n-cc-e2e)
#   E2E_VOLUME     docker volume for /home/node/.n8n (default n8n_cc_e2e)
#   E2E_IMAGE      n8n image                         (default n8nio/n8n:latest)
#   E2E_KEEP_DATA  1 = reuse the existing volume instead of recreating it
#
# The defaults deliberately avoid the ports already in use on this machine: 5678 (machine-n8n)
# and 5688 (n8n-cc-test2). Pick a free one if 5690 is taken too. Note 5699 is used INSIDE the container as the
# n8n task-broker port by run-cases.mjs — a different namespace, but do not reuse it here.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

PORT="${E2E_PORT:-5690}"
CONTAINER="${E2E_CONTAINER:-n8n-cc-e2e}"
VOLUME="${E2E_VOLUME:-n8n_cc_e2e}"
IMAGE="${E2E_IMAGE:-n8nio/n8n:latest}"

if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
	echo "ERROR: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set." >&2
	echo "       Run:  export CLAUDE_CODE_OAUTH_TOKEN=\$(claude setup-token)" >&2
	exit 1
fi

# `claude setup-token` renders a full-screen TUI, so command substitution captures ~60 lines of
# prompts and ANSI escapes with the token buried inside. The CLI then rejects it with
# "Invalid Authorization header value ... it contains a line break at character 56". Pull just the
# token back out. Never printed — only its length is reported.
if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
	if [[ "$CLAUDE_CODE_OAUTH_TOKEN" == *$'\n'* || "$CLAUDE_CODE_OAUTH_TOKEN" == *$'\e'* ]]; then
		echo "==> CLAUDE_CODE_OAUTH_TOKEN looks like captured TUI output; extracting the token"
		CLAUDE_CODE_OAUTH_TOKEN="$(
			printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" | tr -d '\r' |
				grep -oE 'sk-ant-oat[0-9]+-[A-Za-z0-9_-]+' | tail -1
		)"
	fi
	if [[ ${#CLAUDE_CODE_OAUTH_TOKEN} -lt 40 ]]; then
		echo "ERROR: could not recover a usable token (got ${#CLAUDE_CODE_OAUTH_TOKEN} chars)." >&2
		echo "       The TUI may have wrapped it across lines. Run 'claude setup-token' on its own," >&2
		echo "       copy the sk-ant-oat... value by hand, then:" >&2
		echo "         export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-..." >&2
		exit 1
	fi
	export CLAUDE_CODE_OAUTH_TOKEN
	echo "==> token: ${#CLAUDE_CODE_OAUTH_TOKEN} chars, single line"
fi

# Packed fresh every run. A committed or left-over .tgz is the classic way to spend an hour
# validating the previous build.
echo "==> building and packing the node"
PACKDIR="$HERE/.pack"
rm -rf "$PACKDIR"
mkdir -p "$PACKDIR"
(cd "$REPO" && npm run build >/dev/null && npm pack --pack-destination "$PACKDIR" >/dev/null)
TARBALL="$(ls "$PACKDIR"/*.tgz | tail -1)"
echo "==> tarball: $(basename "$TARBALL")  ($(du -h "$TARBALL" | cut -f1))"
echo "==> commit:  $(cd "$REPO" && git rev-parse --short HEAD) on $(cd "$REPO" && git branch --show-current)"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
if [[ "${E2E_KEEP_DATA:-0}" != "1" ]]; then
	docker volume rm "$VOLUME" >/dev/null 2>&1 || true
fi
docker volume create "$VOLUME" >/dev/null

echo "==> installing the node inside the container (fetches the linux Claude CLI)"
docker run --rm \
	--user root \
	-v "$VOLUME":/home/node/.n8n \
	-v "$PACKDIR":/pkg:ro \
	--entrypoint sh \
	"$IMAGE" -c "
		set -e
		mkdir -p /home/node/.n8n/nodes
		cd /home/node/.n8n/nodes
		[ -f package.json ] || npm init -y >/dev/null
		npm install --omit=dev '/pkg/$(basename "$TARBALL")' 2>&1 | tail -5
		node -e \"require('/home/node/.n8n/nodes/node_modules/@joaoveiga/n8n-nodes-claudecode/dist/nodes/ClaudeCode/timeout.js'); console.log('node module loads OK')\"
		ls /home/node/.n8n/nodes/node_modules/@anthropic-ai/ 2>/dev/null || true
		chown -R node:node /home/node/.n8n
	"

echo "==> starting n8n on http://localhost:$PORT"
docker run -d \
	--name "$CONTAINER" \
	-p "$PORT":5678 \
	-v "$VOLUME":/home/node/.n8n \
	-v "$HERE/fixture-project":/workspace \
	-e N8N_SECURE_COOKIE=false \
	-e N8N_DIAGNOSTICS_ENABLED=false \
	-e N8N_RUNNERS_ENABLED=true \
	-e N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true \
	-e N8N_LOG_LEVEL=debug \
	-e GENERIC_TIMEZONE=America/Sao_Paulo \
	${CLAUDE_CODE_OAUTH_TOKEN:+-e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"} \
	${ANTHROPIC_API_KEY:+-e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"} \
	"$IMAGE" >/dev/null

echo "==> waiting for n8n to accept connections"
for _ in $(seq 1 60); do
	if docker exec "$CONTAINER" wget -qO- http://localhost:5678/healthz >/dev/null 2>&1; then
		break
	fi
	sleep 2
done
if ! docker exec "$CONTAINER" wget -qO- http://localhost:5678/healthz >/dev/null 2>&1; then
	echo "ERROR: n8n did not come up. Last logs:" >&2
	docker logs --tail 40 "$CONTAINER" >&2
	exit 1
fi

# The sqlite readers run inside the container, because the database lives in the volume and
# node:sqlite is available in the n8n image.
echo "==> installing the container-side helpers"
for f in ids.js list-wf.js last-exec.js last-execs.js activate.js read-exec.js patch-session.js; do
	docker cp "$HERE/$f" "$CONTAINER:/tmp/$f" >/dev/null
done

echo "==> generating the case workflows"
node "$HERE/gen-workflows.mjs"
# `docker cp dir container:/path` copies INTO /path when /path already exists, leaving the previous
# generation in place and nesting the new one under /path/workflows. n8n then imports the stale
# copy and every timeout change looks like it did not take. Remove it first, as root — the files
# land owned by root and the node user cannot delete them.
docker exec --user root "$CONTAINER" rm -rf /tmp/workflows
docker cp "$HERE/workflows" "$CONTAINER:/tmp/workflows" >/dev/null
docker exec "$CONTAINER" n8n import:workflow --separate --input=/tmp/workflows 2>&1 | tail -3

echo
echo "==> n8n is up:   http://localhost:$PORT"
echo "==> project path to use in the node: /workspace"
echo "==> imported:    $(docker exec "$CONTAINER" node /tmp/ids.js | grep -c '^' ) workflows"
echo "==> next:        E2E_CONTAINER=$CONTAINER node $HERE/run-cases.mjs"
echo "==>              then: node $HERE/verdict.mjs"
echo "==> logs:        docker logs -f $CONTAINER"
