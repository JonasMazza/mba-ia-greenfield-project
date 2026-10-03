# phase-03-videos-frontend — Progress

**Status:** completed
**SIs:** 17/17 completed

## Final verification

| Deliverable | Comando | Resultado |
|---|---|---|
| Backend tests | `cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand` | **206/206** ✅ (30 suítes) |
| Backend E2E | `cd nestjs-project && docker compose exec nestjs-api npm run test:e2e` | **90/90** ✅ (8 suítes) |
| Backend type-check | `docker compose exec nestjs-api npx tsc --noEmit` | exit 0 ✅ |
| Frontend tests | `cd next-frontend && docker compose exec next-frontend npm test` | **123/123** ✅ (30 arquivos) |
| Frontend E2E | dev server com `MSW_ENABLED=true` + `npx playwright test` no host | **14/14** ✅ (auth + `videos-upload` + `videos-preview`) |
| Frontend type-check | `docker compose exec next-frontend npx tsc --noEmit` | exit 0 ✅ |
| Lint frontend | `docker compose exec next-frontend npm run lint` | exit 0 ✅ — 1 warning pré-existente (`react-hooks/incompatible-library` em `components/auth/signup-form.tsx`), nenhum nos arquivos da fatia |
| Lint backend (arquivos alterados na fatia) | `npx eslint` nos 12 arquivos `.ts` tocados | exit 1 — só os **2 erros do baseline herdado** em `env.validation.integration-spec.ts` (linhas do teste de `SWAGGER_ENABLED`, de outro autor, anteriores à fase); nenhum problema novo |
| Frontend build | `docker compose exec next-frontend npm run build` | exit 0 ✅ — inclui `/videos/upload`, `/videos/[publicId]/preview` e as 8 rotas `/api/videos/**` |
| Smoke manual (`TD-08`) | `smoke-checklist.md` contra a stack real | 10/10 ✅ — ver SI-03.17 |

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
- **Status:** completed
- **Tests:** no tests (Setup; `npx tsc --noEmit` exit 0, eslint limpo; comportamento verificado em SI-03.14)
- **Observations:**
  - `publicId` aceita `null` (estado `idle`) e o estado inicial `polling` é derivado no render, não gravado com `setState` dentro do efeito — a regra `react-hooks/set-state-in-effect` do `eslint-plugin-react-hooks` 7 proíbe isso.
  - Qualquer requisição que falhe (resposta não-2xx ou erro de rede) encerra o loop em `error`; o snippet não definia política de erro e uma tela descartável não justifica retry com backoff próprio.

### SI-03.14 — Hook de polling do status de processamento (Verification)
- **Status:** completed
- **Tests:** 7 passing (`hooks/__tests__/use-video-status.test.tsx`)
- **Observations:**
  - Os fake timers falsificam só `setTimeout`/`clearTimeout`: o scheduler do React e o MSW usam `setImmediate`/microtasks reais, e o teste espera por eles com um `setTimeout` real capturado antes de o relógio ser falsificado — o `vi.waitFor` avançaria o relógio falso e estragaria a medição dos intervalos.
  - O abort no unmount é verificado pelo `request.signal` que chega ao handler MSW (o fetch interceptado propaga o `AbortSignal`).

### SI-03.15 — Tela de verificação de upload (`/videos/upload`)
- **Status:** completed
- **Tests:** 12 passing (8 em `components/videos/__tests__/upload-panel.test.tsx`, 2 em `components/videos/__tests__/processing-status.test.tsx`, 2 E2E em `tests/videos-upload.e2e-spec.ts`)
- **Observations:**
  - **Desvio do plano — thumbnail com `<Image unoptimized>` e sem `remotePatterns`.** A `thumbnail_url` é uma URL presigned: com otimização, o servidor do Next buscaria a imagem de um host que só o browser alcança (`localhost:9000` dentro do container é o próprio container) e o Next 16 ainda recusa otimizar IP local por padrão (`dangerouslyAllowLocalIP: false`). A doc do `next/image` instalado recomenda `unoptimized` para `src` autenticado; com ele o loader não roda e `remotePatterns` seria configuração morta (e dependente de ambiente: `storage.local:9000` nos testes, `localhost:9000` no smoke).
  - O `?resume=<public_id>&size=<bytes>` é gravado no `draft` e **removido** no `complete` e no cancelamento — depois disso não há multipart para retomar, e um reload com o parâmetro velho levaria a um `409 INVALID_UPLOAD_STATE`.
  - Um único botão primário: "Start upload" sem rascunho, "Resume upload" quando há um (vindo do `?resume` ou criado numa tentativa que falhou depois do `draft`) — é o "botão de retomar" do Error Catalog para falha de parte após os retries.
  - Os testes do painel fakeiam o plano de controle na fronteira `/api/**` (camada unit, como os testes de `components/auth`); os `PUT`s vão para o fake compartilhado do storage. Cenários extras além dos planejados: `401` com link para `/login` e a retomada pelo painel (lista as partes em vez de criar rascunho; tamanho divergente barrado sem requisição).
  - Ambiente: criado `next-frontend/.env.local` (ignorado pelo git) com `API_URL=http://host.docker.internal:3000` e um `SESSION_PASSWORD` aleatório — o container não tem variáveis no compose e o dev server não sobe sem elas; o mesmo arquivo serve ao smoke do SI-03.17. O Playwright 1.60 do projeto pedia o `chromium_headless_shell-1223`, ausente no cache do host; instalado com `npx playwright install --only-shell chromium`.

