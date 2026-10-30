#!/usr/bin/env bash
# Stand-in for the FVP_Corstone_SSE-300_Ethos-U55 executable, referenced from
# the `debugger: model:` node of the MPS3 target-set. The CMSIS Solution
# extension runs it both as the "CMSIS Run" task and as the gdbtarget debug
# server, in the latter case with
#
#   -D --plugin $AVH_FVP_PLUGINS/GDBServer.so -C GDBServer.port=3333 \
#      -f fvp_config.txt -a <application>.elf
#
# It does what the bare model command cannot:
#
#   * resolves plugins/GDBServer.so itself. The generated launch config takes
#     the path from $AVH_FVP_PLUGINS, which may be unset in VS Code
#     when the model was installed separately or the editor inherited no tools environment.
#   * runs the model in Docker on macOS, where Arm publishes no FVP build, with
#     the GDB port forwarded to the host so arm-none-eabi-gdb can reach it.
#   * on macOS, refuses a GDB port that another folder's model or any other
#     program listens on (GDB would reach that server, not this model), and
#     removes its container when the debug adapter stops it or goes away.
#
# On Linux and Windows (git-bash/MSYS) it just execs the real model.
set -euo pipefail

MODEL="${FVP_MODEL:-FVP_Corstone_SSE-300_Ethos-U55}"
FVP_VERSION="${FVP_VERSION:-11.32.23}"          # Docker model release; native hosts install the model separately
IMAGE="${FVP_IMAGE:-cmsis-fvp:${FVP_VERSION}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

is_macos() { [[ "$(uname -s)" == "Darwin" ]]; }

# Where GDBServer.so lives, given that $AVH_FVP_PLUGINS is often unset.
plugin_dir() {
    if is_macos; then
        echo "/opt/avh-fvp/plugins"                       # inside the container
        return
    fi
    if [[ -n "${AVH_FVP_PLUGINS:-}" && -d "${AVH_FVP_PLUGINS}" ]]; then
        echo "${AVH_FVP_PLUGINS%/}"
        return
    fi
    local model_path
    model_path="$(command -v "${MODEL}" 2>/dev/null || true)"
    [[ -n "${model_path}" ]] && echo "$(dirname "$(dirname "$(realpath "${model_path}")")")/plugins"
}

# Rewrite `--plugin <path>` when <path> does not resolve, and pick the GDB port
# out of `-C GDBServer.port=<n>` so the macOS branch knows what to forward.
ARGS=()
GDB_PORT=""
ALLOW_REMOTE_SET=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --plugin)
            plugin="${2:-}"
            if [[ ! -f "${plugin}" ]] || is_macos; then
                dir="$(plugin_dir)"
                [[ -n "${dir}" ]] && plugin="${dir}/$(basename "${plugin}")"
            fi
            ARGS+=("--plugin" "${plugin}")
            shift 2
            ;;
        -C)
            [[ "${2:-}" == GDBServer.port=* ]] && GDB_PORT="${2#GDBServer.port=}"
            [[ "${2:-}" == GDBServer.allow_remote=* ]] && ALLOW_REMOTE_SET=1
            ARGS+=("-C" "${2:-}")
            shift 2
            ;;
        -C*)
            [[ "$1" == -CGDBServer.port=* ]] && GDB_PORT="${1#-CGDBServer.port=}"
            [[ "$1" == -CGDBServer.allow_remote=* ]] && ALLOW_REMOTE_SET=1
            ARGS+=("$1")
            shift
            ;;
        *)
            ARGS+=("$1")
            shift
            ;;
    esac
done

# The model block-buffers its own stdout whenever it is a pipe -- which it
# always is under VS Code -- so "GDBServer: Listening ... port=3333" and every
# semihosting printf sit in a 4KB buffer until the model exits. The debug
# adapter waits for that banner to know the server is up (target.serverPortRegExp
# in launch.json), so without line buffering it gives up and kills the model
# just before the line it was waiting for gets flushed.
RUNNER=()
command -v stdbuf >/dev/null 2>&1 && RUNNER=(stdbuf -oL -eL)

if ! is_macos; then
    command -v "${MODEL}" >/dev/null 2>&1 || {
        echo "${MODEL} not found on PATH. Install the MDK FVP model separately," >&2
        echo "then add it to PATH or set FVP_MODEL to its full executable path." >&2
        exit 1
    }
    exec "${RUNNER[@]}" "${MODEL}" "${ARGS[@]}"
fi

