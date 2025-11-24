FROM node:20-slim

WORKDIR /app

COPY shared ./shared
COPY mcp_vaja ./mcp_vaja

WORKDIR /app/mcp_vaja
RUN npm install --production

ENV PORT=8017
EXPOSE 8017

CMD ["npm", "start"]
