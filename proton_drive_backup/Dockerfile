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
        URL="https://proton.me/download/drive/cli/0.8.0/linux-x64-musl/proton-drive"; \
        SHA="51966bfe15eef265604a3561870f42ac0f03ac7adb13b6c3e418f919e3bba95c" ;; \
      aarch64) \
        URL="https://proton.me/download/drive/cli/0.8.0/linux-arm64-musl/proton-drive"; \
        SHA="61f6c21dabe3976d37577caa23406555bfbb0d2954c9924822c90c81107dde7f" ;; \
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
