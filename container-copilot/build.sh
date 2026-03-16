#!/usr/bin/env bash
# Build the NanoClaw Copilot agent container image.
# Usage: ./build.sh [tag] [--model MODEL]
#   tag    Docker image tag (default: latest)
#   --model  Copilot model baked into the image (default: gpt-4o)
#
# Examples:
#   ./build.sh                              # nanoclaw-copilot-agent:latest with gpt-4o
#   ./build.sh latest --model gpt-4o        # explicit
#   ./build.sh latest --model claude-3.5-sonnet  # use Claude via Copilot API

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-copilot-agent"
TAG="${1:-latest}"
COPILOT_MODEL="gpt-4o"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Parse --model flag
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) COPILOT_MODEL="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

echo "Building NanoClaw Copilot agent container image..."
echo "  Image: ${IMAGE_NAME}:${TAG}"
echo "  Model: ${COPILOT_MODEL}"

${CONTAINER_RUNTIME} build \
  --build-arg COPILOT_MODEL="${COPILOT_MODEL}" \
  -t "${IMAGE_NAME}:${TAG}" \
  .

echo ""
echo "Build complete!"
echo "  Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "To use this image, add to your .env:"
echo "  CONTAINER_IMAGE=${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | \\"
echo "    ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
