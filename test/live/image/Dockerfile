# The Desk live-test image (docs/IMPLEMENTATION.md §17.3), ported from the 2026-10-06 Colima lab. scripts/live.mjs
# builds it in the Colima VM only, and only when a file in test/live/image changes. Branded Google Chrome on a private
# Xvfb display, Node 26, zsh and tmux, agent-browser, and the Puppeteer and Playwright cores. Nothing here can reach the
# Mac's screen: the display is a virtual framebuffer inside the container, and the suite runs with no network.
#
# Bumping Chrome: change CHROME_DEB and CHROME_SHA256 together, from
# https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-arm64/Packages. The runner downloads the .deb once
# into the desk-live-cache volume (Google prunes old builds from its pool) and streams it into this build's context.

ARG DEBIAN_IMAGE=debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

# Stage 1: what the runner needs to fill the cache volume and stream the build context (curl, the verified download).
FROM ${DEBIAN_IMAGE} AS fetch
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    TZ=UTC
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 fetch-verified build-context /usr/local/bin/

# Stage 2: the live image.
FROM fetch AS live
ARG CHROME_DEB=google-chrome-stable_155.0.8059.39-1_arm64.deb
ARG CHROME_SHA256=3556494580a71ecee15cbeb3b6ce23bf3af360bc053d90d3105241c2247da52b
ARG NODE_VERSION=26.10.0
ARG NODE_SHA256=7a6353f63eb3d04765004b4adf172616243e4522434635cb1d26288658b04ab5
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

# The virtual display, the shells, the process tools Desk's adapters call, and fonts. Debian's Chromium is not used:
# it is 154, below the extension's minimum.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini procps lsof xz-utils \
      xvfb xdotool \
      zsh tmux \
      fonts-dejavu-core fonts-liberation fonts-noto-mono \
 && rm -rf /var/lib/apt/lists/*

# Branded Google Chrome stable for linux-arm64, pinned by sha256 (verified again here; the runner verified it first).
COPY ${CHROME_DEB} /tmp/chrome.deb
RUN echo "${CHROME_SHA256}  /tmp/chrome.deb" | sha256sum --check --strict - \
 && apt-get update \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb /etc/apt/sources.list.d/google-chrome.list* /etc/cron.daily/google-chrome \
 && rm -rf /var/lib/apt/lists/* \
 && google-chrome-stable --version

# Node from the official linux-arm64 tarball, pinned by sha256.
RUN fetch-verified "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" \
      "${NODE_SHA256}" /tmp/node.tar.xz \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
 && rm /tmp/node.tar.xz \
 && node --version && npm --version

# npm tools only the image has, pinned by integrity in tools/package-lock.json and installed without install scripts
# (lint:install-scripts reviews that lockfile too). agent-browser's tarball already holds its glibc linux-arm64 binary:
# keep only that one, make it executable and link it, which is all its postinstall would do.
COPY tools/package.json tools/package-lock.json /opt/desk-live/tools/
RUN cd /opt/desk-live/tools \
 && npm ci --ignore-scripts \
 && ab=/opt/desk-live/tools/node_modules/agent-browser/bin \
 && find "$ab" -maxdepth 1 -name 'agent-browser-*' ! -name 'agent-browser-linux-arm64' -delete \
 && chmod 0755 "$ab/agent-browser-linux-arm64" \
 && ln -s "$ab/agent-browser-linux-arm64" /usr/local/bin/agent-browser \
 && agent-browser --version

# The unprivileged user everything runs as (Chrome never runs as root), with zsh as its login shell. /work is where the
# suite runs; /work/node_modules is where the dependency volume mounts; /cache is where the cache volume mounts.
RUN useradd --create-home --uid 1000 --shell /usr/bin/zsh lab \
 && install -d -o lab -g lab -m 0755 /work /work/node_modules /cache \
 && install -d -m 1777 /tmp/.X11-unix

USER lab
WORKDIR /home/lab
ENV DISPLAY=:99
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--version"]
