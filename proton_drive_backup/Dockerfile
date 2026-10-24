# Node comes from the official image, not Alpine's `nodejs` package: Alpine 3.24
# was still on 24.18.1 after the 2026-10-21 Node security release (24.22.1).
# Same Alpine release as the base, so the musl binary matches. The test suite is
# verified on Node 24. Dependabot bumps tag and digest together.
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS node

# Pinned by digest (the multi-arch index for 3.24) so a re-pushed tag can't
# change what we build on; Dependabot bumps tag and digest together.
FROM ghcr.io/home-assistant/base:3.24@sha256:992dc6a5727b97a30da8dd259b489739299c324407557df540165e2f0dbb7763
# The node binary links libstdc++/libgcc; the upgrade picks up the patched
# ca-certificates (eMudhra roots) the pinned base predates.
RUN apk add --no-cache libstdc++ libgcc && apk upgrade --no-cache ca-certificates ca-certificates-bundle
COPY --from=node /usr/local/bin/node /usr/local/bin/node

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
