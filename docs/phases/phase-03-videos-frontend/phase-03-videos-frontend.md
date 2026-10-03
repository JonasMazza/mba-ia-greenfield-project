---
kind: phase
name: phase-03-videos-frontend
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos-frontend/context.md: "2026-08-22T15:22:06-03:00"
  docs/phases/phase-03-videos-frontend/library-refs.md: "2026-08-22T15:22:06-03:00"
  docs/decisions/technical-decisions-phase-03-videos-frontend.md: "2026-08-22T15:16:51-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-07-20T13:23:34-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-07-20T13:23:34-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-07-20T13:23:34-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-20T13:23:34-03:00"
---

# Fase 03 — Upload e Processamento de Vídeos (fatia frontend)

## Objective

Entregar o lado do browser da Fase 03 sobre o backend já construído em `phase-03-videos`: o upload resumável de arquivos de até 10GB direto do browser para o object storage (cliente multipart headless, uma parte assinada por vez, retomada após recarregar a página via `GET /videos/:publicId/upload/parts`), o acompanhamento do processamento por polling até `ready | failed`, e uma superfície mínima de reprodução via streaming e download por URL same-origin que redireciona a cada requisição — consertando no caminho os dois contratos voltados ao browser que o backend deixou quebrados (host das URLs presigned) ou ausentes (ETags das partes já enviadas).

---

## Step Implementations

### SI-03.1 — Endpoint público de assinatura para URLs voltadas ao browser

**Description:** Conserta o contrato quebrado medido em `TD-01`: toda URL presigned que o browser recebe passa a carregar um host que o browser resolve, sem tocar no presign que o worker usa de dentro do container.

**Technical actions:**

1. Adicionar `STORAGE_PUBLIC_ENDPOINT` a `src/config/storage.config.ts` (`publicEndpoint`, default `http://localhost:9000`), ao schema Joi de `src/config/env.validation.ts` (`uri`), e a `.env.example`/`.env` com o comentário de que é a porta publicada do MinIO vista do host (per `phase-03-videos-frontend/TD-01`).
2. Em `videos/storage/object-storage.service.ts`, instanciar um segundo `S3Client` (`publicClient`) com as mesmas credenciais/região/`forcePathStyle` e `endpoint: publicEndpoint`, usado **só** por `getSignedUrl`; introduzir `type PresignAudience = 'browser' | 'server'` e tornar a audiência parâmetro **obrigatório** de `presignUploadPart(key, uploadId, partNumber, audience)` e de `presignGetObject(bucket, key, { audience, ... })` — o cliente interno continua servindo create/complete/abort/listParts/putObject (per `phase-03-videos-frontend/TD-01`; `## Technical Specifications → API Contracts → Audiência das URLs presigned`).
3. Atualizar os cinco call sites voltados ao browser em `videos/videos.service.ts` (`presignParts`, `getStatus` thumbnail, `getPublicVideo` thumbnail, `getStreamUrl`, `getDownloadUrl`) para `'browser'`, e o presign do source em `worker/video-processor.service.ts` para `'server'` (per `phase-03-videos-frontend/TD-01`).
4. Pinar `STORAGE_PUBLIC_ENDPOINT` ao endpoint interno nos processos de teste que rodam dentro do Docker (setup do Jest unit/integration e `test/jest-e2e.json`), porque `localhost:9000` de dentro do container é o próprio container; a validação do host real fica com o smoke manual de `TD-08`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ObjectStorageService` | Integration (MinIO real): URL de audiência `browser` carrega o host de `publicEndpoint` e os query params SigV4; URL de audiência `server` continua aceita pelo MinIO (PUT de parte e GET com Range); dois clients assinam o mesmo objeto para hosts diferentes | `videos/storage/object-storage.service.integration-spec.ts` (estender) |
| `envValidationSchema` | Integration: `STORAGE_PUBLIC_ENDPOINT` aceita URI e assume o default | `config/env.validation.integration-spec.ts` (estender) |

**Dependencies:** none

**Acceptance criteria:**

- Uma URL assinada para a audiência `browser` tem o host de `STORAGE_PUBLIC_ENDPOINT` e carrega `X-Amz-Signature`; uma URL assinada para a audiência `server` tem o host de `STORAGE_ENDPOINT`.
- Com `STORAGE_PUBLIC_ENDPOINT` e `STORAGE_ENDPOINT` apontando para o mesmo host, o ciclo multipart completo (presign de parte → PUT → complete) e o GET com `Range` continuam funcionando — nenhuma regressão na suíte do backend.
- O worker continua lendo o source via URL do endpoint interno: o spec de integração do `video-processor` segue verde sem alteração de ambiente.
- A aplicação sobe sem `STORAGE_PUBLIC_ENDPOINT` definido (default aplicado) e falha a validação de env com um valor que não é URI.

---

### SI-03.2 — Endpoint de partes já enviadas (GET /videos/:publicId/upload/parts)

**Route:** GET /videos/:publicId/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-uploaded-parts.plan.md`
**Description:** Expõe ao dono as partes que o storage já recebeu (com ETags), fechando a retomada do upload após recarregar a página sem o browser guardar estado — a segunda e última mudança de backend desta fatia.

**Technical actions:**

