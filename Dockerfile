FROM node:20-alpine AS build

RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

FROM node:20-alpine AS runtime

RUN apk add --no-cache openssl
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build
COPY --from=build /app/public ./public

# setup runs prisma generate + prisma migrate deploy before the web process.
CMD ["npm", "run", "docker-start"]
