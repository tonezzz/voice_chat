ARG NODE_IMAGE=node:20.18-alpine3.20

FROM ${NODE_IMAGE} AS deps

WORKDIR /app

RUN apk upgrade --no-cache

COPY package*.json ./
RUN npm ci --omit=dev

FROM ${NODE_IMAGE} AS runtime

RUN apk upgrade --no-cache && apk add --no-cache --upgrade curl

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 3001
CMD ["npm", "start"]
