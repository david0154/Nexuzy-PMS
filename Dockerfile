# Nexuzy PMS Multi-Stage Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 5000

ENV NODE_ENV=production
ENV PORT=5000

VOLUME ["/app/data", "/app/backups"]

CMD ["npm", "start"]
