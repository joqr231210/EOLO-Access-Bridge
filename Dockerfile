FROM node:22-alpine
ARG TARGETARCH
ARG GO2RTC_VERSION=v1.9.14

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache ca-certificates wget \
    && case "${TARGETARCH:-$(uname -m)}" in \
      amd64|x86_64) GO2RTC_ASSET="go2rtc_linux_amd64" ;; \
      arm64|aarch64) GO2RTC_ASSET="go2rtc_linux_arm64" ;; \
      *) echo "Unsupported architecture for go2rtc: ${TARGETARCH:-$(uname -m)}" >&2; exit 1 ;; \
    esac \
    && wget -O /usr/local/bin/go2rtc "https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}/${GO2RTC_ASSET}" \
    && chmod +x /usr/local/bin/go2rtc

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY .env.example ./.env.example

RUN mkdir -p /app/data /app/uploads

EXPOSE 8080 1984 8555/tcp 8555/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "const port = process.env.PORT || 8080; fetch('http://127.0.0.1:' + port + '/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "src/server.js"]
