# phase-03-videos-frontend — Progress

**Status:** in_progress
**SIs:** 1/17 completed

### SI-03.1 — Endpoint público de assinatura para URLs voltadas ao browser
- **Status:** completed
- **Tests:** 44 passing (`object-storage.service.integration-spec.ts`, `env.validation.integration-spec.ts`, `video-processor.service.integration-spec.ts`, `videos.service.integration-spec.ts`)
- **Observations:**
  - A audiência virou parâmetro obrigatório (`'browser' | 'server'`) de `presignUploadPart` e `presignGetObject`; o `PresignGetOptions` deixou de ter default — o compilador aponta todo call site que esquecer de decidir o host.
  - O segundo `S3Client` nunca abre conexão: `getSignedUrl` é HMAC local, então ele pode apontar para um host que o próprio container não resolve (`localhost:9000`).
  - Dentro do Docker o host publicado não é alcançável, então `src/test/jest-env.ts` (carregado pelos dois configs do Jest) pina `STORAGE_PUBLIC_ENDPOINT` ao endpoint interno nos testes — os specs que fazem `PUT`/`GET` nas URLs assinadas continuam funcionando. O host real do browser é verificado pelo smoke manual (SI-03.17).
  - Os 2 erros de lint restantes em `env.validation.integration-spec.ts` são do baseline herdado (teste do `SWAGGER_ENABLED`); o teste novo foi escrito sem `any`.

### SI-03.2 — Endpoint de partes já enviadas (GET /videos/:publicId/upload/parts)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — Sincronizar o contrato OpenAPI no frontend e expor os aliases de vídeos
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Guarda de CI de frescor do contrato OpenAPI
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Handlers MSW do domínio videos (plano upstream)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Harness do plano de bytes: handlers MSW do storage e stub Playwright (Setup)
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
