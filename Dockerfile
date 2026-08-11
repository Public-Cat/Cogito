FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Drop root: image ships a non-root "node" user. chown so it can read/run the app.
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
