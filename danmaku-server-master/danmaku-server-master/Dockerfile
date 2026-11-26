FROM docker.m.daocloud.io/library/rust:alpine AS builder
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories && apk add build-base yarn
WORKDIR /app
ENV NODE_OPTIONS=--dns-result-order=ipv4first
COPY frontend/package.json frontend/yarn.lock /app/frontend/
RUN sed -i 's#https://registry.yarnpkg.com/#https://registry.npmmirror.com/#g' frontend/yarn.lock
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
    yarn --cwd frontend install --frozen-lockfile --network-timeout 60000 --network-concurrency 4
COPY . /app
RUN yarn --cwd frontend build
RUN --mount=type=cache,target=/usr/local/cargo,from=docker.m.daocloud.io/library/rust:alpine,source=/usr/local/cargo \
    --mount=type=cache,target=target \
    printf '[source.crates-io]\nreplace-with = "rsproxy-sparse"\n[source.rsproxy-sparse]\nregistry = "sparse+https://rsproxy.cn/index/"\n' > /usr/local/cargo/config.toml && cargo build --release && cp target/release/danmaku-server .

FROM docker.m.daocloud.io/library/alpine:latest
COPY --from=builder /app/danmaku-server /usr/local/bin
ENTRYPOINT ["danmaku-server"]
