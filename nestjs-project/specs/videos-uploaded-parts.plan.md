---
subproject: backend
runner: jest+supertest
scope: phase-03-videos-frontend
si: SI-03.2
target_file: nestjs-project/test/videos-uploaded-parts.e2e-spec.ts
---

# Partes já enviadas (GET /videos/:publicId/upload/parts) Test Plan

## Application Overview

`GET /videos/:publicId/upload/parts` é a rota que fecha a retomada de um upload após o browser recarregar a página. O cliente perde o estado em memória (quais partes já subiram e os `ETag`s que o storage devolveu em cada `PUT`), mas o storage sabe de tudo: a rota projeta a resposta de `ListParts` do multipart ativo em `{ parts: [{ part_number, etag, size }] }`, ordenada por `part_number`, para o cliente assinar só as partes ausentes e completar com ETags vindos do servidor.

A rota é restrita ao dono e endereçada por `public_id`, com as mesmas invariantes das irmãs do ciclo de upload: fora do estado `draft` devolve `409 INVALID_UPLOAD_STATE`; o vídeo de outro dono devolve `404 VIDEO_NOT_FOUND` — nunca `403`, porque a existência do `public_id` não pode vazar; sem bearer, `401`. É a segunda e última mudança de backend da fatia de frontend da Fase 03 e precisa estar no `openapi.json` commitado para o frontend gerar os tipos.

## Test Scenarios

### 1. Listagem das partes recebidas

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()`; reproduzir a config global de `main.ts` (`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` + `DomainExceptionFilter` + `ValidationExceptionFilter`); registrar, confirmar e autenticar o usuário **A** (dono, com canal) e o usuário **B** (outro dono, com canal); helper `initiateUpload()` que faz `POST /videos` como A (arquivo de 5 MiB, `video/mp4`) e devolve `{ public_id, upload_id }`; helper `uploadPart(publicId, partNumber)` que pede a URL presigned via `POST /videos/:publicId/upload/parts`, faz o `PUT` de 5 MiB direto no storage e devolve o `ETag`; `beforeEach` aborta multiparts abertos, limpa `videos` e `pgboss.job`; `afterAll` chama `app.close()`.

#### 1.1. lists-uploaded-parts-with-storage-etags

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-03T02:20:00Z

**Steps:**
  1. A inicia um upload, envia a parte 1 pelo helper e faz GET /videos/:publicId/upload/parts
    - expect: status 200
    - expect: `parts` tem exatamente 1 entrada
    - expect: `parts[0].part_number` é 1
    - expect: `parts[0].etag` é igual ao `ETag` que o storage devolveu no `PUT`
    - expect: `parts[0].size` é 5242880 (5 MiB)
  2. Repetir o GET
    - expect: status 200 com a mesma lista — a leitura não altera estado
    - expect: o vídeo continua em `status = 'draft'` com o `upload_id` intacto

#### 1.2. returns-empty-list-before-any-part

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-03T02:20:00Z

**Steps:**
  1. A inicia um upload e, sem enviar nenhuma parte, faz GET /videos/:publicId/upload/parts
    - expect: status 200
    - expect: corpo é `{ parts: [] }`

### 2. Estado do upload

**Setup:** mesmo bootstrap da seção 1; helper `completeUpload(publicId, parts)` que faz `POST /videos/:publicId/upload/complete` como A.

#### 2.1. rejects-listing-after-complete

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-03T02:20:00Z

**Steps:**
  1. A inicia um upload, envia a parte 1, completa o upload (vídeo passa a `processing`) e faz GET /videos/:publicId/upload/parts
    - expect: status 409
    - expect: corpo carrega `errorCode: "INVALID_UPLOAD_STATE"`
    - expect: o vídeo continua em `status = 'processing'`

### 3. Posse e autenticação

**Setup:** mesmo bootstrap da seção 1; o usuário **B** está autenticado e NÃO é dono do vídeo criado por A.

#### 3.1. hides-other-owners-upload

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-03T02:20:00Z

**Steps:**
  1. A inicia um upload e envia a parte 1; B faz GET /videos/:publicId/upload/parts
    - expect: status 404
    - expect: corpo carrega `errorCode: "VIDEO_NOT_FOUND"` — nunca 403
  2. B faz GET /videos/:publicId/upload/parts para um `publicId` inexistente
    - expect: status 404 com `errorCode: "VIDEO_NOT_FOUND"` — indistinguível do caso anterior
    - expect: o corpo das duas respostas é idêntico

#### 3.2. rejects-anonymous-listing

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-03T02:20:00Z

**Steps:**
  1. Sem header `Authorization`, GET /videos/:publicId/upload/parts para um `publicId` existente de A
    - expect: status 401
    - expect: o vídeo continua em `status = 'draft'`

### 4. Contrato publicado

**Setup:** sem app — leitura do arquivo `nestjs-project/openapi.json` commitado.

#### 4.1. openapi-contract-exposes-the-route

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-03T02:20:00Z

**Steps:**
  1. Ler `openapi.json` e localizar `paths["/videos/{publicId}/upload/parts"]`
    - expect: o path existe e tem a operação `get` além da `post`
    - expect: a operação `get` declara `security` com `access-token` e respostas `200`, `401`, `404` e `409`
    - expect: o schema da resposta `200` descreve `parts` como array de objetos com `part_number`, `etag` e `size`
