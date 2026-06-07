FROM node:20-slim

# Install FFmpeg and Python
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libv4l-0 \
    v4l-utils \
    python3 \
    python3-pip \
    curl \
    && pip3 install guessit --break-system-packages \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package*.json ./server/
RUN cd server && npm install --production

COPY server/ ./server/
COPY client/ ./client/

RUN mkdir -p /tmp/freestream-hls /data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s \
    CMD curl -f http://localhost:3000 || exit 1

CMD ["node", "server/index.js"]
