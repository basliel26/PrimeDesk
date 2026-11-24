# PrimeDesk Dedicated Cloud Signaling Server
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy server runtime
COPY src/server ./src/server

# Expose standard signaling port
EXPOSE 9000

ENV PORT=9000
ENV NODE_ENV=production

CMD ["node", "src/server/signaling.js"]