### SI-03.16 — Tela de preview de reprodução e download (`/videos/[publicId]/preview`)
- **Status:** completed
- **Tests:** 3 passing (E2E em `tests/videos-preview.e2e-spec.ts`)
- **Observations:**
  - **Fragilidade do harness de E2E (pré-existente, não desta fatia):** no Next 16 o hot reloader do Turbopack chama `resetFetch()` sempre que arquivos de servidor mudam, restaurando o `fetch` capturado no boot do router **antes** de o `instrumentation.ts` instalar o MSW. Editar código de servidor com o dev server no ar derruba a interceptação para o processo inteiro (todo upstream passa a ir para a rede real — até o login). Medido: a primeira renderização do RSC novo deu 500 e, a partir dali, `POST /api/auth/login` também. Contorno operacional: **reiniciar o dev server depois de editar arquivos e antes de rodar o Playwright** (`docker compose restart next-frontend` + subir de novo com `MSW_ENABLED=true`). Tornar o harness imune (reinstalar o MSW depois do reset) é tarefa separada.
  - O spec usa o gatilho `notfound0000` literal: importar `mocks/handlers/videos.ts` no Playwright puxa o `lib/env.ts`, que valida o env de servidor no host e derruba a coleta.
  - Para o dono, um vídeo ainda não `ready` mostra os metadados com uma mensagem de status em vez do `<video>` (o stream daria `409 VIDEO_NOT_READY`); para qualquer outro a página é o 404.

### SI-03.17 — Smoke manual contra a stack real (Verification)
- **Status:** completed
- **Tests:** checklist `smoke-checklist.md` executado em 2026-10-03 contra a stack real (commit `51dbb64`): 10/10 ✓, 0 erros de console
- **Observations:**
  - **Como foi executado:** Google Chrome real (perfil temporário, dirigido por um script Playwright descartável, para ter codecs H.264 e registrar rede/console item a item) → `next dev` **sem** MSW → NestJS (`start:dev`) + MinIO + `video-worker` reiniciado com o código atual. Conta de teste criada pelo `POST /auth/register` e confirmada pelo link do Mailpit. Arquivos: MP4 H.264/AAC de 10 s (1 MB) e MP4 de 30 s a 40 Mbps (142 MiB → 3 partes de 64 MiB), gerados com o `ffmpeg` do worker.
  - ✓ 1 login · ✓ 2 anônimo → `/login` · ✓ 3 upload curto: `?resume=<id>&size=1046084` gravado, 1 `PUT` em `localhost:9000` → 200, `complete` com o ETag lido pelo JS (CORS do MinIO expõe o `ETag`) · ✓ 4 `processing → ready`, thumbnail de `localhost:9000` carregada, `0:10` e `640 × 360`, `?resume` removido · ✓ 5 preview com `<video src="/api/videos/<id>/stream">` · ✓ 6 play + seek: `/stream` → 307 `no-store` para `localhost:9000`, `Range: bytes=0-` → 206; no vídeo de 142 MiB o seek gerou `bytes=123994112-` → 206 · ✓ 7 download: 307 com `response-content-disposition=attachment`, arquivo salvo com o tamanho do original · ✓ 8 reload no meio do upload (throttling de 6 MB/s; a parte 3 já tinha terminado) volta com o aviso e **Resume upload** · ✓ 9 arquivo de outro tamanho: erro inline, 0 requisições · ✓ 10 mesmo arquivo: 1 `listParts`, 0 rascunhos novos, só as partes 1 e 2 assinadas e enviadas, `complete` com 1, 2, 3, termina em `ready`.
  - **Achado fora do checklist — a premissa central da TD-06 não vale no Chrome.** O Chrome segue o 307 uma vez e reusa a URL **redirecionada** em todas as requisições de `Range` seguintes do mesmo `<video>` (mesma `X-Amz-Date`); ele não volta à URL same-origin. Medido: play, pausa, espera de 330 s (TTL de playback = 300 s), seek para fora do buffer → dezenas de tentativas na URL expirada e `MEDIA_ERR_NETWORK` ("FFmpegDemuxer: data source error"); nenhuma requisição nova a `/api/videos/<id>/stream`. Ou seja, a expiração **é** observável pelo player depois de 5 min, ao contrário do que a TD-06 assume ("every subsequent range request repeats the handshake"). Os ACs desta fatia (reprodução com seek e `206`) passam, e a superfície é descartável; mas a decisão precisa ser revisitada antes do player da Fase 05 (opções do próprio doc: recuperar no `error` do player recarregando o `src` same-origin e restaurando o `currentTime`, ou TTL de playback maior). Registrado como follow-up, sem correção nesta fatia.

