FROM ghcr.io/home-assistant/base:3.21
RUN apk add --no-cache nodejs

# HA provides BUILD_ARCH (amd64 | aarch64 | armv7 | ...). Only amd64/aarch64 have
# a musl proton-drive build, so anything else fails the build explicitly.
ARG BUILD_ARCH
RUN set -eu; \
    case "${BUILD_ARCH}" in \
      amd64) \
        URL="https://proton.me/download/drive/cli/0.6.0/linux-x64-musl/proton-drive"; \
        SHA="316581e793c0a033ecd43c98f85b19ae4ccd7a9755e86a901ee86774de16fac1" ;; \
      aarch64) \
        URL="https://proton.me/download/drive/cli/0.6.0/linux-arm64-musl/proton-drive"; \
        SHA="76edb2eb20d2db39ea36dee76161072cc611ab441d8ed2ba79cbd629ac6effc7" ;; \
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
