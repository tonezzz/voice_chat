# Multistage build to add Cloudflare DNS provider to Caddy via xcaddy
FROM caddy:builder AS builder

RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare

FROM caddy:2.9
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
