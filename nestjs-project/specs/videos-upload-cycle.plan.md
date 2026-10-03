---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: nestjs-project/test/videos-upload-cycle.e2e-spec.ts
---

# Ciclo de Upload (parts / complete / abort) Test Plan

## Application Overview

As três rotas que completam o protocolo de upload resumável, todas restritas ao dono do vídeo e endereçadas por `public_id`:

- `POST /videos/:publicId/upload/parts` — (re)emite URLs presigned de `UploadPart` para um lote de números de parte. É também o caminho de *resume*: o cliente pede de volta só as partes que faltaram.
- `POST /videos/:publicId/upload/complete` — finaliza o multipart no storage e, **na mesma transação**, transiciona `draft → processing` e enfileira o job `video.process` (pg-boss, `singletonKey = videoId`).
- `DELETE /videos/:publicId/upload` — aborta o multipart e descarta o rascunho.

Duas invariantes de segurança governam os testes: operar o ciclo fora do estado `draft` devolve `409 INVALID_UPLOAD_STATE`, e tocar o vídeo de outro dono devolve `404 VIDEO_NOT_FOUND` — nunca `403`, porque a existência do `public_id` não pode vazar.

## Test Scenarios

### 1. Presign de partes

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()`; reproduzir a config global de `main.ts` (`ValidationPipe({ whitelist: true })` + filtro de exceções de domínio); registrar e autenticar o usuário **A** (dono, com canal) e o usuário **B** (outro dono, com canal); helper `initiateUpload()` que faz `POST /videos` como A e devolve `{ publicId, uploadId, partSizeBytes }`; `beforeEach` limpa `videos` e a tabela de jobs do pg-boss; `afterAll` chama `app.close()`.

#### 1.1. presigns-requested-parts-for-owner-draft

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. A inicia um upload via helper e faz POST /videos/:publicId/upload/parts com `{ part_numbers: [1, 2] }`
    - expect: status 200
    - expect: `parts` tem 2 entradas, com `part_number` 1 e 2 na ordem pedida
    - expect: cada `url` é absoluta, aponta para o endpoint do object storage e carrega os query params de assinatura
    - expect: cada `url` contém `partNumber=<n>` e o `uploadId` do vídeo
    - expect: `expires_in` é inteiro positivo
  2. Repetir o mesmo POST com `{ part_numbers: [2] }` (caminho de resume)
    - expect: status 200 e uma única entrada para `part_number: 2`
    - expect: o vídeo continua em `status = 'draft'` — re-presign não altera estado

#### 1.2. rejects-presign-without-active-upload

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. A inicia um upload, completa-o (vídeo passa a `processing`) e então faz POST /videos/:publicId/upload/parts com `{ part_numbers: [1] }`
    - expect: status 409
    - expect: corpo carrega `errorCode: "INVALID_UPLOAD_STATE"`

#### 1.3. rejects-invalid-part-numbers

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. A faz POST /videos/:publicId/upload/parts com `{ part_numbers: [] }`
    - expect: status 400
  2. A faz POST com `{ part_numbers: [0] }` e depois com `{ part_numbers: [10001] }`
    - expect: status 400 em ambos (faixa válida é 1..10000)
  3. A faz POST com corpo `{}`
    - expect: status 400

### 2. Finalização do upload

**Setup:** mesmo bootstrap da seção 1; além do helper `initiateUpload()`, um helper `uploadParts()` que faz PUT das partes nas URLs presigned e coleta os `ETag` devolvidos pelo storage.

#### 2.1. completes-upload-and-enqueues-processing

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. A inicia um upload, envia as partes ao storage e faz POST /videos/:publicId/upload/complete com `{ parts: [{ part_number, etag }, ...] }`
    - expect: status 200
    - expect: corpo é `{ public_id, status: "processing" }`
    - expect: `public_id` é o mesmo do início do upload
  2. Consultar a linha em `videos`
    - expect: `status = 'processing'`
    - expect: `upload_id` foi limpo (o multipart não está mais ativo)
    - expect: `storage_key` continua preenchido
  3. Consultar a fila do pg-boss pelo job `video.process`
    - expect: existe exatamente um job pendente para o nome `video.process`
    - expect: o payload é `{ videoId: <id interno do vídeo> }`

#### 2.2. rejects-complete-of-already-completed-upload

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. A completa um upload com sucesso e repete o mesmo POST /videos/:publicId/upload/complete
    - expect: status 409
    - expect: corpo carrega `errorCode: "INVALID_UPLOAD_STATE"`
    - expect: o vídeo continua em `status = 'processing'`
    - expect: continua existindo apenas um job `video.process` — o segundo complete não duplica trabalho

#### 2.3. rejects-malformed-parts-payload

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. A faz POST /videos/:publicId/upload/complete com corpo `{}`
    - expect: status 400
  2. A faz POST com `{ parts: [{ part_number: 1 }] }` (sem `etag`)
    - expect: status 400
  3. A faz POST com `{ parts: [{ part_number: 1, etag: "" }] }`
    - expect: status 400
    - expect: o vídeo continua em `status = 'draft'`

### 3. Abort do upload

**Setup:** mesmo bootstrap da seção 1.

#### 3.1. aborts-draft-upload-and-discards-video

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. A inicia um upload e faz DELETE /videos/:publicId/upload
    - expect: status 204
    - expect: corpo vazio
  2. GET /videos/:publicId/status autenticado como A
    - expect: status 404 com `errorCode: "VIDEO_NOT_FOUND"` — o `public_id` deixou de ser resolvível
  3. GET /videos/:publicId (rota pública)
    - expect: status 404 com `errorCode: "VIDEO_NOT_FOUND"`
  4. Consultar a tabela `videos` pelo `public_id`
    - expect: o rascunho não está mais acessível pelo `public_id` (linha removida ou fora do alcance da resolução pública)

#### 3.2. rejects-abort-of-non-draft-video

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. A completa um upload (vídeo em `processing`) e faz DELETE /videos/:publicId/upload
    - expect: status 409
    - expect: corpo carrega `errorCode: "INVALID_UPLOAD_STATE"`
    - expect: o vídeo continua em `status = 'processing'`

### 4. Posse e autenticação

**Setup:** mesmo bootstrap da seção 1; o usuário **B** está autenticado e NÃO é dono do vídeo criado por A.

#### 4.1. hides-other-owners-video-across-upload-cycle

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. A inicia um upload; B faz POST /videos/:publicId/upload/parts com `{ part_numbers: [1] }`
    - expect: status 404
    - expect: corpo carrega `errorCode: "VIDEO_NOT_FOUND"` — nunca 403, para não vazar existência
  2. B faz POST /videos/:publicId/upload/complete com `parts` válidas
    - expect: status 404 com `errorCode: "VIDEO_NOT_FOUND"`
  3. B faz DELETE /videos/:publicId/upload
    - expect: status 404 com `errorCode: "VIDEO_NOT_FOUND"`
  4. Consultar a linha em `videos`
    - expect: continua em `status = 'draft'` e com o `upload_id` intacto — nenhuma ação de B teve efeito

#### 4.2. rejects-anonymous-upload-cycle-requests

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. Sem header `Authorization`, chamar as três rotas do ciclo para um `publicId` existente de A
    - expect: POST /videos/:publicId/upload/parts → 401
    - expect: POST /videos/:publicId/upload/complete → 401
    - expect: DELETE /videos/:publicId/upload → 401
    - expect: o vídeo continua em `status = 'draft'`
