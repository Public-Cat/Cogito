FROM node:20-alpine
# Update the bundled npm to the latest release so the build no longer prints an
# "npm update available" notice. Done before npm ci so the install runs on it.
RUN npm install -g npm@latest
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Drop root: image ships a non-root "node" user. chown so it can read/run the app.
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
