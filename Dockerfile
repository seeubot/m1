FROM node:20-alpine
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm install --production
COPY server/ ./server/
COPY mobile/ ./mobile/
WORKDIR /app/server
EXPOSE 3000
CMD ["node", "index.js"]
