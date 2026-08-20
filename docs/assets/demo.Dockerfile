# Recording environment for docs/assets/demo.tape. See that file for the two commands.
#
# The upstream VHS image carries ttyd and ffmpeg but no Node, and the demo drives the real CLI.
#
# knowl is installed from a tarball packed out of THIS checkout, not from npm. The previous
# version pinned `@dat999zx/knowl@3.2.2` with a comment asking whoever re-recorded to keep the
# pin in step with package.json -- and by 5.5.0 the recording on the README was three minor
# versions behind what `npm install -g` actually gave people. A pin that must be hand-maintained
# to stay honest eventually is not. Packing the checkout cannot drift: the GIF shows the code in
# the repository it sits in.
#
#   npm pack --pack-destination docs/assets
#   docker build -f docs/assets/demo.Dockerfile -t knowl-vhs docs/assets
#   docker run --rm -v "$PWD/docs/assets:/vhs" -w /vhs knowl-vhs demo.tape
FROM ghcr.io/charmbracelet/vhs:latest
COPY dat999zx-knowl-*.tgz /tmp/
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g /tmp/dat999zx-knowl-*.tgz \
 && rm -f /tmp/dat999zx-knowl-*.tgz \
 && rm -rf /var/lib/apt/lists/*
