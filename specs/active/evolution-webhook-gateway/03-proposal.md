---
slug: evolution-webhook-gateway
proposed_at: 2026-09-22
architecture: Node.js 22 + TypeScript + Fastify + PostgreSQL + Caddy
---

# Propuesta tecnica

## Diseño

Un servicio Node.js 22 en TypeScript con Fastify recibe `POST /v1/evolution`, valida token, limita tamaño, deriva una clave idempotente y hace `INSERT ... ON CONFLICT` en PostgreSQL. Sólo después responde `200`. El JSON se conserva y se reenvía sin transformación. Un fallo de persistencia responde `503`, dejando que Evolution reintente.

Éste es el alcance aceptado del MVP: recepción autenticada, persistencia anterior al ACK, respuesta `200` y entrega transparente a AriCRM.

La implementación adelantó mecanismos previstos para fase 2. Workers reclaman filas con `FOR UPDATE SKIP LOCKED`, reenvían el JSON sin transformarlo y clasifican respuestas: 2xx entregado; 429/5xx reprogramado con backoff y jitter; 401/403 circuito abierto; otros 4xx DLQ. La concurrencia y los timeouts son configurables. Estos mecanismos están desplegados, pero su aceptación depende de pruebas integrales de fallo, recuperación y operación.

Caddy termina TLS. Docker Compose opera gateway y PostgreSQL con healthchecks, límites y volúmenes persistentes. UFW permite 22/80/443. Los secretos viven sólo en `/opt/aricrm-gateway/.env` con modo 600.

## Pruebas

### Fase 1

- Unitarias: autenticación, clave idempotente, clasificación HTTP y backoff básico.
- Operativas: persistencia antes del ACK, healthcheck, TLS, entrega transparente y piloto real.

### Fase 2

- Integración: duplicados, 429→retry→200, timeout→retry, 401/403→circuito y 4xx→DLQ.
- Operativas: destino caído, recuperación gradual, alertas, carga y restauración.
- AriCRM: corregir y verificar el indicador `webhook_logs.processed`.

> Nota: `webhook_logs.processed` permanece en `false` aunque los mensajes sí se procesan; es una inconsistencia preexistente de AriCRM, no un fallo del gateway, pero conviene corregirla en esta fase.

## Rollout

1. Instalar sin tráfico productivo.
2. Configurar DNS `hooks.aricrm.co` y TLS.
3. Enviar fixtures sanitizados y comprobar persistencia, `200`, reenvío idéntico y deduplicación.
4. Cambiar una instancia piloto de Evolution; el gateway recibe y confirma, luego entrega a AriCRM.
5. Observar cola/errores y cerrar la aceptación del MVP.
6. Ejecutar las pruebas de resiliencia de fase 2 y migrar otras 3–5 líneas de bajo riesgo.
7. Migrar el resto únicamente después de superar la ventana de observación acordada.

## Reversión

Restaurar las URLs Evolution directamente a AriCRM. Conservar la base del gateway hasta drenar o exportar pendientes; no borrar eventos durante rollback.
