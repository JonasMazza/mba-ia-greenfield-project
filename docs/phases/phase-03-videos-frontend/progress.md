# phase-03-videos-frontend — Progress

**Status:** in_progress
**SIs:** 6/17 completed

### SI-03.1 — Endpoint público de assinatura para URLs voltadas ao browser
- **Status:** completed
- **Tests:** 44 passing (`object-storage.service.integration-spec.ts`, `env.validation.integration-spec.ts`, `video-processor.service.integration-spec.ts`, `videos.service.integration-spec.ts`)
- **Observations:**
  - A audiência virou parâmetro obrigatório (`'browser' | 'server'`) de `presignUploadPart` e `presignGetObject`; o `PresignGetOptions` deixou de ter default — o compilador aponta todo call site que esquecer de decidir o host.
  - O segundo `S3Client` nunca abre conexão: `getSignedUrl` é HMAC local, então ele pode apontar para um host que o próprio container não resolve (`localhost:9000`).
  - Dentro do Docker o host publicado não é alcançável, então `src/test/jest-env.ts` (carregado pelos dois configs do Jest) pina `STORAGE_PUBLIC_ENDPOINT` ao endpoint interno nos testes — os specs que fazem `PUT`/`GET` nas URLs assinadas continuam funcionando. O host real do browser é verificado pelo smoke manual (SI-03.17).
  - Os 2 erros de lint restantes em `env.validation.integration-spec.ts` são do baseline herdado (teste do `SWAGGER_ENABLED`); o teste novo foi escrito sem `any`.

### SI-03.2 — Endpoint de partes já enviadas (GET /videos/:publicId/upload/parts)
- **Status:** completed
- **Tests:** 41 passing (35 integration em `object-storage.service.integration-spec.ts` + `videos.service.integration-spec.ts`; 6 E2E em `test/videos-uploaded-parts.e2e-spec.ts`, autorado a partir de `specs/videos-uploaded-parts.plan.md`)
- **Observations:**
  - `listUploadedParts` do storage passou a devolver `{ part_number, etag, size }` ordenado em vez de só os números; o único consumidor anterior era o próprio spec, então não houve call site a migrar.
  - O cenário 4.1 do spec lê `openapi.json` do disco e confere `security`, respostas e o schema de `parts` — é o teste que garante que o contrato commitado acompanha a rota (o frontend gera os tipos a partir dele).

### SI-03.3 — Sincronizar o contrato OpenAPI no frontend e expor os aliases de vídeos
- **Status:** completed
- **Tests:** no tests (type-only; `npx tsc --noEmit` exit 0)
- **Observations:**
  - O contrato tem **8 paths** `/videos*` com 9 operações (`/upload/parts` carrega `get` e `post`) — o plano falava em "nove paths"; a contagem correta é essa.
  - Os schemas de resposta dos endpoints de vídeos são inline no `openapi.json` sem `required`, então todo campo sai opcional em `types.gen.ts`; os aliases ficaram pass-through (TD-04) e a estreiteza é feita no consumidor (BFF/hook).

### SI-03.4 — Guarda de CI de frescor do contrato OpenAPI
- **Status:** completed
- **Tests:** no tests (Infra) — sequência sync → `openapi:types` → `git diff --exit-code` reproduzida localmente com diff vazio
- **Observations:** none

### SI-03.5 — Handlers MSW do domínio videos (plano upstream)
- **Status:** completed
- **Tests:** no tests (test-infra; suíte existente segue 67/67 com o barrel ampliado)
- **Observations:**
  - As rotas públicas do fixture (`GET /videos/:id`, `/stream`, `/download`) decidem "dono vs. anônimo" pela presença do bearer — é o que permite testar a injeção condicional do token no BFF.
  - Trigger extra além dos planejados: `resumable000` devolve a parte 1 em `GET …/upload/parts`, para o cenário de retomada do uploader.

### SI-03.6 — Harness do plano de bytes: handlers MSW do storage e stub Playwright (Setup)
- **Status:** completed
- **Tests:** no tests (Setup; verificado por SI-03.12 e pelo E2E de SI-03.15)
- **Observations:**
  - O fake do storage responde também ao `OPTIONS` e envia `Access-Control-Expose-Headers: ETag` — sem isso um `PUT` cross-origin feito pelo browser (ou pelo XHR do jsdom) não consegue ler o ETag, que é exatamente o requisito que o MinIO real atende via `MINIO_API_CORS_ALLOW_ORIGIN`.

### SI-03.7 — BFF: início do upload e assinatura/listagem de partes
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — BFF: finalização e abort do upload
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — BFF: status de processamento (polling)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — BFF: metadados públicos e redirect de streaming/download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Cliente de upload multipart headless com Uppy (Setup)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Cliente de upload multipart headless com Uppy (Verification)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Hook de polling do status de processamento (Setup)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — Hook de polling do status de processamento (Verification)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.15 — Tela de verificação de upload (`/videos/upload`)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.16 — Tela de preview de reprodução e download (`/videos/[publicId]/preview`)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.17 — Smoke manual contra a stack real (Verification)
- **Status:** pending
- **Tests:** —
- **Observations:** none
