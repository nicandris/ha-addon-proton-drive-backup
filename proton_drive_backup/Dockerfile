FROM ghcr.io/home-assistant/base:3.24
# Pin the Node MAJOR explicitly: Alpine 3.23+ ships Node 24, and an unpinned
# `apk add nodejs` would silently follow the base image to a new major.
# The test suite is verified on Node 24.
RUN apk add --no-cache 'nodejs~=24'

# HA provides BUILD_ARCH (amd64 | aarch64 | armv7 | ...). Only amd64/aarch64 have
# a musl proton-drive build, so anything else fails the build explicitly.
ARG BUILD_ARCH
RUN set -eu; \
    case "${BUILD_ARCH}" in \
      amd64) \
        URL="https://proton.me/download/drive/cli/0.9.0/linux-x64-musl/proton-drive"; \
        SHA="62e27deddcf6329ec92270a03312f460b2da95d0ef9c6e581c91b712c5147558" ;; \
      aarch64) \
        URL="https://proton.me/download/drive/cli/0.9.0/linux-arm64-musl/proton-drive"; \
        SHA="54eeb5912078dd7ccbf657691748f7af252acb860e4859c9d08eb22fe9f25b5f" ;; \
      *) echo "unsupported arch: ${BUILD_ARCH}" && false ;; \
    esac; \
    wget -O /usr/local/bin/proton-drive "${URL}"; \
    echo "${SHA}  /usr/local/bin/proton-drive" | sha256sum -c -; \
    chmod +x /usr/local/bin/proton-drive

WORKDIR /app
# No build step — Node runs the source directly.
COPY src ./src
COPY run.sh /run.sh
RUN chmod a+x /run.sh
LABEL \
  io.hassio.name="Proton Drive Backup" \
  io.hassio.type="addon"
CMD [ "/run.sh" ]
