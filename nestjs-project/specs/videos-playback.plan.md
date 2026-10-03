---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: nestjs-project/test/videos-playback.e2e-spec.ts
---

# Playback Público (metadata / stream / download) Test Plan

## Application Overview

As três rotas públicas que servem o vídeo pronto, todas resolvidas pelo `public_id`:

- `GET /videos/:publicId` — metadados públicos (a API por trás da página `/watch/:publicId` do frontend).
- `GET /videos/:publicId/stream` — autoriza a reprodução e emite uma URL presigned de curta duração capaz de responder a `Range` (seeking).
- `GET /videos/:publicId/download` — mesma mecânica, com `response-content-disposition: attachment` para entregar o arquivo original.

A API só **autoriza e assina** — os bytes saem direto do MinIO. O gate desta fase é `status = 'ready'` + posse: qualquer um (inclusive anônimo) acessa um vídeo `ready`; um vídeo não-`ready` é invisível para não-donos (`404 VIDEO_NOT_FOUND`, sem vazar existência), enquanto o dono recebe `409 VIDEO_NOT_READY` — a distinção entre os dois códigos é justamente o que não pode vazar para terceiros.

## Test Scenarios

### 1. Metadata pública

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()`; reproduzir a config global de `main.ts` (`ValidationPipe({ whitelist: true })` + filtro de exceções de domínio); registrar e autenticar o usuário **A** (dono, com canal) e o usuário **B**; helper `seedReadyVideo(overrides)` que insere em `videos` uma linha `ready` de A com `storage_key`/`thumbnail_key` de objetos realmente presentes no bucket de teste; `beforeEach` limpa `videos`; `afterAll` chama `app.close()`.

#### 1.1. returns-public-metadata-for-ready-video

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. Semear um vídeo `ready` de A com `title: 'Meu clipe'`, `duration_seconds: 128`, `width: 1920`, `height: 1080` e fazer GET /videos/:publicId **sem autenticação**
    - expect: status 200
    - expect: corpo tem `public_id`, `title`, `status: "ready"`, `duration_seconds`, `width`, `height`, `thumbnail_url`, `created_at`
    - expect: `created_at` é uma string ISO-8601 parseável
    - expect: `thumbnail_url` é URL absoluta assinada do object storage
    - expect: corpo NÃO expõe `id` interno, `channel_id`, `storage_key`, `thumbnail_key` nem `upload_id`
  2. Repetir o mesmo GET autenticado como B (não-dono) e como A (dono)
    - expect: status 200 nos dois casos, com o mesmo corpo do passo 1

### 2. Streaming

**Setup:** mesmo bootstrap da seção 1.

#### 2.1. issues-range-capable-stream-url

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. Semear um vídeo `ready` de A e fazer GET /videos/:publicId/stream sem autenticação
    - expect: status 200
    - expect: corpo é `{ url, expires_in }`
    - expect: `url` é absoluta, aponta ao object storage e carrega query params de assinatura
    - expect: `expires_in` é inteiro positivo e curto (TTL de vida curta, na ordem de ~600s)
  2. Fazer GET na `url` devolvida com o header `Range: bytes=0-99`
    - expect: status 206
    - expect: header `content-range` presente e coerente com o intervalo pedido
    - expect: o corpo tem no máximo 100 bytes
  3. Fazer GET na `url` sem header `Range`
    - expect: status 200 — a URL serve o objeto inteiro quando não há Range

#### 2.2. rejects-stream-of-non-ready-video-for-owner

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. Semear um vídeo de A em `status = 'processing'` e fazer GET /videos/:publicId/stream autenticado como A
    - expect: status 409
    - expect: corpo carrega `errorCode: "VIDEO_NOT_READY"`
  2. Repetir com o vídeo de A em `status = 'failed'`
    - expect: status 409 com `errorCode: "VIDEO_NOT_READY"`

### 3. Download

**Setup:** mesmo bootstrap da seção 1.

#### 3.1. issues-attachment-download-url

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. Semear um vídeo `ready` de A e fazer GET /videos/:publicId/download sem autenticação
    - expect: status 200
    - expect: corpo é `{ url, expires_in }`
    - expect: `url` carrega o parâmetro `response-content-disposition` com valor começando em `attachment`
  2. Fazer GET na `url` devolvida
    - expect: status 200
    - expect: header de resposta `content-disposition` começa com `attachment` e traz um `filename`
    - expect: o `content-type` da resposta é o `content_type` persistido do vídeo

#### 3.2. rejects-download-of-non-ready-video-for-owner

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. Semear um vídeo de A em `status = 'processing'` e fazer GET /videos/:publicId/download autenticado como A
    - expect: status 409
    - expect: corpo carrega `errorCode: "VIDEO_NOT_READY"`

#### 3.3. signs-download-url-with-special-character-filename

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. Semear um vídeo `ready` de A cujo nome original tem espaço, acento e aspas (ex.: `Minha "férias" 2026.mp4`) e fazer GET /videos/:publicId/download
    - expect: status 200
    - expect: a `url` está bem formada — o `filename` no `response-content-disposition` vem sanitizado/URL-encoded
  2. Fazer GET na `url` devolvida
    - expect: status 200 — nenhum `SignatureDoesNotMatch` do storage
    - expect: header `content-disposition` presente com o filename encodado

### 4. Não-vazamento de existência

**Setup:** mesmo bootstrap da seção 1; **B** é um usuário autenticado que não é dono do vídeo de A.

#### 4.1. returns-404-for-unknown-public-id

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. Chamar as três rotas com o `public_id` bem formado `aaaaaaaaaaaa`, que não existe, sem autenticação
    - expect: GET /videos/aaaaaaaaaaaa → 404 com `errorCode: "VIDEO_NOT_FOUND"`
    - expect: GET /videos/aaaaaaaaaaaa/stream → 404 com `errorCode: "VIDEO_NOT_FOUND"`
    - expect: GET /videos/aaaaaaaaaaaa/download → 404 com `errorCode: "VIDEO_NOT_FOUND"`

#### 4.2. hides-non-ready-video-from-non-owner

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. Semear um vídeo de A em `status = 'processing'` e chamar as três rotas **sem autenticação**
    - expect: GET /videos/:publicId → 404 com `errorCode: "VIDEO_NOT_FOUND"`
    - expect: GET /videos/:publicId/stream → 404 com `errorCode: "VIDEO_NOT_FOUND"`
    - expect: GET /videos/:publicId/download → 404 com `errorCode: "VIDEO_NOT_FOUND"`
    - expect: nenhuma resposta é 409 — `VIDEO_NOT_READY` para não-dono vazaria a existência do vídeo
  2. Repetir as três chamadas autenticado como B
    - expect: 404 com `errorCode: "VIDEO_NOT_FOUND"` nas três
  3. Repetir com o vídeo de A em `status = 'draft'` e em `status = 'failed'`, anônimo e como B
    - expect: 404 com `errorCode: "VIDEO_NOT_FOUND"` em todas as combinações
    - expect: as respostas são indistinguíveis das do cenário 4.1
