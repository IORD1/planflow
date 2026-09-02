FROM node:24-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=8090 DB_PATH=/data/planflow.db
EXPOSE 8090
VOLUME ["/data"]
CMD ["node", "--no-warnings", "server.js"]
