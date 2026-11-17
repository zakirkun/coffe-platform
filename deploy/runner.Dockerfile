# syntax=docker/dockerfile:1
# Static musl build of coffe-runner for the optional `runner` compose profile (team server / VM).
FROM rust:1.100-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
RUN cargo build --release -p coffe-runner

FROM alpine:3.24
RUN apk add --no-cache git openssh-client ca-certificates bash
COPY --from=build /src/target/release/coffe-runner /usr/local/bin/coffe-runner
ENV COFFE_RUNNER_HOME=/var/lib/coffe-runner
VOLUME ["/var/lib/coffe-runner"]
ENTRYPOINT ["coffe-runner"]
CMD ["start"]
