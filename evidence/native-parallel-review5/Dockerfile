FROM node:22-trixie
RUN mkdir -p /bench && cd /bench && npm install --ignore-scripts \
    @relayflows/sdk@2.0.51 @relayflows/surface@2.0.51 \
    @relayflows/runtime-linux-x64@2.0.51 bluebird@3.7.2
COPY dist/ /bench/node_modules/@relayflows/sdk/dist/
COPY replay.mjs /bench/replay.mjs
WORKDIR /bench
