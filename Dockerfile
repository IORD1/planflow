FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js db.js ./
COPY scripts ./scripts
COPY public ./public
ENV NODE_ENV=production PORT=8090
EXPOSE 8090
CMD ["node", "server.js"]
