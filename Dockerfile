FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY server.js api.js users.js official-engine.js calculator.js ./
COPY games ./games
COPY public ./public
EXPOSE 3000
CMD ["npm", "start"]
