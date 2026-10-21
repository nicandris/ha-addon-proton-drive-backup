FROM ghcr.io/home-assistant/base:3.24
# Pin the Node MAJOR explicitly: Alpine 3.23+ ships Node 24, and an unpinned
# `apk add nodejs` would silently follow the base image to a new major.
# The test suite is verified on Node 24.
RUN apk add --no-cache 'nodejs~=24'

# HA provides BUILD_ARCH (amd64 | aarch64 | armv7 | ...). Only amd64/aarch64 have
# a musl proton-drive build, so anything else fails the build explicitly.
#
# The SHA-512s are PROTON'S PUBLISHED checksums (`Sha512CheckSum` per file in
# https://proton.me/download/drive/cli/version.json), not hashes of whatever we
# happened to download first. When bumping, copy them from that file. If a build
# ever fails here while the version is unchanged, Proton's file changed under a
# published version: treat it as a security incident — do NOT just update the hash.
ARG BUILD_ARCH
RUN set -eu; \
    case "${BUILD_ARCH}" in \
      amd64) \
        URL="https://proton.me/download/drive/cli/0.9.0/linux-x64-musl/proton-drive"; \
        SHA="8f99c3bc478ebc2948ca69c8576a48d83b3290d807ca61fac9b0f5d0a91c0d418e595232d67e2ae0173d2188963771afd4292aefafab3f64e808a61c4399d6ed" ;; \
      aarch64) \
        URL="https://proton.me/download/drive/cli/0.9.0/linux-arm64-musl/proton-drive"; \
        SHA="4b632e5e694f6d0825aaa57f39f99494aa6a46eac45e90d65daa10b2e46316046b627d3c1145cb9c7d58951735cc6e81c28cca44dda648b411315a28d04b2acf" ;; \
      *) echo "unsupported arch: ${BUILD_ARCH}" && false ;; \
    esac; \
    wget -O /usr/local/bin/proton-drive "${URL}"; \
    echo "${SHA}  /usr/local/bin/proton-drive" | sha512sum -c -; \
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
