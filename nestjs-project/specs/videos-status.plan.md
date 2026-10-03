---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: nestjs-project/test/videos-status.e2e-spec.ts
---

# GET /videos/:publicId/status — Polling de Processamento Test Plan

## Application Overview

Endpoint de polling pelo qual o **dono** acompanha o ciclo `draft → processing → ready | failed`. Não há push do worker para a API: o frontend descobre que o processamento terminou consultando esta rota repetidamente.

A resposta é uma projeção que varia por estado. Em `draft`/`processing` só há `public_id` e `status`. Em `ready` entram os metadados extraídos pelo FFmpeg (`duration_seconds`, `width`, `height`) e uma `thumbnail_url` presigned. Em `failed` entra o `failure_reason`. A rota é exclusiva do dono — qualquer outro requisitante (autenticado ou não) recebe `404 VIDEO_NOT_FOUND`, sem distinção entre "não existe" e "não é seu".

## Test Scenarios

### 1. Projeção por estado do ciclo

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()`; reproduzir a config global de `main.ts` (`ValidationPipe({ whitelist: true })` + filtro de exceções de domínio); registrar e autenticar o usuário **A** (dono, com canal) e o usuário **B**; helper `seedVideo(status, overrides)` que insere uma linha em `videos` no canal de A com o estado desejado (evita depender do worker real no E2E); `beforeEach` limpa `videos`; `afterAll` chama `app.close()`.

#### 1.1. reports-processing-without-metadata

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. Semear um vídeo de A em `status = 'processing'` (sem metadados) e fazer GET /videos/:publicId/status como A
    - expect: status 200
    - expect: corpo tem `public_id` e `status: "processing"`
    - expect: corpo NÃO traz `duration_seconds`, `width`, `height` nem `thumbnail_url`
    - expect: corpo NÃO traz `failure_reason`

#### 1.2. reports-ready-with-metadata-and-thumbnail

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. Semear um vídeo de A em `status = 'ready'` com `duration_seconds: 128`, `width: 1920`, `height: 1080`, `codec: 'h264'`, `bitrate: 2500000` e um `thumbnail_key` existente no bucket; fazer GET /videos/:publicId/status como A
    - expect: status 200
    - expect: `status: "ready"`
    - expect: `duration_seconds` = 128, `width` = 1920, `height` = 1080
    - expect: `thumbnail_url` é uma URL absoluta para o object storage, com query params de assinatura
    - expect: corpo NÃO expõe `thumbnail_key`, `storage_key` nem o `id` interno
    - expect: corpo NÃO traz `failure_reason`
  2. Fazer GET na `thumbnail_url` devolvida
    - expect: status 200 e `content-type` de imagem — a URL presigned é utilizável de fato

#### 1.3. reports-failed-with-reason

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. Semear um vídeo de A em `status = 'failed'` com `failure_reason: 'ffprobe: invalid data found when processing input'` e fazer GET /videos/:publicId/status como A
    - expect: status 200
    - expect: `status: "failed"`
    - expect: `failure_reason` é a string persistida
    - expect: corpo NÃO traz `thumbnail_url`

#### 1.4. reports-draft-before-upload-completes

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. A inicia um upload via POST /videos (vídeo em `draft`) e faz GET /videos/:publicId/status como A
    - expect: status 200
    - expect: `status: "draft"`
    - expect: corpo NÃO traz metadados nem `failure_reason`

### 2. Posse e autenticação

**Setup:** mesmo bootstrap da seção 1; **B** é um usuário autenticado que não é dono do vídeo de A.

#### 2.1. hides-video-from-authenticated-non-owner

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. Semear um vídeo de A em `status = 'ready'` e fazer GET /videos/:publicId/status autenticado como B
    - expect: status 404
    - expect: corpo carrega `errorCode: "VIDEO_NOT_FOUND"` — nunca 403, para não vazar existência
  2. Repetir com o vídeo de A em `status = 'processing'`
    - expect: status 404 com `errorCode: "VIDEO_NOT_FOUND"`

#### 2.2. returns-404-for-unknown-public-id

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. GET /videos/aaaaaaaaaaaa/status autenticado como A (`public_id` bem formado que não existe)
    - expect: status 404
    - expect: corpo carrega `errorCode: "VIDEO_NOT_FOUND"`
    - expect: a resposta é indistinguível da do cenário 2.1

#### 2.3. rejects-anonymous-status-request

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. Semear um vídeo de A em `status = 'ready'` e fazer GET /videos/:publicId/status sem header `Authorization`
    - expect: status 401 — a rota de status é exclusiva do dono, mesmo para vídeo já público
