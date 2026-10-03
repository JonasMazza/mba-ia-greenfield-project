# phase-03-videos-frontend — Progress

**Status:** in_progress
**SIs:** 12/17 completed

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
- **Status:** completed
- **Tests:** 16 passing (`lib/api/__tests__/authed.integration.test.ts`, `app/api/videos/__tests__/route.integration.test.ts`, `app/api/videos/[publicId]/upload/parts/__tests__/route.integration.test.ts`)
- **Observations:**
  - `authedUpstream` devolve a mesma tripla `{ data, error, response }` do `openapi-fetch` também no caso "sem sessão" (erro 401 fabricado pelo BFF), então todo Route Handler trata os dois casos com um único `if (error)`.
  - O `withRefresh` da Fase 02 trabalha com `Response`; o helper o reaproveita capturando a tripla da última tentativa e relendo a sessão a cada tentativa, porque o refresh rotaciona o token entre elas.
  - Em Next 16 os `params` de rota dinâmica são `Promise` — os handlers fazem `await params`, e os testes passam `{ params: Promise.resolve({ publicId }) }`.

### SI-03.8 — BFF: finalização e abort do upload
- **Status:** completed
- **Tests:** 6 passing (`app/api/videos/[publicId]/upload/complete/__tests__/route.integration.test.ts`, `app/api/videos/[publicId]/upload/__tests__/route.integration.test.ts`)
- **Observations:**
  - O mock do cookie de sessão repetido em cada teste de rota foi extraído para `app/api/videos/[publicId]/__tests__/session-harness.ts` (não é um arquivo de teste — o Vitest só coleta `*.test.ts`).

### SI-03.9 — BFF: status de processamento (polling)
- **Status:** completed
- **Tests:** 4 passing (`app/api/videos/[publicId]/status/__tests__/route.integration.test.ts`)
- **Observations:** none

### SI-03.10 — BFF: metadados públicos e redirect de streaming/download
- **Status:** completed
- **Tests:** 8 passing (`app/api/videos/[publicId]/__tests__/route.integration.test.ts`, `…/stream/__tests__/route.integration.test.ts`, `…/download/__tests__/route.integration.test.ts`)
- **Observations:**
  - `redirectToPresigned` responde `502 UPSTREAM_CONTRACT` se o upstream devolver 200 sem `url` — o campo é opcional no contrato gerado, e redirecionar para `undefined` seria pior do que falhar explícito. Não é um código do catálogo; é defesa contra drift de contrato.

### SI-03.11 — Cliente de upload multipart headless com Uppy (Setup)
- **Status:** completed
- **Tests:** no tests (Setup; `npx tsc --noEmit` exit 0, eslint limpo nos arquivos tocados; comportamento verificado em SI-03.12)
- **Observations:**
  - **Desvio do snippet — o tamanho de parte passa a ser do cliente.** No `@uppy/aws-s3` 5.1.0 o `MultipartUploader` chama `getChunkSize` no construtor, **antes** de `createMultipartUpload`; e o backend não persiste o tamanho de parte. Então "`getChunkSize` = `part_size_bytes` devolvido pelo `POST`" é impossível na primeira tentativa e irreproduzível na retomada. O uploader envia `part_size_bytes` (campo opcional que o `InitiateUploadDto` já aceita; default 64 MiB = o default do backend) e falha com `UPSTREAM_CONTRACT` se o eco divergir — a igualdade que o plano exige continua valendo, agora garantida e checada.
  - A retomada é disparada pelo marcador `file.s3Multipart = { key, uploadId }` (conferido em `MultipartUploader.js`/`index.js`): com os dois campos o Uppy chama `listParts` antes de assinar. Como nada devolve o `upload_id` depois de um reload e nenhuma rota BFF o lê, `resume` é `{ publicId, sizeBytes }` (sem `uploadId`) e o marcador leva um placeholder documentado.
  - Guarda extra na retomada: `listParts` rejeita (`RESUME_PART_MISMATCH`) uma parte armazenada cujo tamanho não bate com o fatiamento atual — sem isso o `complete` costuraria bytes desalinhados num objeto corrompido.
  - Evento `draft` além de `progress`/`complete`/`error`: é como a tela fica sabendo o `public_id` para gravar `?resume=` (SI-03.15). `destroy()` pausa em vez de cancelar, para não abortar o multipart (que perderia a retomada) ao desmontar.
  - `mocks/handlers/videos.ts` (SI-03.5): o fake do `POST /videos` passou a ecoar o `part_size_bytes` pedido, como o backend real (`dto.part_size_bytes ?? DEFAULT`); antes devolvia sempre 5 MiB.
  - O AC de build fica coberto quando a tela importar o uploader (SI-03.15) e na verificação final — até lá nenhum módulo do app o importa.

### SI-03.12 — Cliente de upload multipart headless com Uppy (Verification)
- **Status:** completed
- **Tests:** 5 passing (`lib/videos/__tests__/uploader.integration.test.ts`)
- **Observations:**
  - O plano de controle roda de verdade no teste: uma ponte MSW entrega cada `/api/videos/**` que o uploader chama ao Route Handler real (sessão via `session-harness.ts`), e o upstream que ele chama é respondido pelo fixture compartilhado. Assim os números do AC (1 draft, 3 assinaturas de uma parte, 3 `PUT`s, 1 `complete` com ETags em ordem) atravessam uploader → BFF → upstream fake.
  - Cenário extra além dos planejados: um envelope de erro do BFF (`toolarge.mp4` → 413) chega ao evento `error` com `status` e `code`, sem nenhum `PUT` — é o mapeamento que a tela (SI-03.15) consome.
  - O interceptor de XHR do MSW entrega uma resposta tardia até a um XHR já abortado (um browser real não faz isso) e isso disparava o handler de progresso do Uppy sobre um arquivo já removido; o cenário de cancelamento deixa o `PUT` sem resposta em vez de liberá-lo depois do abort.

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
