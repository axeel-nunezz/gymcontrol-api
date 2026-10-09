FROM node:24-alpine

WORKDIR /app

RUN npm install --global pnpm@11.25.0

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --chown=node:node server.js ./
COPY --chown=node:node src ./src

ENV NODE_ENV=production
USER node

EXPOSE 3000

CMD ["npm", "start"]