1. Estender `ObjectStorageService.listUploadedParts(key, uploadId)` para devolver `{ part_number, etag, size }[]` (projeção de `ListParts` `PartNumber`/`ETag`/`Size`, ordenada por `part_number`) em vez de só os números (per `phase-03-videos-frontend/TD-04`).
2. Implementar `VideosService.listUploadedParts(userId, publicId)` — resolve o vídeo do dono (404-não-403, como os irmãos), exige multipart ativo (`requireActiveUpload` → `409 INVALID_UPLOAD_STATE`) e devolve `{ parts }` conforme `## Technical Specifications → API Contracts → GET /videos/:publicId/upload/parts` (per `phase-03-videos-frontend/TD-04`).
3. Adicionar `@Get(':publicId/upload/parts')` ao `VideosController` com os decorators Swagger no mesmo padrão dos irmãos (`@ApiBearerAuth`, `@ApiParam`, respostas 200/401/404/409 com `ApiErrorEnvelope`) (per `## Technical Specifications → Authorization Matrix`; per `openapi-docs-nestjs/TD-01`).
4. Regenerar `nestjs-project/openapi.json` com `npm run openapi:export` para o contrato ganhar o novo path (per `openapi-docs-nestjs/TD-02`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ObjectStorageService.listUploadedParts` | Integration (MinIO real): após PUT de uma parte, devolve `[{ part_number: 1, etag, size }]`; sem partes, `[]` | `videos/storage/object-storage.service.integration-spec.ts` (estender) |
| `VideosService.listUploadedParts` | Integration: dono em `draft` com parte enviada → `{ parts }` com o ETag do storage; vídeo de outro dono → `VideoNotFoundException`; vídeo fora de `draft` → `InvalidUploadStateException` | `videos/videos.service.integration-spec.ts` (estender) |

Cenários E2E (`200` com e sem partes, `401`, `404` para não-dono, `409` após complete, presença do path em `openapi.json`) são autorados por `/plan-test-specs`.

**Dependencies:** SI-03.1 (o presign de parte usado para enviar a parte de teste já carrega a audiência)

**Acceptance criteria:**

- `GET /videos/:publicId/upload/parts` do dono de um rascunho com uma parte enviada retorna `200` com `{ parts: [{ part_number: 1, etag, size }] }`, e o `etag` é o mesmo que o storage devolveu no `PUT`.
- O mesmo endpoint para um rascunho sem partes enviadas retorna `200` com `{ parts: [] }`.
- Após `POST /videos/:publicId/upload/complete`, o endpoint retorna `409` com `errorCode: "INVALID_UPLOAD_STATE"`.
- Para um vídeo de outro dono retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`; sem `Authorization` retorna `401`.
- `nestjs-project/openapi.json` contém `GET /videos/{publicId}/upload/parts`.

---

### SI-03.3 — Sincronizar o contrato OpenAPI no frontend e expor os aliases de vídeos

**Description:** Pré-requisito mecânico de toda a fatia (DG-1): propaga o contrato regenerado para `types.gen.ts`, destrava o commit de `openapi.json` (IC-6) e publica os aliases que Route Handlers, componentes e mocks consomem.

**Technical actions:**

1. Remover `openapi.json` de `next-frontend/.gitignore` e rodar `bash scripts/sync-openapi.sh` no host — `next-frontend/openapi.json` passa a ser a cópia commitada do contrato (per `next-frontend-openapi-typing/TD-02`; per `.claude/rules/next-frontend-bff-api.md`).
2. Rodar `docker compose exec next-frontend npm run openapi:types` — `lib/api/types.gen.ts` ganha os nove paths `/videos*`, incluindo `GET /videos/{publicId}/upload/parts` (per `next-frontend-openapi-typing/TD-01`).
3. Acrescentar a seção `// ─── Videos ───` em `lib/api/contracts.ts` com aliases pass-through derivados de `paths`: `InitiateUploadDto`, `InitiateUploadResponse`, `PresignPartsDto`, `PresignPartsResponse`, `UploadedPartsResponse`, `CompleteUploadDto`, `CompleteUploadResponse`, `VideoStatusResponse`, `PublicVideo`, `PresignedUrlResponse` — `contracts.ts` segue o único importador de `paths` fora de `mocks/` (per `next-frontend-openapi-typing/TD-04`; shapes per `## Technical Specifications → API Contracts`).
4. Commitar `next-frontend/openapi.json` e `lib/api/types.gen.ts` na mesma mudança (per `.claude/rules/next-frontend-bff-api.md`).

**Tests:** _(empty — type-only aliases; compile-gated por `npx tsc --noEmit`)_

**Dependencies:** SI-03.2 (o contrato só está completo com o endpoint novo)

**Acceptance criteria:**

- `next-frontend/openapi.json` é rastreado pelo git e idêntico a `nestjs-project/openapi.json`.
- `lib/api/types.gen.ts` contém os nove paths `/videos*` do contrato, inclusive `"/videos/{publicId}/upload/parts"` com `get` e `post`.
- `lib/api/contracts.ts` exporta os dez aliases de vídeos e `docker compose exec next-frontend npx tsc --noEmit` sai com código 0.

---

### SI-03.4 — Guarda de CI de frescor do contrato OpenAPI

**Description:** Materializa o guard que `openapi-typing/TD-03` e o `next-frontend/CLAUDE.md` já afirmavam existir (IC-7): um par spec/types desatualizado não pode mais ser mesclado.

**Technical actions:**

1. Criar `.github/workflows/openapi-freshness.yml` — job em `pull_request` que faz checkout, instala Node 22, roda `bash scripts/sync-openapi.sh`, `npm ci` + `npm run openapi:types` em `next-frontend/`, e falha em `git diff --exit-code -- next-frontend/openapi.json next-frontend/lib/api/types.gen.ts` (per `next-frontend-openapi-typing/TD-03`).

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.3

**Acceptance criteria:**

- `.github/workflows/openapi-freshness.yml` existe, dispara em `pull_request` e executa sync → geração → `git diff --exit-code` sobre os dois arquivos.
- Rodar localmente a mesma sequência (sync + `openapi:types`) sobre a árvore commitada produz diff vazio.

---

### SI-03.5 — Handlers MSW do domínio videos (plano upstream)

**Description:** Fake determinístico do upstream NestJS para os nove endpoints de vídeos, consumido pelos testes de integração dos Route Handlers (Vitest) e pelo E2E server-side (`instrumentation.ts`).

**Technical actions:**

1. Criar `mocks/storage-origin.ts` exportando `STORAGE_ORIGIN = "http://storage.local:9000"` e `mocks/factories/videos.ts` com `buildInitiateUploadResponse`, `buildPresignedPart`, `buildUploadedPart`, `buildVideoStatus`, `buildPublicVideo`, `buildPresignedUrl` tipados pelos aliases de `@/lib/api/contracts`; toda URL presigned dos fixtures aponta para `STORAGE_ORIGIN` (per `next-frontend-msw-foundation/TD-03`; per `## Technical Specifications → Frontend Runtime → TD-08`).
2. Criar `mocks/handlers/videos.ts` com um handler por `(method, path)` dos nove endpoints `${env.API_URL}/videos…`, corpos tipados via `paths` (per `next-frontend-openapi-typing/TD-05`; per `next-frontend-msw-foundation/TD-01`).
3. Embutir a tabela de reserved triggers compartilhada com o E2E: `filename: "toolarge.mp4"` → 413 `FILE_TOO_LARGE`; `content_type` fora de `video/*` → 415; `publicId: "notfound0000"` → 404 `VIDEO_NOT_FOUND`; `publicId: "notready0000"` → 409 `VIDEO_NOT_READY` em stream/download e `status: "processing"` no status; `publicId: "failedvid000"` → `status: "failed"` com `failure_reason`; `publicId: "nodraft00000"` → 409 `INVALID_UPLOAD_STATE` no ciclo de upload; qualquer outro id → sucesso/`ready` (per `next-frontend/CLAUDE.md` § E2E architecture).
4. Registrar o módulo no barrel `mocks/handlers/index.ts` (per `next-frontend-msw-foundation/TD-01`).

**Tests:** _(empty — MSW handler set é test-infra; exercitado pelos testes de integração de SI-03.7..SI-03.10 e pelo E2E)_

**Dependencies:** SI-03.3

**Acceptance criteria:**

- `mocks/handlers/videos.ts` exporta handlers para os nove endpoints upstream de vídeos e está registrado no barrel.
- Os reserved triggers produzem exatamente os status/códigos da tabela; qualquer outro id produz sucesso.
- Toda `url`/`thumbnail_url` devolvida pelos fixtures tem origin `http://storage.local:9000`, e os corpos derivam de `paths` (sem DTO duplicado à mão).

---

### SI-03.6 — Harness do plano de bytes: handlers MSW do storage e stub Playwright (Setup)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-videos-frontend/TD-08 — Test Strategy for the Direct-to-Storage Byte Path`

**Technical actions:**

1. Criar `mocks/handlers/storage.ts` implementando o **Setup snippet** byte-verbatim de `### Frontend Runtime → TD-08 → Setup`: `http.put(`${STORAGE_ORIGIN}/*`)` devolvendo `200` com `ETag: "\"etag-<partNumber>\""` (partNumber lido da query da URL presigned) e o reserved trigger `uploadId === "expired"` → `403` (per `phase-03-videos-frontend/TD-08`).
2. Registrar `storage` no barrel `mocks/handlers/index.ts` (linha da tabela Migração de `TD-08`) — o `onUnhandledRequest: "error"` de `mocks/setup.ts` passa a ser a prova de que nenhum `PUT` do uploader escapa para um origin real (per `next-frontend-msw-foundation/TD-04`).
3. Criar `tests/storage-stub.ts` — helper Playwright `stubStorageOrigin(page)` que faz `page.route(`${STORAGE_ORIGIN}/**`)` respondendo `200` + `ETag` e devolve um contador de `PUT`s interceptados; intercepta **apenas** o origin do storage, nunca `/api/**` (per `phase-03-videos-frontend/TD-08`; per `next-frontend/CLAUDE.md` § E2E hard rules).

**Dependencies:** SI-03.5 (`STORAGE_ORIGIN` e o barrel)

**Tests:** _(empty — Setup SI; smoke-gated by AC; behavior tests live in Migration + Verification SIs)_

**Acceptance criteria:**

- Um `PUT` para `http://storage.local:9000/<qualquer-chave>?partNumber=N&uploadId=X` dentro do Vitest responde `200` com header `ETag` igual a `"etag-N"`; com `uploadId=expired` responde `403`.
- Um `fetch` para um origin que não é `env.API_URL` nem `STORAGE_ORIGIN` continua falhando com `request unhandled`.
- `stubStorageOrigin(page)` existe, registra a rota só para `http://storage.local:9000/**` e expõe o número de `PUT`s atendidos.

---

### SI-03.7 — BFF: início do upload e assinatura/listagem de partes

**Route:** POST /api/videos · POST /api/videos/:publicId/upload/parts · GET /api/videos/:publicId/upload/parts
**API Contract:** see `## Technical Specifications` → `### API Contracts` → BFF tier → `#### POST /api/videos`, `#### POST /api/videos/{publicId}/upload/parts`, `#### GET /api/videos/{publicId}/upload/parts`

**Description:** Os Route Handlers do plano de controle que o cliente de upload chama primeiro — criar o rascunho/abrir o multipart, assinar uma parte por vez e listar as partes já recebidas — mais o helper que todos os handlers de dono compartilham para falar com o upstream autenticado.

**Technical actions:**

1. Criar `lib/api/authed.ts` — `authedUpstream(call)`: lê `getSession()`; sem `isLoggedIn` devolve o envelope `401 UNAUTHORIZED` **sem** chamar o upstream; com sessão executa a chamada `openapi-fetch` injetando `Authorization: Bearer <accessToken>` e passando por `withRefresh` (refresh single-flight num 401 upstream, reexecutando a chamada com o token novo); expõe também `optionalAuthedUpstream(call)` que injeta o bearer só quando há sessão (per `phase-02-auth-frontend/TD-01`, `TD-02`, `TD-03`; per `next-frontend-openapi-typing/TD-01`).
2. Criar `app/api/videos/route.ts` — `POST` que encaminha `InitiateUploadDto` para `POST /videos` e repassa `201` `{ public_id, upload_id, part_size_bytes, part_count, expires_in }` e os erros `400/413/415` verbatim (per `### API Contracts` → BFF tier `#### POST /api/videos`; per `phase-02-auth-frontend/TD-05`).
3. Criar `app/api/videos/[publicId]/upload/parts/route.ts` — `POST` que encaminha `PresignPartsDto` para `POST /videos/{publicId}/upload/parts` (200 pass-through, erros `400/404/409`) e `GET` que encaminha para `GET /videos/{publicId}/upload/parts` (200 `{ parts }` pass-through, erros `404/409`) (per `### API Contracts` → BFF tier; per `phase-03-videos-frontend/TD-03`, `TD-04`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `lib/api/authed.ts` | Integration (MSW) per testing-guide-next-frontend § "Route handler/helper" — sem sessão: 401 e nenhuma chamada upstream; com sessão: bearer presente; 401 upstream dispara um refresh e reexecuta | `lib/api/__tests__/authed.integration.test.ts` |
| `app/api/videos/route.ts` | Integration (MSW) per testing-guide-next-frontend § "Route handler" — 201 pass-through; 413/415 pass-through via reserved triggers; 401 sem sessão | `app/api/videos/__tests__/route.integration.test.ts` |
| `app/api/videos/[publicId]/upload/parts/route.ts` | Integration (MSW) — POST 200 `{ parts, expires_in }` com `url` no origin do storage; GET 200 `{ parts }`; 404/409 pass-through | `app/api/videos/[publicId]/upload/parts/__tests__/route.integration.test.ts` |

**Dependencies:** SI-03.3 (aliases), SI-03.5 (handlers MSW)

**Acceptance criteria:**

- `POST /api/videos` com sessão e corpo válido retorna `201` com `{ public_id, upload_id, part_size_bytes, part_count, expires_in }`; sem sessão retorna `401` com `errorCode: "UNAUTHORIZED"` e o upstream não é chamado.
- `POST /api/videos` com `filename: "toolarge.mp4"` retorna `413` e com `content_type: "image/png"` retorna `415`, ambos com o envelope upstream repassado.
- `POST /api/videos/:publicId/upload/parts` com `{ part_numbers: [n] }` retorna `200` com uma entrada `{ part_number: n, url }` cujo origin é o do storage, e `expires_in`.
- `GET /api/videos/:publicId/upload/parts` retorna `200` com `{ parts: [{ part_number, etag, size }] }`; para `notfound0000` retorna `404 VIDEO_NOT_FOUND` e para `nodraft00000` retorna `409 INVALID_UPLOAD_STATE`.
- Uma chamada de dono cujo upstream responde `401` dispara exatamente um `POST /auth/refresh` e a chamada original é reexecutada com o token novo.

---

### SI-03.8 — BFF: finalização e abort do upload

**Route:** POST /api/videos/:publicId/upload/complete · DELETE /api/videos/:publicId/upload
**API Contract:** see `## Technical Specifications` → `### API Contracts` → BFF tier → `#### POST /api/videos/{publicId}/upload/complete`, `#### DELETE /api/videos/{publicId}/upload`

**Description:** Fecha o plano de controle do upload: o `complete` que leva o vídeo a `processing` e o `abort` que descarta o rascunho — os dois últimos hooks do uploader.

**Technical actions:**

1. Criar `app/api/videos/[publicId]/upload/complete/route.ts` — `POST` via `authedUpstream` que encaminha `CompleteUploadDto` para `POST /videos/{publicId}/upload/complete` e repassa `200` `{ public_id, status }` e os erros `400/404/409` verbatim (per `### API Contracts` → BFF tier; per `phase-02-auth-frontend/TD-05`).
2. Criar `app/api/videos/[publicId]/upload/route.ts` — `DELETE` via `authedUpstream` que encaminha para `DELETE /videos/{publicId}/upload` e responde `204` sem corpo; erros `404/409` pass-through (per `### API Contracts` → BFF tier).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `app/api/videos/[publicId]/upload/complete/route.ts` | Integration (MSW) — 200 `{ public_id, status: "processing" }` pass-through; 409 para `nodraft00000`; 401 sem sessão | `app/api/videos/[publicId]/upload/complete/__tests__/route.integration.test.ts` |
| `app/api/videos/[publicId]/upload/route.ts` | Integration (MSW) — 204 sem corpo; 404 para `notfound0000`; 401 sem sessão | `app/api/videos/[publicId]/upload/__tests__/route.integration.test.ts` |

**Dependencies:** SI-03.7 (`authedUpstream`)

**Acceptance criteria:**

- `POST /api/videos/:publicId/upload/complete` com `{ parts: [{ part_number, etag }] }` retorna `200` com `{ public_id, status: "processing" }`.
- `DELETE /api/videos/:publicId/upload` retorna `204` com corpo vazio.
- Ambas as rotas repassam `404 VIDEO_NOT_FOUND` e `409 INVALID_UPLOAD_STATE` do upstream e respondem `401 UNAUTHORIZED` sem sessão.

---

### SI-03.9 — BFF: status de processamento (polling)

**Route:** GET /api/videos/:publicId/status
**API Contract:** see `## Technical Specifications` → `### API Contracts` → BFF tier → `#### GET /api/videos/{publicId}/status`

**Description:** A rota same-origin que o hook de polling consulta até o vídeo chegar a `ready` ou `failed`.

**Technical actions:**

1. Criar `app/api/videos/[publicId]/status/route.ts` — `GET` via `authedUpstream` que encaminha para `GET /videos/{publicId}/status` e repassa `200` com a projeção por estado (`duration_seconds`/`width`/`height`/`thumbnail_url` só quando `ready`; `failure_reason` só quando `failed`) e `404` verbatim; resposta com `Cache-Control: no-store` para o polling nunca ler um status velho (per `### API Contracts` → BFF tier; per `phase-03-videos/TD-09`; per `phase-02-auth-frontend/TD-05`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `app/api/videos/[publicId]/status/route.ts` | Integration (MSW) — `ready` com metadados + `thumbnail_url` no origin do storage; `notready0000` → `processing` sem metadados; `failedvid000` → `failed` com `failure_reason`; 404; 401 sem sessão; header `no-store` | `app/api/videos/[publicId]/status/__tests__/route.integration.test.ts` |

**Dependencies:** SI-03.7 (`authedUpstream`)

**Acceptance criteria:**

- `GET /api/videos/:publicId/status` de um vídeo `ready` retorna `200` com `status: "ready"`, `duration_seconds`, `width`, `height` e `thumbnail_url`, e `Cache-Control: no-store`.
- Para `notready0000` retorna `status: "processing"` **sem** as chaves de metadados; para `failedvid000` retorna `status: "failed"` com `failure_reason`.
- Para `notfound0000` retorna `404 VIDEO_NOT_FOUND`; sem sessão retorna `401 UNAUTHORIZED`.

---

### SI-03.10 — BFF: metadados públicos e redirect de streaming/download

**Route:** GET /api/videos/:publicId · GET /api/videos/:publicId/stream · GET /api/videos/:publicId/download
**API Contract:** see `## Technical Specifications` → `### API Contracts` → BFF tier → `#### GET /api/videos/{publicId}`, `#### GET /api/videos/{publicId}/stream`, `#### GET /api/videos/{publicId}/download`

**Description:** A URL estável same-origin de `TD-06`: o `<video>` e o link de download apontam para o BFF, que autoriza no upstream e responde `307` para uma URL presigned recém-assinada — a cada requisição, sem bytes passando pelo Node.

**Technical actions:**

1. Criar `app/api/videos/[publicId]/route.ts` — `GET` via `optionalAuthedUpstream` que encaminha para `GET /videos/{publicId}` (bearer só quando há sessão) e repassa `200` metadados e `404` verbatim (per `### API Contracts` → BFF tier; per `phase-03-videos/TD-06`).
2. Criar `lib/videos/redirect-to-storage.ts` — `redirectToPresigned(result)`: dado `{ url }` do upstream, devolve `NextResponse.redirect(url, 307)` com `Cache-Control: no-store`; dado um erro, devolve o envelope JSON com o status upstream (per `phase-03-videos-frontend/TD-06`).
3. Criar `app/api/videos/[publicId]/stream/route.ts` — `GET` via `optionalAuthedUpstream` para `GET /videos/{publicId}/stream` → `redirectToPresigned` (per `### API Contracts` → BFF tier `#### GET /api/videos/{publicId}/stream`; per `phase-03-videos-frontend/TD-06`, `TD-07`).
4. Criar `app/api/videos/[publicId]/download/route.ts` — `GET` idem para `GET /videos/{publicId}/download` (per `### API Contracts` → BFF tier `#### GET /api/videos/{publicId}/download`; per `phase-03-videos-frontend/TD-06`, `TD-07`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `app/api/videos/[publicId]/route.ts` | Integration (MSW) — 200 pass-through sem sessão (anônimo); bearer presente quando há sessão; 404 para `notfound0000` | `app/api/videos/[publicId]/__tests__/route.integration.test.ts` |
| `app/api/videos/[publicId]/stream/route.ts` | Integration (MSW) — 307 com `Location` no origin do storage e `Cache-Control: no-store`; 404 e 409 como envelope JSON; duas chamadas seguidas produzem dois redirects | `app/api/videos/[publicId]/stream/__tests__/route.integration.test.ts` |
| `app/api/videos/[publicId]/download/route.ts` | Integration (MSW) — 307 com `Location` cuja query carrega `response-content-disposition=attachment`; 404/409 envelope | `app/api/videos/[publicId]/download/__tests__/route.integration.test.ts` |

**Dependencies:** SI-03.7 (`optionalAuthedUpstream`)

**Acceptance criteria:**

- `GET /api/videos/:publicId` sem sessão retorna `200` com os metadados públicos de um vídeo `ready`; para `notfound0000` retorna `404 VIDEO_NOT_FOUND`.
- `GET /api/videos/:publicId/stream` retorna `307` sem corpo, com `Location` apontando para o origin do storage e `Cache-Control: no-store`; a segunda chamada devolve um novo `Location` assinado.
- `GET /api/videos/:publicId/download` retorna `307` cuja `Location` carrega `response-content-disposition` com `attachment`.
- Para `notready0000`, stream e download retornam `409 VIDEO_NOT_READY` em JSON (dono) e nunca um redirect; para `notfound0000`, `404 VIDEO_NOT_FOUND`.

---

### SI-03.11 — Cliente de upload multipart headless com Uppy (Setup)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-videos-frontend/TD-02 — Multipart Upload Client Implementation`

**Technical actions:**

1. Instalar `@uppy/core@^5.2.0` e `@uppy/aws-s3@^5.1.0` dentro do container e registrar os pins em `next-frontend/package.json` (per `**Libraries:**` de `phase-03-videos-frontend/TD-02`; `library-refs.md` → `@uppy/core`, `@uppy/aws-s3`).
2. Criar `lib/videos/uploader.ts` implementando o **Setup snippet** byte-verbatim de `### Frontend Runtime → TD-02 → Setup`: `createVideoUploader({ resume? })` instancia `Uppy` + `AwsS3` em modo multipart com `getChunkSize` igual ao `part_size_bytes` devolvido por `POST /api/videos`, e os cinco hooks mapeados para as rotas BFF (`key` = `public_id`, `uploadId` = `upload_id`); expõe `uploader.addFile(file)`, `upload()`, `cancel()` e eventos `progress`/`complete`/`error` (per `phase-03-videos-frontend/TD-02`, `TD-03`, `TD-04`; per `## Technical Specifications → API Contracts → BFF tier`).
3. Implementar a retomada: `createVideoUploader({ resume: { publicId, uploadId, sizeBytes } })` confere `file.size === sizeBytes` ao re-selecionar, injeta `key`/`uploadId` no arquivo e deixa o `listParts` do `@uppy/aws-s3` descobrir as partes presentes antes de assinar as ausentes; a identidade além do tamanho não é verificável (o backend não persiste `filename`/`lastModified`) e fica documentada como limitação (per `phase-03-videos-frontend/TD-04`).

**Dependencies:** SI-03.7, SI-03.8 (as cinco rotas BFF que os hooks chamam)

**Tests:** _(empty — Setup SI; smoke-gated by AC; behavior tests live in Migration + Verification SIs)_

**Acceptance criteria:**

- `@uppy/core` e `@uppy/aws-s3` constam em `next-frontend/package.json` com os pins acima e `docker compose exec next-frontend npx tsc --noEmit` sai com código 0.
- `lib/videos/uploader.ts` exporta `createVideoUploader` cujos hooks apontam exclusivamente para rotas `/api/videos/**` same-origin — nenhuma referência a `env.API_URL` nem a um host de storage no código do cliente.
- A aplicação sobe (`npm run build` ou dev server) sem erro de runtime relacionado ao Uppy.

---

### SI-03.12 — Cliente de upload multipart headless com Uppy (Verification)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-videos-frontend/TD-02 — Multipart Upload Client Implementation` → Verificação

**Technical actions:**

1. Autorar `lib/videos/__tests__/uploader.integration.test.ts` (`jsdom`, `msw/node` nos dois planos): upload de um `File` sintético de 3 partes (`part_size_bytes` do fixture) — assere 1 `POST /api/videos`, 3 `POST …/upload/parts` com **um** `part_number` cada (`TD-03`), 3 `PUT` no `STORAGE_ORIGIN` e 1 `POST …/upload/complete` com `parts` `[{ part_number, etag }]` em ordem e com os ETags que o storage fake devolveu.
2. Acrescentar ao mesmo arquivo os cenários de `cancel()` (dispara `DELETE …/upload` e nenhum `complete`) e de retomada (`resume` com `listParts` devolvendo a parte 1 → só as partes 2 e 3 passam por `signPart` e o `complete` leva as 3; tamanho divergente → erro antes de qualquer chamada).

**Dependencies:** SI-03.11, SI-03.6 (storage fake)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `lib/videos/uploader.ts` (verification surface) | Integration per testing-guide-next-frontend § "`lib/` boundary module" — assertions enumeradas na Verificação de `TD-02`; este SI é a superfície de teste | `lib/videos/__tests__/uploader.integration.test.ts` |

**Acceptance criteria:**

- Um upload de 3 partes resulta em exatamente 3 chamadas de assinatura (uma parte por chamada), 3 `PUT`s no origin do storage e um `complete` cujas `parts` reproduzem os ETags devolvidos pelo storage na ordem `1, 2, 3`.
- `cancel()` durante o upload dispara `DELETE /api/videos/:publicId/upload` e nenhum `complete`.
- Na retomada, apenas as partes ausentes em `listParts` são assinadas e enviadas, e um arquivo de tamanho diferente do declarado é rejeitado antes de qualquer requisição.

---

### SI-03.13 — Hook de polling do status de processamento (Setup)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-videos-frontend/TD-05 — Processing-Status Tracking on the Client`

**Technical actions:**

1. Criar `hooks/use-video-status.ts` (`"use client"`) implementando o **Setup snippet** byte-verbatim de `### Frontend Runtime → TD-05 → Setup`: `useVideoStatus(publicId, { intervalMs: 2000, maxIntervalMs: 10000 })` com `setTimeout` recursivo, parada em `ready`/`failed`, backoff ×1.5 até o teto, `AbortController` cancelado no unmount e pausa/retomada por `visibilitychange`; consome `GET /api/videos/{publicId}/status` tipado por `VideoStatusResponse` de `@/lib/api/contracts` (per `phase-03-videos-frontend/TD-05`; per `phase-03-videos/TD-09`).

**Dependencies:** SI-03.9 (a rota BFF de status)

**Tests:** _(empty — Setup SI; smoke-gated by AC; behavior tests live in Migration + Verification SIs)_

**Acceptance criteria:**

- `hooks/use-video-status.ts` exporta `useVideoStatus` com a assinatura e os defaults do Setup snippet e importa tipos apenas de `@/lib/api/contracts`.
- `docker compose exec next-frontend npx tsc --noEmit` sai com código 0 com o hook no projeto.

---

### SI-03.14 — Hook de polling do status de processamento (Verification)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-videos-frontend/TD-05 — Processing-Status Tracking on the Client` → Verificação

**Technical actions:**

1. Autorar `hooks/__tests__/use-video-status.test.tsx` (`jsdom`, `vi.useFakeTimers()`, `renderHook`, MSW com `server.use` para sequenciar respostas): `processing → processing → ready` para após `ready` e expõe `duration_seconds`/`thumbnail_url`; `failed` para e expõe `failure_reason`; o intervalo entre chamadas cresce ×1.5 até `maxIntervalMs`; unmount aborta o fetch em voo e não agenda outro; `visibilityState = "hidden"` pausa e `"visible"` retoma.

**Dependencies:** SI-03.13

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `hooks/use-video-status.ts` (verification surface) | Unit per testing-guide-next-frontend § "Custom hook" (`renderHook`, `jsdom`) — assertions enumeradas na Verificação de `TD-05`; este SI é a superfície de teste | `hooks/__tests__/use-video-status.test.tsx` |

**Acceptance criteria:**

- Após uma sequência `processing, processing, ready`, o hook faz exatamente 3 requisições e termina em `status: "ready"` com os metadados; nenhuma requisição ocorre depois.
- Com resposta `failed`, o hook termina em `status: "failed"` expondo `failure_reason` e não requisita de novo.
- Desmontar o consumidor entre duas tentativas não gera requisição nova; esconder a aba pausa o polling e exibi-la retoma.

---

### SI-03.15 — Tela de verificação de upload (`/videos/upload`)

**Description:** A superfície descartável que prova as capacidades de upload, pré-cadastro como rascunho e processamento automático de ponta a ponta: seleção do arquivo, progresso por partes, cancelamento, retomada e acompanhamento até `ready`/`failed`.

**Technical actions:**

1. Criar `app/videos/upload/page.tsx` — RSC que lê `getSession()` e redireciona para `/login` sem sessão (per `## Technical Specifications → Authorization Matrix`), lê `?resume`/`?size` dos `searchParams` e compõe `<UploadPanel>` (per `phase-03-videos-frontend/TD-02`; rotas pinadas no decisions doc `AMB-1`).
2. Criar `components/videos/upload-panel.tsx` (`"use client"`) — `<input type="file" accept="video/*">`, botões de iniciar/cancelar (`Button` do DS), barra de progresso (`progress` do Uppy) e contagem de partes; ao criar o rascunho grava `?resume=<public_id>&size=<size_bytes>` via `history.replaceState`; em modo retomada pede a re-seleção do arquivo e repassa `resume` ao `createVideoUploader`; em `complete` troca para `<ProcessingStatus>` (per `### Frontend Runtime → TD-02`; per `phase-03-videos-frontend/TD-04`).
3. Criar `components/videos/processing-status.tsx` (`"use client"`) — usa `useVideoStatus`; renderiza `processing` (spinner textual), `ready` (duração, dimensões, thumbnail via `next/image` com `remotePatterns` para o host do storage em `next.config.ts`, e link para `/videos/[publicId]/preview`) e `failed` (`failure_reason`) (per `### Frontend Runtime → TD-05`; per `phase-03-videos-frontend/TD-07`).
4. Mapear erros do BFF para texto inline: `413`/`415` antes do upload, `401` → link para `/login`, falha de parte após os retries → mensagem com botão de retomar (per `## Technical Specifications → Error Catalog`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `components/videos/upload-panel.tsx` | Unit per testing-guide-next-frontend § "Client Components" (`jsdom`, MSW nos dois planos) — seleção habilita o botão; upload de 1 parte chega a "processando" e grava `?resume`; cancelar chama abort; 413/415 inline | `components/videos/__tests__/upload-panel.test.tsx` |
| `components/videos/processing-status.tsx` | Unit per testing-guide-next-frontend § "Client Components" — `processing` → `ready` mostra metadados e link de preview; `failed` mostra `failure_reason` | `components/videos/__tests__/processing-status.test.tsx` |
| Página `/videos/upload` | E2E (Playwright, host; upstream fakeado por `instrumentation.ts`; storage stubado por `stubStorageOrigin`) — anônimo redireciona para `/login`; logado envia um arquivo de 1 parte, o stub conta 1 `PUT`, a tela chega a `ready` com link de preview | `tests/videos-upload.e2e-spec.ts` |

**Dependencies:** SI-03.11 (uploader), SI-03.13 (hook), SI-03.6 (stub Playwright), SI-03.9 (status BFF)

**Acceptance criteria:**

- `GET /videos/upload` sem sessão responde com redirect para `/login`; com sessão renderiza o seletor de arquivo e o botão de iniciar desabilitado até haver arquivo.
- Iniciar um upload de 1 parte faz a URL ganhar `?resume=<public_id>&size=<bytes>`, mostra progresso até 100% e a tela entra em "processando" sem recarregar.
- Com o status fake respondendo `ready`, a tela exibe duração, dimensões e thumbnail e um link para `/videos/<public_id>/preview`; com `failed`, exibe o `failure_reason`.
- Cancelar durante o upload dispara o abort e volta a tela ao estado inicial; `toolarge.mp4` exibe a mensagem de `413` sem nenhum `PUT` no storage.

---

### SI-03.16 — Tela de preview de reprodução e download (`/videos/[publicId]/preview`)

**Description:** A superfície mínima que prova o streaming (reprodução parcial com seek) e o download pelo contrato de redirect de `TD-06`, com `<video>` nativo e `<a download>` — a Fase 05 a substitui pela watch page real.

**Technical actions:**

1. Criar `app/videos/[publicId]/preview/page.tsx` — RSC `async` que chama o upstream `GET /videos/{publicId}` server-side via `optionalAuthedUpstream` (bearer só com sessão), chama `notFound()` em `404`, e renderiza título/`public_id`, duração e dimensões (per `### API Contracts` → BFF tier `#### GET /api/videos/{publicId}`; per `phase-03-videos/TD-06`).
2. Renderizar `<video controls preload="metadata" src="/api/videos/{publicId}/stream">` e `<a href="/api/videos/{publicId}/download" download>` como link estilizado pelo DS (`buttonVariants`) — as duas URLs são same-origin e estáveis; expiração nunca é observável pelo player (per `phase-03-videos-frontend/TD-06`, `TD-07`).
3. Criar `app/videos/[publicId]/preview/not-found.tsx` com a mensagem de vídeo indisponível (um não-dono vê o mesmo para inexistente e não-pronto — nada vaza) (per decisions doc → "404, never 403").

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Página `/videos/[publicId]/preview` | E2E (Playwright) per testing-guide-next-frontend § "Page — async RSC" — renderiza `<video>` com `src` same-origin e o link com atributo `download`; `GET /api/videos/<id>/stream` sem seguir redirect responde `307` com `Location` no origin do storage e `cache-control: no-store`; `notfound0000` renderiza a página 404 | `tests/videos-preview.e2e-spec.ts` |

**Dependencies:** SI-03.10 (rotas de metadados/stream/download)

**Acceptance criteria:**

- `GET /videos/<id>/preview` de um vídeo `ready` renderiza um elemento `video` com `controls` e `src="/api/videos/<id>/stream"` e um link para `/api/videos/<id>/download` com o atributo `download`.
- A URL de stream responde `307` com `Location` no host do storage e `Cache-Control: no-store`; a de download responde `307` com `response-content-disposition` de anexo na `Location`.
- `GET /videos/notfound0000/preview` responde `404` com a página de vídeo indisponível.

---

### SI-03.17 — Smoke manual contra a stack real (Verification)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-videos-frontend/TD-08 — Test Strategy for the Direct-to-Storage Byte Path` → Verificação

**Technical actions:**

1. Criar `docs/phases/phase-03-videos-frontend/smoke-checklist.md` — checklist executável contra a stack real (`nestjs-project` + `next-frontend` no ar, `.env.local` do frontend apontando `API_URL` para o backend alcançável): login, upload de um vídeo curto real pela tela `/videos/upload`, `processing → ready` com thumbnail e duração, reprodução com seek no `<video>` da preview, download pelo link, e o caso de retomada (recarregar a página no meio do upload e re-selecionar o arquivo) (per `phase-03-videos-frontend/TD-08`, `TD-01`).
2. Executar o checklist uma vez e registrar o resultado (data, versão, itens ✓/✗ e observações) em `progress.md`; qualquer ✗ volta para o SI dono do defeito antes do fechamento (per `phase-03-videos-frontend/TD-08` — Definition of Done).

**Dependencies:** SI-03.1, SI-03.15, SI-03.16 (toda a fatia no ar)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Caminho browser → storage real (verification surface) | Manual per `TD-08` Option C — assertions enumeradas na Verificação de `TD-08`; o checklist é o artefato de teste | `docs/phases/phase-03-videos-frontend/smoke-checklist.md` |

**Acceptance criteria:**

- O checklist existe e cobre login, upload real, processamento até `ready`, reprodução com seek, download e retomada.
- Um upload real de um vídeo curto pela tela termina em `ready` com thumbnail visível, o `<video>` da preview reproduz e aceita seek (requisições com `Range` respondidas por `206`) e o download salva o arquivo com disposição de anexo — resultado registrado em `progress.md`.

---

## Technical Specifications

### API Contracts

Dois tiers sob este heading. O **backend tier** (Scope-driven) materializa as duas decisões `Cross-layer` que tocam o `nestjs-project/`: `TD-01` muda o **host** de toda URL presigned voltada ao browser e `TD-04` acrescenta um endpoint. O **BFF tier** materializa o plano de controle que o browser consome via `app/api/videos/**` — ele é emitido aqui por decisão `Cross-layer` (`TD-06` fixa a forma da URL same-origin que o `<video>` consome; `TD-02`, `TD-03` e `TD-04` fixam quais rotas BFF os hooks do uploader chamam) e pela partição strict-BFF registrada no topo do decisions doc (plano de controle via Next, bytes browser ⇄ storage), já que a fatia é `logic-only` e não há join de inventário para disparar o gatilho usual. Fonte do contrato: `nestjs-project/openapi.json` → `next-frontend/openapi.json` → `lib/api/types.gen.ts` → `paths` (per `next-frontend-openapi-typing/TD-01..TD-04`).

**Audiência das URLs presigned (SI-03.1, per `phase-03-videos-frontend/TD-01`).** Toda URL presigned que chega ao browser — `parts[].url` de `POST /videos/:publicId/upload/parts`, `thumbnail_url` de `GET /videos/:publicId/status` e de `GET /videos/:publicId`, `url` de `GET /videos/:publicId/stream` e de `GET /videos/:publicId/download` — passa a ser assinada por um segundo `S3Client` apontado para `STORAGE_PUBLIC_ENDPOINT` (nova variável; default `http://localhost:9000`, a porta publicada do MinIO). O presign que o worker faz para o `ffmpeg` ler o source (`video-processor.service.ts`) e todas as chamadas server-to-server (create/complete/abort/listParts/putObject) continuam no cliente interno (`STORAGE_ENDPOINT`). A audiência (`'browser' | 'server'`) é parâmetro **obrigatório** de `presignUploadPart` e `presignGetObject` — nunca um default. Nenhum caminho ou corpo de resposta muda; só o host dentro das URLs.

#### GET /videos/:publicId/upload/parts (SI-03.2)

Lista as partes já recebidas pelo storage para o multipart ativo do vídeo — o caminho de retomada após recarregar a página: o cliente descobre o que já chegou (com os `ETag`s que só o storage conhece), assina só as partes que faltam e completa com ETags vindos do servidor *(TD-04)*.

**Request headers:**
- (authenticated owner — see Authorization Matrix)

**Response 200:**
- parts: array of `{ part_number: integer, etag: string, size: integer }` — projeção de `ListParts` (`PartNumber`, `ETag`, `Size`), em ordem crescente de `part_number`; array vazio quando nenhuma parte chegou ainda

**Error responses:**
- 401: when no valid bearer token is presented
- 404 VIDEO_NOT_FOUND: when no video with `publicId` exists for this owner (a video of another owner is indistinguishable from a nonexistent one)
- 409 INVALID_UPLOAD_STATE: when the video has no active multipart upload (not in `draft`)

---

> _BFF tier — frontend-exposed contract. The browser calls the FE-facing route under `app/api/videos/**`; the route proxies the upstream NestJS API server-side per the strict-BFF architecture documented in `next-frontend/CLAUDE.md` (Route Handlers as the only NestJS caller). Contract source-of-truth: `next-frontend/openapi.json` → `lib/api/types.gen.ts` → `paths`. Rotas de dono injetam `Authorization: Bearer <session.accessToken>` lido do cookie `iron-session` *(per phase-02-auth-frontend/TD-02)* e passam por refresh single-flight num 401 upstream *(per phase-02-auth-frontend/TD-03)*; sem sessão o BFF responde `401` com o envelope `{ statusCode: 401, error: "UNAUTHORIZED", message }` sem chamar o upstream *(per phase-02-auth-frontend/TD-01 — o cookie BFF é a autoridade de autenticação)*. Rotas públicas injetam o bearer **apenas quando existe sessão** (o upstream distingue dono de anônimo). Nenhuma rota desta fatia tem efeito de sessão (`Set-Cookie`)._

#### POST /api/videos (SI-03.7)

**forwards-to:** `POST /videos` *(derived: project contract source)*

**Request headers:**
- Content-Type: application/json *(derived: project contract source)*
- Authorization: Bearer — injected by the BFF from the session cookie *(per phase-02-auth-frontend/TD-02)*

**Request body:** `InitiateUploadDto` *(derived: project contract source — `filename`, `content_type`, `size_bytes`, `part_size_bytes?`; not re-spelled here to avoid duplication)*

**Response 201 (FE-facing):** `{ public_id, upload_id, part_size_bytes, part_count, expires_in }` — pass-through *(derived: project contract source; reshape: none)*

**Error responses (FE-facing):**
- 401 UNAUTHORIZED: emitted by the BFF when there is no session *(per phase-02-auth-frontend/TD-01)*
- 400 validation error: pass-through *(derived: project contract source)*
- 413 FILE_TOO_LARGE: pass-through *(derived: project contract source)*
- 415 UNSUPPORTED_MEDIA_TYPE: pass-through *(derived: project contract source)*

---

#### POST /api/videos/{publicId}/upload/parts (SI-03.7)

**forwards-to:** `POST /videos/{publicId}/upload/parts` *(derived: project contract source)*

**Request headers:**
- Content-Type: application/json *(derived: project contract source)*
- Authorization: Bearer — injected by the BFF *(per phase-02-auth-frontend/TD-02)*

**Request body:** `PresignPartsDto` *(derived: project contract source — `part_numbers: integer[]`; the uploader sends exactly one number per call, per phase-03-videos-frontend/TD-03)*

**Response 200 (FE-facing):** `{ parts: [{ part_number, url }], expires_in }` — pass-through *(derived: project contract source; reshape: none)*; each `url` is signed for the browser-reachable host *(per phase-03-videos-frontend/TD-01)*

**Error responses (FE-facing):**
- 401 UNAUTHORIZED: emitted by the BFF when there is no session *(per phase-02-auth-frontend/TD-01)*
- 400 validation error: pass-through *(derived: project contract source)*
- 404 VIDEO_NOT_FOUND: pass-through *(derived: project contract source)*
- 409 INVALID_UPLOAD_STATE: pass-through *(derived: project contract source)*

---

#### GET /api/videos/{publicId}/upload/parts (SI-03.7)

**forwards-to:** `GET /videos/{publicId}/upload/parts` *(derived: project contract source — endpoint added by SI-03.2 per phase-03-videos-frontend/TD-04)*

**Request headers:**
- Authorization: Bearer — injected by the BFF *(per phase-02-auth-frontend/TD-02)*

**Response 200 (FE-facing):** `{ parts: [{ part_number, etag, size }] }` — pass-through *(derived: project contract source; reshape: none)*

**Error responses (FE-facing):**
- 401 UNAUTHORIZED: emitted by the BFF when there is no session *(per phase-02-auth-frontend/TD-01)*
- 404 VIDEO_NOT_FOUND: pass-through *(derived: project contract source)*
- 409 INVALID_UPLOAD_STATE: pass-through *(derived: project contract source)*

---

#### POST /api/videos/{publicId}/upload/complete (SI-03.8)

**forwards-to:** `POST /videos/{publicId}/upload/complete` *(derived: project contract source)*

**Request headers:**
- Content-Type: application/json *(derived: project contract source)*
- Authorization: Bearer — injected by the BFF *(per phase-02-auth-frontend/TD-02)*

**Request body:** `CompleteUploadDto` *(derived: project contract source — `parts: [{ part_number, etag }]`; not re-spelled here to avoid duplication)*

**Response 200 (FE-facing):** `{ public_id, status }` — pass-through *(derived: project contract source; reshape: none)*

**Error responses (FE-facing):**
- 401 UNAUTHORIZED: emitted by the BFF when there is no session *(per phase-02-auth-frontend/TD-01)*
- 400 validation error: pass-through *(derived: project contract source)*
- 404 VIDEO_NOT_FOUND: pass-through *(derived: project contract source)*
- 409 INVALID_UPLOAD_STATE: pass-through *(derived: project contract source)*

---

#### DELETE /api/videos/{publicId}/upload (SI-03.8)

**forwards-to:** `DELETE /videos/{publicId}/upload` *(derived: project contract source)*

**Request headers:**
- Authorization: Bearer — injected by the BFF *(per phase-02-auth-frontend/TD-02)*

**Response 204 (FE-facing):** No content — pass-through *(derived: project contract source; reshape: none)*

**Error responses (FE-facing):**
- 401 UNAUTHORIZED: emitted by the BFF when there is no session *(per phase-02-auth-frontend/TD-01)*
- 404 VIDEO_NOT_FOUND: pass-through *(derived: project contract source)*
- 409 INVALID_UPLOAD_STATE: pass-through *(derived: project contract source)*

---

#### GET /api/videos/{publicId}/status (SI-03.9)

**forwards-to:** `GET /videos/{publicId}/status` *(derived: project contract source)*

**Request headers:**
- Authorization: Bearer — injected by the BFF *(per phase-02-auth-frontend/TD-02)*

**Response 200 (FE-facing):** `{ public_id, status, duration_seconds?, width?, height?, thumbnail_url?, failure_reason? }` — pass-through *(derived: project contract source; reshape: none)*; `thumbnail_url` is signed for the browser-reachable host *(per phase-03-videos-frontend/TD-01)*

**Error responses (FE-facing):**
- 401 UNAUTHORIZED: emitted by the BFF when there is no session *(per phase-02-auth-frontend/TD-01)*
- 404 VIDEO_NOT_FOUND: pass-through *(derived: project contract source)*

---

#### GET /api/videos/{publicId} (SI-03.10)

**forwards-to:** `GET /videos/{publicId}` *(derived: project contract source)*

**Request headers:**
- Authorization: Bearer — injected **only when a session exists** (public route; the owner sees a non-ready video) *(per phase-02-auth-frontend/TD-02)*

**Response 200 (FE-facing):** `{ public_id, title, status, duration_seconds, width, height, thumbnail_url, created_at }` — pass-through *(derived: project contract source; reshape: none)*

**Error responses (FE-facing):**
- 404 VIDEO_NOT_FOUND: pass-through *(derived: project contract source)*

---

#### GET /api/videos/{publicId}/stream (SI-03.10)

**forwards-to:** `GET /videos/{publicId}/stream` *(derived: project contract source)*

**Request headers:**
- Authorization: Bearer — injected only when a session exists *(per phase-02-auth-frontend/TD-02)*

**Response 307 (FE-facing):** no body; `Location: <url>` where `url` is the upstream's presigned, Range-capable storage URL, and `Cache-Control: no-store` so the redirect is never cached past the URL's TTL *(reshape per phase-03-videos-frontend/TD-06 — the browser follows the redirect preserving `Range`; every subsequent range request repeats the handshake with a freshly signed URL; bytes never traverse Node)*

**Error responses (FE-facing):**
- 404 VIDEO_NOT_FOUND: pass-through *(derived: project contract source)*
- 409 VIDEO_NOT_READY: pass-through *(derived: project contract source)*

---

#### GET /api/videos/{publicId}/download (SI-03.10)

**forwards-to:** `GET /videos/{publicId}/download` *(derived: project contract source)*

**Request headers:**
- Authorization: Bearer — injected only when a session exists *(per phase-02-auth-frontend/TD-02)*

**Response 307 (FE-facing):** no body; `Location: <url>` where `url` is the upstream's presigned URL carrying `response-content-disposition: attachment` (the `downloadFilename` is set upstream), and `Cache-Control: no-store` *(reshape per phase-03-videos-frontend/TD-06 — same mechanism as stream; per phase-03-videos-frontend/TD-07 the surface is a plain `<a download>` pointing here)*

**Error responses (FE-facing):**
- 404 VIDEO_NOT_FOUND: pass-through *(derived: project contract source)*
- 409 VIDEO_NOT_READY: pass-through *(derived: project contract source)*

### Authorization Matrix

"Authenticated" = usuário logado que **não** é o dono do vídeo. "Owner" = dono do canal do vídeo. No BFF, "logado" significa cookie `iron-session` presente com `isLoggedIn: true`; a posse é decidida pelo upstream (404 para não-dono, nunca 403).

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| GET /videos/:publicId/upload/parts (backend) | ✗ | ✗ | ✓ |
| POST /api/videos | ✗ | ✓ | ✓ |
| POST /api/videos/:publicId/upload/parts | ✗ | ✗ | ✓ |
| GET /api/videos/:publicId/upload/parts | ✗ | ✗ | ✓ |
| POST /api/videos/:publicId/upload/complete | ✗ | ✗ | ✓ |
| DELETE /api/videos/:publicId/upload | ✗ | ✗ | ✓ |
| GET /api/videos/:publicId/status | ✗ | ✗ | ✓ |
| GET /api/videos/:publicId | ✓ † | ✓ † | ✓ |
| GET /api/videos/:publicId/stream | ✓ † | ✓ † | ✓ |
| GET /api/videos/:publicId/download | ✓ † | ✓ † | ✓ |
| Tela `/videos/upload` | ✗ (redirect `/login`) | ✓ | ✓ |
| Tela `/videos/:publicId/preview` | ✓ † | ✓ † | ✓ |

† Only when the video is `ready`. For a non-`ready` video a non-owner receives `404 VIDEO_NOT_FOUND`; the owner receives `409 VIDEO_NOT_READY` on stream/download and sees the metadata in any state. The matrix for the upstream routes is unchanged from `phase-03-videos`.

### Error Catalog

Envelope `{ statusCode, error, message }` herdado de `phase-02-auth/TD-07`; os códigos de domínio desta fase vêm todos do `phase-03-videos` (`VIDEO_NOT_FOUND`, `VIDEO_NOT_READY`, `INVALID_UPLOAD_STATE`, `FILE_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`) e o BFF os **repassa verbatim** com o mesmo status HTTP. Esta fatia não cria código de domínio novo no backend; a única origem de erro própria do BFF é a ausência de sessão.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| UNAUTHORIZED | 401 | Rota BFF de dono chamada sem cookie de sessão (`isLoggedIn` falso) — emitido pelo BFF sem chamar o upstream; mesmo envelope que o helper de refresh devolve quando a sessão expira *(per phase-02-auth-frontend/TD-03)* |
| VIDEO_NOT_FOUND | 404 | pass-through do upstream (inexistente, ou não-`ready` acessado por não-dono) |
| VIDEO_NOT_READY | 409 | pass-through do upstream (dono pede stream/download antes de `ready`) |
| INVALID_UPLOAD_STATE | 409 | pass-through do upstream (presign/list/complete/abort sem multipart ativo) |
| FILE_TOO_LARGE | 413 | pass-through do upstream |
| UNSUPPORTED_MEDIA_TYPE | 415 | pass-through do upstream |

No plano de bytes (browser ⇄ storage) os erros não têm envelope: um `PUT` de parte responde `403` quando a URL expirou (estruturalmente improvável com a assinatura sob demanda de `TD-03`; o uploader re-assina via `signPart` e tenta de novo per `retryDelays`) e `5xx`/falha de rede entram no retry por parte do `@uppy/aws-s3`.

### Frontend Runtime

#### phase-03-videos-frontend/TD-02 — Multipart Upload Client Implementation

**Pattern:** Used headlessly (Uppy core + `@uppy/aws-s3`, this project's own React UI on top). The four override hooks map one-to-one onto the four endpoints already shipped, so the integration is configuration rather than translation, and the risky mechanics — retry, concurrency, ETag accounting, cancellation — arrive tested. Note the choice is not fully independent of TD-04 — Option A brings a resume story with it. Com `TD-04` Option B, o quinto hook (`listParts`) fecha a retomada sem estado no cliente.

**Setup:** canonical shape — F2-load-bearing only (per `library-refs.md` → `@uppy/core`, `@uppy/aws-s3`).

```ts
// next-frontend/lib/videos/uploader.ts
const uppy = new Uppy({ autoProceed: false, restrictions: { maxNumberOfFiles: 1, allowedFileTypes: ["video/*"] } });
uppy.use(AwsS3, {
  shouldUseMultipart: true,
  getChunkSize: () => partSizeBytes,          // part_size_bytes devolvido por POST /api/videos
  limit: 4,
  retryDelays: [0, 1000, 3000, 5000],
  createMultipartUpload, signPart, listParts, completeMultipartUpload, abortMultipartUpload,
});
// createMultipartUpload → POST /api/videos            → { uploadId: upload_id, key: public_id }
// signPart            → POST /api/videos/{key}/upload/parts { part_numbers: [partNumber] } → { url }
// listParts           → GET  /api/videos/{key}/upload/parts → [{ PartNumber, ETag, Size }]
// completeMultipartUpload → POST /api/videos/{key}/upload/complete { parts: [{ part_number, etag }] }
// abortMultipartUpload    → DELETE /api/videos/{key}/upload
```

`key` **é o `public_id`** e `uploadId` é o `upload_id` devolvidos por `POST /api/videos`; o browser nunca vê a `storage_key`. `getChunkSize` devolve exatamente o `part_size_bytes` que o backend calculou — é o único jeito de o `part_count` do servidor e o número de partes que o Uppy fatia coincidirem. A retomada após recarregar a página reusa a instância com a chave já conhecida (`?resume=<public_id>&size=<size_bytes>` na URL da tela, gravado via `history.replaceState` assim que o rascunho é criado): o usuário re-seleciona o arquivo, o tamanho é conferido contra `size`, e o Uppy chama `listParts` antes de assinar — só as partes ausentes passam por `signPart`.

**Aplicação:** `ui_in_scope: logic-only` — alvo por capability/file-pattern. Adota o padrão todo código que envia bytes de vídeo para o storage a partir do browser: a superfície de verificação `/videos/upload` (`components/videos/upload-panel.tsx`) nesta fatia, e qualquer re-upload/substituição de arquivo que a Fase 04 venha a construir. **Exclui** a thumbnail (gerada e gravada pelo worker, `phase-03-videos/TD-05`) e qualquer tráfego de bytes via Next ou Nest (`phase-03-videos/TD-03`, `TD-07`).

**Migração:** _No existing files require refactor — Setup SI is the only application of this pattern in the current phase._

**Verificação:**

- **Unit/Integration (Vitest + `msw/node`, `jsdom`):** os cinco adaptadores de hook chamam exatamente as rotas BFF do `### API Contracts` → BFF tier com os corpos tipados; um upload de 3 partes com `File` sintético faz 1 `POST /api/videos`, 3 `signPart` (uma parte por chamada, `TD-03`), 3 `PUT` no origin do storage fake e 1 `complete` com `[{ part_number, etag }]` em ordem; `abort` chama `DELETE`; a retomada chama `listParts` e assina **apenas** as partes que faltam.
- **E2E (Playwright):** a tela `/videos/upload` com o origin do storage stubado via `page.route()` (origin fora de `/api/**`, per `TD-08`) chega ao estado "processando" após um upload de 1 parte.
- **Regression guards:** `mocks/setup.ts` segue com `onUnhandledRequest: "error"` — qualquer `PUT` do uploader para um origin não fakeado derruba o teste.

#### phase-03-videos-frontend/TD-05 — Processing-Status Tracking on the Client

**Pattern:** hand-rolled `useVideoStatus` hook for this slice, mirroring `use-session.ts`. Adopting a data layer for the whole application on the strength of one polling loop is a large decision resting on a small case. The hook is small, mirrors `use-session.ts`, and is straightforwardly replaced. **Flag for Fase 04's research: revisit TanStack Query v5 as a deliberate agenda item, not by default.**

**Setup:** canonical shape — F2-load-bearing only.

```ts
// next-frontend/hooks/use-video-status.ts
useVideoStatus(publicId, { intervalMs: 2000, maxIntervalMs: 10000 })
// → { status: "idle" | "polling" | "ready" | "failed" | "error", video: VideoStatusResponse | null, error }
// setTimeout recursivo (não setInterval); para em status ∈ { "ready", "failed" };
// backoff: intervalo × 1.5 até maxIntervalMs; AbortController cancelado no unmount;
// pausa enquanto document.visibilityState === "hidden" e retoma no "visible".
// Fonte: GET /api/videos/{publicId}/status (BFF).
```

**Aplicação:** `ui_in_scope: logic-only` — alvo por capability. Adota o padrão a superfície de status da tela `/videos/upload` (`components/videos/processing-status.tsx`), que começa a fazer polling assim que `completeMultipartUpload` resolve e para no estado terminal. A Fase 04 (dashboard de vídeos) **não** deve clonar este hook: é o ponto de revisita explícito de TanStack Query.

**Migração:** _No existing files require refactor — Setup SI is the only application of this pattern in the current phase._

**Verificação:**

- **Unit (Vitest `jsdom`, `vi.useFakeTimers()` + MSW):** sequência `processing → processing → ready` para após `ready` e expõe `duration_seconds`/`thumbnail_url`; `failed` para e expõe `failure_reason`; o intervalo cresce com backoff até o teto; desmontar o componente aborta o fetch em voo e não dispara novos; aba oculta (`visibilitychange`) pausa o polling e `visible` retoma.
- **Integration/E2E:** coberto pela tela de upload (SI da tela) — o status `ready` do fixture MSW leva ao link de preview.
- **Regression guards:** nenhum (greenfield).

#### phase-03-videos-frontend/TD-08 — Test Strategy for the Direct-to-Storage Byte Path

**Pattern:** **Option A as the automated baseline, plus Option C's manual smoke as an explicit Definition-of-Done item for this slice** — with Option B recorded as the follow-up once the slice is stable. Option A alone would repeat TD-01's mistake in a new place (a green suite proving nothing about the browser-facing contract), so *something* must touch the real seams; the manual smoke is the honest middle. If Option B is chosen, it belongs in its own task after this slice lands, not inside it.

**Setup:** canonical shape — F2-load-bearing only.

```ts
// next-frontend/mocks/storage-origin.ts
export const STORAGE_ORIGIN = "http://storage.local:9000";   // não resolve: um PUT não-fakeado falha alto
// next-frontend/mocks/handlers/storage.ts
http.put(`${STORAGE_ORIGIN}/*`, ({ request }) => new HttpResponse(null, {
  status: 200,
  headers: { ETag: `"etag-${new URL(request.url).searchParams.get("partNumber")}"` },
}))
// reserved trigger: uploadId === "expired" → 403 (URL expirada); todo fixture presigned de mocks/handlers/videos.ts aponta para STORAGE_ORIGIN
// next-frontend/tests/storage-stub.ts (Playwright) — page.route(`${STORAGE_ORIGIN}/**`) devolvendo 200 + ETag; nunca page.route() em /api/**
```

**Aplicação:** `ui_in_scope: logic-only` — alvo por file-pattern. Em Vitest, todo teste que exercita `lib/videos/uploader.ts` ou `components/videos/upload-panel.tsx` roda contra os dois planos fakeados (`mocks/handlers/videos.ts` para o upstream via BFF, `mocks/handlers/storage.ts` para os `PUT`s). Em Playwright, `tests/videos-upload.e2e-spec.ts` stuba **só** o origin do storage; o upstream continua fakeado server-side pelo `instrumentation.ts`. O smoke manual contra a stack real (`docs/phases/phase-03-videos-frontend/smoke-checklist.md`) é item do `## Deliverables`. **Exclui** qualquer lane Playwright full-stack contra NestJS + MinIO reais (Option B, tarefa posterior).

**Migração:**

| File | Current behavior | Required change | Owning SI |
|------|-----------------|-----------------|-----------|
| `next-frontend/mocks/handlers/index.ts` | Barrel agrega `auth` + `_seed` | Agregar também `videos` e `storage` (um import + um spread cada) | SI-03.5 (videos) / SI-03.6 (storage) |

**Verificação:**

- **Unit/Integration:** a Verificação de `TD-02` acima é executada inteira sobre este harness; `onUnhandledRequest: "error"` prova que nenhum byte escapa para um origin real.
- **E2E:** o stub de storage conta os `PUT`s interceptados e o teste assere `count === part_count`.
- **Manual (DoD):** com a stack real no ar (`nestjs-project` + `next-frontend`), fazer login, enviar um vídeo curto real pela tela, observar `processing → ready` (thumbnail e duração), reproduzir no `<video>` com seek, baixar pelo link — checklist em `smoke-checklist.md`, resultado registrado em `progress.md`.
- **Regression guards:** `tests/auth-*.e2e-spec.ts` seguem verdes — o barrel ganhou handlers, nenhum existente mudou.

---

## Dependency Map

```
SI-03.1 (root) — endpoint público de assinatura (TD-01, backend)
└── SI-03.2 — depends on SI-03.1 (GET /videos/:publicId/upload/parts, TD-04, backend)
    └── SI-03.3 — depends on SI-03.2 (sync OpenAPI → types.gen.ts + aliases de vídeos)
        ├── SI-03.4 — depends on SI-03.3 (guard de CI de frescor)
        ├── SI-03.5 — depends on SI-03.3 (handlers MSW do upstream de vídeos)
        │   └── SI-03.6 — depends on SI-03.5 (handlers MSW do storage + stub Playwright — TD-08 Setup)
        └── SI-03.7 — depends on SI-03.3, SI-03.5 (authedUpstream + BFF create/sign/list)
            ├── SI-03.8 — depends on SI-03.7 (BFF complete/abort)
            │   └── SI-03.11 — depends on SI-03.7, SI-03.8 (uploader Uppy — TD-02 Setup)
            │       └── SI-03.12 — depends on SI-03.11, SI-03.6 (uploader — TD-02 Verification)
            ├── SI-03.9 — depends on SI-03.7 (BFF status)
            │   └── SI-03.13 — depends on SI-03.9 (useVideoStatus — TD-05 Setup)
            │       └── SI-03.14 — depends on SI-03.13 (useVideoStatus — TD-05 Verification)
            └── SI-03.10 — depends on SI-03.7 (BFF metadados + redirect stream/download — TD-06)
                └── SI-03.16 — depends on SI-03.10 (tela de preview)
SI-03.15 — depends on SI-03.11, SI-03.13, SI-03.6, SI-03.9 (tela de upload)
SI-03.17 — depends on SI-03.1, SI-03.15, SI-03.16 (smoke manual — TD-08 Verification)
```

Ordem linearizada: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13 → SI-03.14 → SI-03.15 → SI-03.16 → SI-03.17. Nó-raiz: **SI-03.1**. SI-03.3 é o gargalo (nenhum artefato do frontend compila antes dele); SI-03.15 e SI-03.17 são os pontos de convergência.

---

## Deliverables

- [ ] SI-03.1 — Endpoint público de assinatura para URLs voltadas ao browser
- [ ] SI-03.2 — Endpoint de partes já enviadas (GET /videos/:publicId/upload/parts)
- [ ] SI-03.3 — Sincronizar o contrato OpenAPI no frontend e expor os aliases de vídeos
- [ ] SI-03.4 — Guarda de CI de frescor do contrato OpenAPI
- [ ] SI-03.5 — Handlers MSW do domínio videos (plano upstream)
- [ ] SI-03.6 — Harness do plano de bytes: handlers MSW do storage e stub Playwright (Setup)
- [ ] SI-03.7 — BFF: início do upload e assinatura/listagem de partes
- [ ] SI-03.8 — BFF: finalização e abort do upload
- [ ] SI-03.9 — BFF: status de processamento (polling)
- [ ] SI-03.10 — BFF: metadados públicos e redirect de streaming/download
- [ ] SI-03.11 — Cliente de upload multipart headless com Uppy (Setup)
- [ ] SI-03.12 — Cliente de upload multipart headless com Uppy (Verification)
- [ ] SI-03.13 — Hook de polling do status de processamento (Setup)
- [ ] SI-03.14 — Hook de polling do status de processamento (Verification)
- [ ] SI-03.15 — Tela de verificação de upload (`/videos/upload`)
- [ ] SI-03.16 — Tela de preview de reprodução e download (`/videos/[publicId]/preview`)
- [ ] SI-03.17 — Smoke manual contra a stack real (Verification)

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Frontend tests pass (`cd next-frontend && docker compose exec next-frontend npm test`)
- [ ] Frontend E2E tests pass (`cd next-frontend && docker compose exec -d next-frontend sh -c "MSW_ENABLED=true npm run dev"` then `npx playwright test` on the host)
- [ ] Type/compilation checks pass (`cd next-frontend && docker compose exec next-frontend npx tsc --noEmit`)
- [ ] Lint passes on new files (`cd next-frontend && docker compose exec next-frontend npm run lint`; `cd nestjs-project && docker compose exec nestjs-api npx eslint <arquivos novos/alterados>` — baseline do repo herdado fora do gate)
- [ ] Project builds successfully (`cd next-frontend && docker compose exec next-frontend npm run build`)
- [ ] Smoke manual de `TD-08` executado contra a stack real e registrado em `progress.md`
