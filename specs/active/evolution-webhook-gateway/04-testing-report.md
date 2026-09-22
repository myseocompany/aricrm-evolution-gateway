---
slug: evolution-webhook-gateway
tested_at: 2026-09-22
environment: Hetzner gateway staging
---

# Informe de pruebas

## Automatizadas

- `npm run typecheck`: OK.
- `npm test`: OK (3/3): clave idempotente, clasificación HTTP y backoff/token.
- `npm run build`: OK; el artefacto de arranque es `dist/server.js`.
- `npm run test:integration`: OK en un host con Docker (idempotencia exacta, `503` con reintento, timeout con reintento, `422` a DLQ, circuit breaker para `401` y `403`, y recuperación del circuito tras reinicio). La última repetición local se omitió porque Docker no estaba disponible en esa sesión.

## Operativas en 95.217.235.134

- Docker Compose: PostgreSQL saludable y gateway saludable.
- `GET /healthz` a través de Caddy: `200 {"ok":true}`.
- `POST /v1/evolution` autenticado con fixture sanitizado: `200 {"ok":true,"id":"1"}`.
- Métricas posteriores: un evento en estado `delivered`, sin circuito abierto.
- La entrega fue reenviada a AriCRM desde la cola, tras persistirse primero en PostgreSQL.
- Los headers de autenticación y el parámetro `token` de la URL se eliminan de los access logs de Caddy.
- UFW activo: entrada permitida únicamente por SSH, HTTP y HTTPS; fail2ban activo.
- DNS y TLS: `https://hooks.aricrm.co/healthz` responde `200`; HTTP redirige a HTTPS.
- Smoke test HTTPS público: `POST /v1/evolution` respondió `200`, quedó `delivered` y el parámetro `token` no apareció en logs.

## Piloto

- Instancia: `line_56e08751ac91` (My SEO Company, línea Principal).
- Migrada el 2026-09-22 a `https://hooks.aricrm.co/v1/evolution`.
- Conserva los cinco eventos anteriores: `MESSAGES_UPSERT`, `MESSAGES_UPDATE`, `CONNECTION_UPDATE`, `QRCODE_UPDATED` y `CONTACTS_UPSERT`.
- Se creó una copia privada de la configuración anterior en el servidor Evolution, con permisos restringidos, para rollback.
- Se observaron 41 eventos reales del piloto: todos quedaron `delivered`, en un intento y con respuesta `200` de AriCRM.
- AriCRM materializó los mensajes del piloto; la validación encontró mensajes entrantes y salientes con identificador del proveedor.

## Fase 2 completada antes de ampliar el piloto

- La prueba integral cubre reintentos, timeout, circuito y DLQ con PostgreSQL real en Docker.
- `/metrics` exige un token independiente (`X-Gateway-Metrics-Token`) y expone solamente contadores, antigüedad de pendientes y estado del circuito.
- `monitor.sh` y el timer systemd incluido alertan por syslog —y opcionalmente a un webhook— ante pendientes envejecidos, DLQ o disco Docker alto.
- El monitor se ejecutó manualmente en Hetzner tras su instalación y terminó con `Result=success`; su timer quedó `active`.
- La corrección de `webhook_logs.processed` se entrega en AriCRM, separada del repositorio del gateway.

> Nota: `webhook_logs.processed` permanece en `false` aunque los mensajes sí se procesan; es una inconsistencia preexistente de AriCRM, no un fallo del gateway, pero conviene corregirla en esta fase.
