# Build-Stage: Vite-App bauen
FROM node:22-alpine AS build
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
RUN npm run build

# Laufzeit: nginx liefert die statischen Dateien aus UND reicht /api an
# go2rtc weiter. Das ist bewusst so gebaut: dadurch sehen Browser App und
# go2rtc unter demselben Origin, es gibt kein CORS, und die heiklen
# WebSocket-Einstellungen (Timeouts, Buffering) liegen hier im Repo statt
# von Hand in NPMplus.
FROM nginx:alpine AS web
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

# Nur GO2RTC_HOST ersetzen lassen. Ohne diesen Filter würde envsubst auch
# nginx-eigene Variablen wie $http_upgrade anfassen.
ENV NGINX_ENVSUBST_FILTER="^GO2RTC_"

EXPOSE 80
