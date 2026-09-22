---
slug: evolution-webhook-gateway
title: Gateway durable para webhooks de Evolution
status: proposed
created: 2026-09-22
author: Codex por solicitud de Nicolas
---

# User Story

Como operador de AriCRM, quiero que los webhooks de Evolution entren por un gateway aislado y durable, para que una tormenta de reintentos, una clave inválida o una caída temporal de AriCRM no vuelva a saturar Waterfall ni provoque pérdida silenciosa de eventos.

## Contexto

El 2026-09-22 OrionDesign envió decenas de miles de solicitudes con una clave que no coincidía con la configuración cacheada de Laravel. PHP-FPM agotó sus 20 workers y Nginx respondió 499/502/504. La mitigación bloqueó temporalmente la IP, reconstruyó la caché y restauró servicio.

Se aprovisionó `aricrm-webhook-gateway` en Hetzner Helsinki, IP pública `95.217.235.134`, red privada `10.0.0.2`, CPX22 y Ubuntu 24.04.

## Alcance

### Fase 1 — MVP reducido

Gateway independiente y autenticado que funciona como transporte transparente:

1. recibe el JSON de Evolution;
2. lo persiste sin transformarlo en PostgreSQL;
3. responde `200` únicamente después de la persistencia;
4. envía asíncronamente el mismo payload a AriCRM.

El MVP no transforma, interpreta, filtra ni unifica perfiles LID/PN. Su objetivo es validar el recorrido Evolution → gateway durable → AriCRM con una instancia piloto y rollback inmediato.

### Capacidades adelantadas, pendientes de aceptación en fase 2

La implementación contiene idempotencia, concurrencia limitada, reintentos con backoff, circuit breaker, DLQ y retención. Estas capacidades exceden el alcance solicitado para el MVP reducido y no se consideran aceptadas hasta superar las pruebas específicas de fallo y operación definidas para la fase 2.
