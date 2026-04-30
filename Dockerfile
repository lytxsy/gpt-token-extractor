FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN mkdir -p tokens
EXPOSE 8090
CMD ["node", "server.js"]
