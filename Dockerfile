FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
    && python3 -m pip install --break-system-packages --no-cache-dir -U yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

RUN mkdir -p /tmp/linkdrop

ENV NODE_ENV=production
ENV TEMP_DIR=/tmp/linkdrop
ENV PORT=10000

EXPOSE 10000

CMD ["npm", "start"]