# ---------------------------------------------------------------- macOS/Docker
docker info >/dev/null 2>&1 || {
    echo "Docker is not running. On macOS the FVP runs in a container because" >&2
    echo "Arm ships no macOS build of the model." >&2
    exit 1
}

if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
    case "$(uname -m)" in
        arm64|aarch64) arch="arm64" ;;
        *)             arch="x86" ;;
    esac
    archive="mdk-fvp-${FVP_VERSION%.*}_${FVP_VERSION##*.}_linux_${arch}.tar.gz"
    echo "Building ${IMAGE} from ${archive} (first run only, ~100MB download)."
    echo "By using these models you accept the Arm FVP End User License Agreement:"
    echo "  https://artifacts.tools.arm.com/avh/${FVP_VERSION}/license_agreement.txt"
    docker build -t "${IMAGE}" -f "${HERE}/fvp.Dockerfile" \
        --build-arg "FVP_VERSION=${FVP_VERSION}" \
        --build-arg "FVP_ARCHIVE=${archive}" \
        --build-arg "USERNAME=$(whoami)" \
        --build-arg "USERID=$(id -u)" \
        "${HERE}" >&2
fi

PORTS=()
CONTAINER="cmsis-fvp-run-$$"
if [[ -n "${GDB_PORT}" ]]; then
    PORTS=(-p "${GDB_PORT}:${GDB_PORT}")
    # GDBServer binds to localhost unless told otherwise, and a connection
    # arriving through Docker's port forwarder is not localhost as far as the
    # container is concerned -- without this GDB's first packet is met with a
    # connection reset.
    [[ "${ALLOW_REMOTE_SET}" == "0" ]] && ARGS+=("-C" "GDBServer.allow_remote=1")
    CONTAINER="cmsis-fvp-${GDB_PORT}"
    # A container this folder's debug session left behind still holds the port:
    # remove it. One that another folder's session runs is not ours to remove --
    # that would end the other window's model under its debugger.
    owner="$(docker inspect -f '{{ index .Config.Labels "cmsis.fvp.folder" }}' "${CONTAINER}" 2>/dev/null || true)"
    running="$(docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null || true)"
    if [[ "${running}" == "true" && -n "${owner}" && "${owner}" != "${PWD}" ]]; then
        echo "GDB port ${GDB_PORT} is taken by the FVP of ${owner}: stop that debug session first, or give this project another GDBServer.port in .vscode/launch.json." >&2
        exit 1
    fi
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
    # A GDB server that listens on the port already -- pyOCD or J-Link under a
    # CMSIS Run task -- answers GDB's localhost:<port> before Docker does, and
    # GDB would debug that board instead of the model.
    holder="$(lsof -nP -iTCP:"${GDB_PORT}" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}' || true)"
    if [[ -n "${holder}" ]]; then
        echo "GDB port ${GDB_PORT} is taken by ${holder}: GDB would reach that server instead of the model. Stop it, or give this project another GDBServer.port in .vscode/launch.json." >&2
        exit 1
    fi
fi

# $HOME is bind-mounted at the same path so the ELF, the config file and
# ~/.armlm are reachable under the paths the extension passes in.
MOUNTS=(--mount "type=bind,src=${HOME}/,dst=${HOME}/")
[[ "${PWD}" == "${HOME}"* ]] || MOUNTS+=(--mount "type=bind,src=${PWD}/,dst=${PWD}/")

# The container runs in the background so that this script stays between the
# debug adapter and Docker. The adapter's SIGTERM becomes one `docker rm -f`:
# Docker's signal proxy would hand the model every signal, and a second SIGTERM
# leaves it hanging in "Terminating simulation..." with the port held. When the
# adapter goes without a signal -- VS Code ends it after a stop that never
# finished -- its stdin pipe closes, and the container goes too.
remove_container() { docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true; }
trap 'remove_container; exit 143' TERM INT HUP
docker run --rm --init --sig-proxy=false --name "${CONTAINER}" \
    --label "cmsis.fvp.folder=${PWD}" "${PORTS[@]}" "${MOUNTS[@]}" \
    --workdir "${PWD}" \
    --env "ARMLM_CACHED_LICENSES_LOCATION=${HOME}/.armlm" \
    "${IMAGE}" stdbuf -oL -eL "${MODEL}" "${ARGS[@]}" </dev/null &
model=$!
{ cat >/dev/null; remove_container; } <&0 &
watcher=$!
status=0
wait "${model}" || status=$?
kill "${watcher}" 2>/dev/null || true
exit "${status}"
