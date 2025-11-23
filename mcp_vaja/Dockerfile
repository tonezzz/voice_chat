FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . ./

ENV PORT=8017
EXPOSE 8017

CMD ["npm", "start"]
