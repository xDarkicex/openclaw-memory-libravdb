# ── Runtime image — pulls pre-built binary from GitHub releases ──
FROM alpine:3.21

ARG TARGETARCH

RUN apk add --no-cache ca-certificates curl tzdata && \
    adduser -D -h /var/lib/libravdbd libravdb

# Download daemon binary from public releases
ARG LIBRAVDBD_VERSION=latest
RUN if [ "$LIBRAVDBD_VERSION" = "latest" ]; then \
        VERSION=$(curl -s https://api.github.com/repos/zephyr-systems/libravdbd/releases/latest | grep tag_name | cut -d'"' -f4); \
    else \
        VERSION="v${LIBRAVDBD_VERSION}"; \
    fi && \
    case "${TARGETARCH}" in \
        amd64) ARCH="amd64";; \
        arm64) ARCH="arm64";; \
        *) ARCH="amd64";; \
    esac && \
    curl -sL "https://github.com/zephyr-systems/libravdbd/releases/download/${VERSION}/libravdbd-linux-${ARCH}" \
        -o /usr/local/bin/libravdbd && \
    chmod +x /usr/local/bin/libravdbd

RUN mkdir -p /var/lib/libravdbd/data /var/lib/libravdbd/models /var/lib/libravdbd/run && \
    chown -R libravdb:libravdb /var/lib/libravdbd

ENV LIBRAVDB_DB_PATH=/var/lib/libravdbd/data/data.libravdb \
    LIBRAVDB_GRPC_ENDPOINT=tcp:0.0.0.0:50051 \
    LIBRAVDB_EMBEDDING_BACKEND=gguf

EXPOSE 50051

USER libravdb
WORKDIR /var/lib/libravdbd

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD libravdbd health

ENTRYPOINT ["libravdbd", "serve"]
