FROM ghcr.io/home-assistant/base:3.21
RUN apk add --no-cache nodejs npm
WORKDIR /app
COPY package.json build.mjs config.yaml ./
COPY src ./src
# build.mjs reads the version from config.yaml — keep it during the build step.
RUN npm install && npm run build && rm -rf node_modules src
COPY run.sh /run.sh
RUN chmod a+x /run.sh
LABEL \
  io.hassio.name="Proton Drive Backup" \
  io.hassio.type="addon"
CMD [ "/run.sh" ]
