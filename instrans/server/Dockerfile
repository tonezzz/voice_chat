# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=20.18.0
FROM node:${NODE_VERSION}-alpine

WORKDIR /app

RUN apk add --no-cache curl

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=3100

EXPOSE 3100
CMD ["node", "src/index.js"]
