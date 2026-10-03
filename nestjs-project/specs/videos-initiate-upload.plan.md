---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.4
target_file: nestjs-project/test/videos-initiate-upload.e2e-spec.ts
---

# POST /videos — Início de Upload Test Plan

## Application Overview

`POST /videos` é a porta de entrada do pipeline de upload. Um usuário autenticado declara o arquivo que pretende enviar (nome, MIME type e tamanho) e a API faz duas coisas numa tacada: pré-cadastra a linha do vídeo em `status='draft'` no canal do usuário e abre um multipart upload no object storage. A resposta devolve o `public_id` (nanoid de 12 chars — a única identidade que a API expõe) e o `upload_id` do multipart, junto com o plano de partes (`part_size_bytes`, `part_count`) que o cliente deve seguir. A partir daí os bytes vão direto do browser para o MinIO via URLs presigned — a API nunca os trafega.

O contrato tem três recusas específicas de domínio: `413 FILE_TOO_LARGE` acima de 10 GiB, `415 UNSUPPORTED_MEDIA_TYPE` para `content_type` fora de `video/*`, e `401` para requisição anônima. Erros de schema caem no `400` do `ValidationPipe`.

## Test Scenarios

### 1. Abertura do upload multipart

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()`; reproduzir a config global de `main.ts` (`ValidationPipe({ whitelist: true })` + filtro de exceções de domínio herdado de `phase-02-auth/TD-07`); registrar e autenticar um usuário com canal, guardando o access token; `beforeEach` limpa `videos` via `dataSource.query('DELETE FROM videos')`; `afterAll` chama `app.close()`.

#### 1.1. initiates-multipart-upload-and-creates-draft

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. POST /videos autenticado com `{ filename: "clip.mp4", content_type: "video/mp4", size_bytes: 52428800 }`
    - expect: status 201
    - expect: corpo contém `public_id`, `upload_id`, `part_size_bytes`, `part_count`, `expires_in`
    - expect: `public_id` tem 12 caracteres e casa `/^[0-9a-zA-Z]{12}$/`
    - expect: `upload_id` é string não-vazia
    - expect: `part_size_bytes` >= 5242880 e `part_count` >= 1
    - expect: `expires_in` é inteiro positivo
    - expect: corpo NÃO expõe `id` interno, `storage_key` nem `channel_id`
  2. Consultar a tabela `videos` pelo `public_id` retornado
    - expect: existe exatamente uma linha
    - expect: `status = 'draft'` e `processing_attempts = 0`
    - expect: `channel_id` é o canal do usuário autenticado
    - expect: `upload_id` e `storage_key` estão preenchidos
    - expect: `content_type = 'video/mp4'` e `size_bytes = 52428800`

#### 1.2. honors-requested-part-size

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. POST /videos autenticado com `size_bytes: 52428800` e `part_size_bytes: 10485760`
    - expect: status 201
    - expect: `part_size_bytes` na resposta = 10485760
    - expect: `part_count` = ceil(`size_bytes` / `part_size_bytes`) = 5

#### 1.3. issues-distinct-public-ids-across-uploads

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. POST /videos autenticado duas vezes com o mesmo corpo válido
    - expect: ambas retornam 201
    - expect: os dois `public_id` são diferentes
    - expect: os dois `upload_id` são diferentes
    - expect: existem duas linhas `draft` distintas no canal do usuário

### 2. Validação da requisição

**Setup:** mesmo bootstrap da seção 1 (usuário autenticado com canal).

#### 2.1. rejects-file-above-size-ceiling

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. POST /videos autenticado com `size_bytes: 10737418241` (1 byte acima de 10 GiB)
    - expect: status 413
    - expect: corpo carrega `errorCode: "FILE_TOO_LARGE"` no envelope de erro do projeto
    - expect: nenhuma linha nova em `videos`
  2. POST /videos autenticado com `size_bytes: 10737418240` (exatamente 10 GiB)
    - expect: status 201 — o limite é inclusivo

#### 2.2. rejects-non-video-content-type

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. POST /videos autenticado com `content_type: "application/pdf"`
    - expect: status 415
    - expect: corpo carrega `errorCode: "UNSUPPORTED_MEDIA_TYPE"`
    - expect: nenhuma linha nova em `videos`

#### 2.3. rejects-malformed-body

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. POST /videos autenticado com corpo `{}` (sem `filename`, `content_type`, `size_bytes`)
    - expect: status 400
    - expect: a mensagem de erro cita os três campos ausentes
  2. POST /videos autenticado com `size_bytes: 0`
    - expect: status 400 (mínimo é 1 byte — não é o caminho 413)
  3. POST /videos autenticado com `part_size_bytes: 1048576` (1 MiB, abaixo do mínimo S3 de 5 MiB)
    - expect: status 400
    - expect: nenhuma linha nova em `videos`

### 3. Autenticação

**Setup:** mesmo bootstrap da seção 1; nenhum header `Authorization` nesta seção.

#### 3.1. rejects-anonymous-request

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-09T23:18:42Z

**Steps:**
  1. POST /videos sem header `Authorization`, com corpo válido
    - expect: status 401
    - expect: nenhuma linha nova em `videos`
  2. POST /videos com `Authorization: Bearer <token-inválido>`
    - expect: status 401
