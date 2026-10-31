FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY shared ./shared
COPY relay/src ./relay/src
USER node
EXPOSE 8790
CMD ["node", "relay/src/server.mjs"]