## Revisão final (2026-10-03)

Code review de `main...dev` antes de levar a fase para `main`.

- **Corrigido — PR #5 (`bugfix/preview-page-no-refresh`):** a página de preview (Server Component) chamava `optionalAuthedUpstream`, cujo refresh grava cookie — proibido em RSC. Com o token expirado a página quebrava e o refresh token rotacionado se perdia (o refresh seguinte era tratado como reuso → logout). Novo `optionalAuthedUpstreamReadOnly`: bearer sem refresh, fallback anônimo no 401.
- **Verificação de `dev` integrada** (após os PRs #3, #4 e #5): ver a seção do PR `dev` → `main`.

### Follow-ups (não bloqueiam a entrega; decidir antes de implementar)

1. **TD-06 não vale no Chrome** (achado do SI-03.17): o Chrome reusa a URL redirecionada nos `Range` seguintes; depois do TTL de playback (300 s) um seek fora do buffer dá `MEDIA_ERR_NETWORK`. Decidir antes do player da Fase 05: recuperar no `error` do player recarregando o `src` same-origin e restaurando o `currentTime`, ou TTL de playback maior.
2. **Harness E2E imune ao `resetFetch` do Next 16:** reinstalar o MSW depois do reset do hot reloader, para não depender de reiniciar o dev server antes do Playwright.
3. **E2E `videos-upload` intermitente com o dev server frio:** a primeira compilação de `/api/videos/:id/status` pelo Turbopack pode estourar o timeout de 5 s do `expect` ("Processing" em vez de "ready"). Visto 1 vez em 4 execuções logo após o restart; aquecer as rotas ou alongar o timeout dessa asserção.
4. **Retomada sem saída:** se a retomada falha (`RESUME_PART_MISMATCH`, `409 INVALID_UPLOAD_STATE`, tamanho divergente), o `?resume=` e o rascunho ficam, e a única ação é "Resume upload", que falha de novo. Oferecer descartar (abort) o rascunho.
5. **Instâncias do Uppy nunca destruídas:** `destroy()` do uploader só pausa; os listeners `online`/`offline` que o Uppy registra no `window` (e o `File`) vazam a cada Start/Resume. Chamar `uppy.destroy()` depois de pausar.
6. **`refreshPromise` global no módulo** (`lib/auth/refresh.ts`, herdado da Fase 02): dois usuários com token expirando ao mesmo tempo compartilham o mesmo refresh. Chavear o single-flight por sessão.
7. **CI de frescor do contrato cobre só metade da cadeia:** `openapi-freshness.yml` não roda `openapi:export`, então uma mudança de controller/DTO sem reexportar o spec passa.
8. **Imports relativos profundos em testes** (`../../__tests__/session-harness`) nos testes de rota de vídeos — a rule de code quality pede `@/`.
9. **Guia de testes do frontend com caminhos antigos** (herdado): `artifacts/pages.md` cita `app/login/page.tsx` (é `app/(auth)/login/page.tsx`); `artifacts/route-handlers.md` diz que as rotas de auth estão vazias e cita `mocks/factories/auth.ts`, que não existe.

### Triagem dos follow-ups (2026-10-03)

| # | Follow-up | Decisão | Onde |
|---|---|---|---|
| 1 | TD-06 não vale no Chrome | **Decidido e corrigido.** A opção C continua como contrato; a B entra como recuperação: `StreamPlayer` recarrega o `src` same-origin em `MEDIA_ERR_NETWORK` e restaura posição e reprodução. Revisão registrada na TD-06. Verificado no Chrome real com TTL de 20 s (o `<video>` puro falha; o `StreamPlayer` volta a tocar 5 s após o erro). Limitação: o Chrome insiste ~30 s antes do erro — ponto para a Fase 05. | PR #11 |
| 2 | Harness E2E imune ao `resetFetch` | **Adiado** (ergonomia de teste). Contorno documentado no `next-frontend/CLAUDE.md`: reiniciar o dev server antes do Playwright. | — |
| 3 | E2E `videos-upload` intermitente com dev server frio | **Adiado**, baixa prioridade. Nas execuções desta rodada passou de primeira (14/14, duas vezes). | — |
| 4 | Retomada sem saída | **Próximo do frontend (alta).** O backend agora devolve `409 UPLOAD_EXPIRED` quando o upload sumiu do storage e o `abort` tolera esse caso (PR #9); falta a tela oferecer "Descartar". | — |
| 5 | Instâncias do Uppy nunca destruídas | **Próximo do frontend (média).** Correção pequena: `uppy.destroy()` depois de pausar. | — |
| 6 | `refreshPromise` global | **Próximo do frontend (alta).** Reanalisado: além de compartilhar o refresh entre usuários, a requisição que aguarda repete com o cookie da *própria* requisição (ainda com o token vencido) e recebe 401 — o single-flight não protege nem o mesmo usuário entre requisições. Precisa de chave por sessão **e** de devolver os tokens novos a quem aguarda. Herdado da Fase 02. | — |
| 7 | CI de frescor cobre só metade da cadeia | **Adiado.** Rodar `openapi:export` no CI exige instalar o backend no job; tarefa própria. | — |
| 8 | Imports relativos profundos em testes | **Adiado** (cosmético; não misturar com correções). | — |
| 9 | Guia de testes com caminhos antigos | **Adiado.** Tarefa única de docs com o follow-up 7 do backend. | — |

Verificação de `dev` com os PRs #8–#12: Vitest 131/131, Playwright 14/14, `tsc` 0, build ok.


### Rodada de correções (2026-10-03)

| # | Follow-up | Decisão | Onde |
|---|---|---|---|
| — | Rate limit pela IP do BFF (achado da triagem) | **Corrigido.** O BFF repassa o IP do navegador em `X-Forwarded-For` (última entrada, a do salto mais próximo) em toda chamada do `upstream` e no refresh do token (`lib/api/client-ip.ts`); a API conta o limite de auth por esse endereço. Verificado ponta a ponta sem MSW: o cliente A toma `429` na 11ª chamada, e o cliente B continua passando. | PR #14 |
| 6 | `refreshPromise` global | **Corrigido.** Rotações num mapa com chave = refresh token apresentado: a mesma sessão divide uma chamada, sessões diferentes não esperam umas pelas outras. Quem aguarda grava o par novo no próprio cookie antes de repetir a chamada. Uma rotação bem-sucedida fica disponível por 10 s (a carência da API, que nesse intervalo devolveria o token *revogado*). | PR #16 |
| 4 | Retomada sem saída | **Corrigido.** Botão "Discard upload" sempre que há rascunho: `DELETE` do upload. `404` conta como descartado; `409 INVALID_UPLOAD_STATE` leva ao status de processamento, porque o upload já tinha sido concluído. `UPLOAD_EXPIRED` e `RESUME_PART_MISMATCH` ganham mensagem própria. | PR #18 |
| 5 | Instâncias do Uppy nunca destruídas | **Corrigido, com ajuste na sugestão.** `uppy.destroy()` chama `cancelAll()`, e o `@uppy/aws-s3` responde abortando o multipart — a correção sugerida apagaria o rascunho a cada saída da tela. O `destroy()` do uploader libera a instância com o abort desligado; só o "Cancel upload" descarta. | PR #21 |

Verificação de `dev` com os PRs #14–#21: Vitest 149/149, Playwright 15/15, `tsc` 0, lint sem erros, build ok.
