# Recording environment for docs/assets/demo.tape. See that file for the two commands.
#
# The upstream VHS image carries ttyd and ffmpeg but no Node, and the demo drives the real
# CLI. knowl is installed from npm rather than mounted from this checkout so the recording
# shows the published release rather than whatever is in the working tree; keep the pin in
# step with package.json when re-recording.
FROM ghcr.io/charmbracelet/vhs:latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g @dat999zx/knowl@3.2.2 \
 && rm -rf /var/lib/apt/lists/*
