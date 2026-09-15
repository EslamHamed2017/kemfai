# KEMFAI API/BFF - dev image (infra/docker/docker-compose.yml, T003)
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "dist/main.js"]
