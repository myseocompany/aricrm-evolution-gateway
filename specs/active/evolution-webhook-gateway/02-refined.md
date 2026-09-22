---
slug: evolution-webhook-gateway
refined_at: 2026-09-22
---

# Historia refinada

## Criterios de aceptación — fase 1

- **AC1:** un webhook autenticado se persiste antes de responder `200`. Si la escritura durable falla, responde `503` y no acusa recibo.
- **AC2:** el payload se conserva y se entrega a AriCRM sin transformación funcional.
- **AC3:** `/healthz` comprueba proceso y PostgreSQL; ningún payload o secreto aparece en logs.
- **AC4:** el host expone sólo 22/80/443, usa TLS, backups y servicios con límites/restart policy.
- **AC5:** una instancia piloto completa el recorrido Evolution → gateway → AriCRM y puede volver a su webhook anterior mediante el backup de configuración.

## Criterios de aceptación — fase 2

- **AC6:** reenvíos del mismo evento no crean más de una entrega lógica.
- **AC7:** el gateway limita concurrencia hacia AriCRM y reintenta 429/5xx con backoff y jitter.
- **AC8:** 401/403 del destino abren circuito y no producen una tormenta de reintentos.
- **AC9:** eventos agotados quedan en DLQ consultable y recuperable.
- **AC10:** métricas y alertas cubren pendientes, edad de cola, entregados, DLQ y espacio en disco.
- **AC11:** se ejecutan pruebas de caída, timeout, recuperación y carga antes del rollout amplio.
- **AC12:** `webhook_logs.processed` refleja correctamente que AriCRM procesó el evento.

> Nota: `webhook_logs.processed` permanece en `false` aunque los mensajes sí se procesan; es una inconsistencia preexistente de AriCRM, no un fallo del gateway, pero conviene corregirla en esta fase.

## No funcionales

- Respuesta `200` p95 menor de 200 ms después del commit local.
- Payload máximo 2 MiB y retención configurable, inicial 72 horas para entregados.
- PostgreSQL durable; Redis no es fuente de verdad.
- Tokens separados para ingreso y entrega; comparación constante.
- Despliegue reversible sin modificar la base de AriCRM.

Los objetivos de reintentos, DLQ, circuito y observabilidad avanzada pertenecen a la aceptación de fase 2, aunque parte de su código ya esté desplegado.

## Fuera de alcance

- Transformar el contrato de Evolution.
- Resolver LID/PN dentro del gateway.
- Interpretar, filtrar o enriquecer eventos antes de persistirlos y reenviarlos.
- Pasar webhooks Meta Cloud API por este gateway en la primera versión.
