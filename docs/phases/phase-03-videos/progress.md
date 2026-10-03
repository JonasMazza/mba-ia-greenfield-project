# phase-03-videos — Progress

**Status:** completed
**SIs:** 8/8 completed

## Final verification

| Deliverable | Comando | Resultado |
|---|---|---|
| Backend tests | `docker compose exec nestjs-api npm test -- --runInBand` | **198/198** ✅ (30 suítes) |
| E2E tests | `docker compose exec nestjs-api npm run test:e2e` | **84/84** ✅ (7 suítes) |
| Type-check | `docker compose exec nestjs-api npx tsc --noEmit` | exit 0 ✅ |
| Build | `docker compose exec nestjs-api npm run build` | exit 0 ✅ |
| Lint (arquivos novos) | `npx eslint src/videos src/worker …` | exit 0 ✅ |
| Lint (repo inteiro) | `npm run lint` | exit 1 — **150 erros + 40 warnings nos mesmos 11 arquivos do baseline herdado**, nenhum problema novo |

Dois defeitos latentes do repositório base apareceram só ao rodar a suíte completa e foram corrigidos:

- `migrations.integration-spec.ts` derrubava as tabelas com `Promise.all`; a FK `videos → channels` fechou um ciclo de locks e gerou `deadlock detected`. Os `DROP` passaram a ser sequenciais.
- `npm run test:e2e` rodava os arquivos **em paralelo** — o `--runInBand` que o `nestjs-project/CLAUDE.md` afirma estar "já configurado" não existia em lugar nenhum. Com uma única suíte E2E de dados isso passava despercebido; com quatro, cada `beforeAll` apagava os usuários das outras. Adicionado `"maxWorkers": 1` ao `test/jest-e2e.json`.

### SI-03.1 — Criar módulo videos, entidade Video e migration
- **Status:** completed
- **Tests:** 14 passing
- **Observations:**
  - A relação bidirecional `Channel.videos` ↔ `Video.channel` obriga todo `DataSource` de teste que carrega `Channel` a conhecer `Video` (senão TypeORM lança `EntityMetadataNotFound`). Os 11 arrays `ALL_ENTITIES` dos specs existentes foram atualizados, e `cleanAllTables` passou a limpar `videos` antes de `channels`.
  - O `beforeAll` de `migrations.integration-spec.ts` agora derruba `video_status` **e** o pré-existente `verification_tokens_type_enum`. O segundo já era um bug latente do repo base (o spec só passava num banco onde as migrations nunca tinham rodado fora dele); sem isso a suíte não é re-executável.
  - `created_at`/`updated_at` foram criados como `timestamptz` conforme o Data Model do plano — as demais entidades do projeto usam `timestamp` sem timezone.
  - `size_bytes` é `bigint` no banco (o driver pg devolve string) e é projetado para `number` por um transformer na entidade, já que 10 GiB cabe folgado em `Number.MAX_SAFE_INTEGER`.
  - Criado `videos.module.spec.ts` (teste de compilação do módulo) além da tabela de Tests do SI, seguindo o §3 do testing guide, que exige teste de compilação para todo módulo com imports configurados.
  - A migration foi gerada pela CLI do TypeORM (`migration:generate`) conforme a regra do projeto, e depois formatada com Prettier.

### SI-03.2 — Provider de object storage (MinIO/S3) + infra
- **Status:** completed
- **Tests:** 7 passing
- **Observations:**
  - `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` pinados em `3.1106.0` (`--save-exact`), conforme o "pin 3.10xx" da TD-02.
  - O SDK v3 moderno assina `x-amz-checksum-*` por padrão (`requestChecksumCalculation: WHEN_SUPPORTED`). Um browser que faz PUT numa URL presigned não envia esses headers, o que quebraria a assinatura. O `S3Client` foi criado com `requestChecksumCalculation`/`responseChecksumValidation` em `WHEN_REQUIRED`.
  - **MinIO não implementa a API de CORS por bucket** (`mc cors set` responde "functionality that is not implemented"). O CORS é configurado no servidor via `MINIO_API_CORS_ALLOW_ORIGIN`, e o handler do próprio MinIO já expõe o `ETag` — que é o requisito da TD-03 para o browser conseguir fechar o multipart.
  - **Pendência fora de escopo:** a regra de lifecycle que aborta multipart uploads abandonados não foi instalada. O `mc` desta release não tem flag para `AbortIncompleteMultipartUpload` e **descarta o campo silenciosamente** no `mc ilm import` (o import responde "successfully" e o `export` volta sem a regra). Mitigação atual: o endpoint explícito de abort (SI-03.5). Vale aplicar a regra por SDK/`aws cli` numa tarefa futura.
  - SigV4 assina o método HTTP: uma URL presigned por `GetObjectCommand` só funciona com `GET`. O teste de download tinha usado `HEAD` e tomava 403 — corrigido para `GET` com `Range: bytes=0-0`.
  - `presignGetObject` monta o `Content-Disposition` no formato RFC 5987 (fallback ASCII + `filename*=UTF-8''`), evitando o `SignatureDoesNotMatch` com nomes acentuados apontado pela TD-08.

### SI-03.3 — Provider de fila em background (pg-boss)
- **Status:** completed
- **Tests:** 4 passing
- **Observations:**
  - **pg-boss 12 é ESM-only** (`"type": "module"`, `main: dist/index.mjs`) e o projeto compila para CommonJS — o Jest quebra com `Cannot use import statement outside a module`. Fixado em **`pg-boss@11.1.2`**, o último major que publica CJS (`export = PgBoss`, importado como `import PgBoss from 'pg-boss'`). Migrar para a 12 exigiria mover o subprojeto para ESM.
  - **`singletonKey` sozinho não deduplica.** Na política padrão (`standard`) ele é só um rótulo; a deduplicação exige `policy: 'stately'` (um job por chave entre os estados created+active) ou `'singleton'`. A fila `video.process` é criada com `stately` no `onModuleInit`. Cuidado: sob `stately` a ausência de chave conta como uma chave compartilhada, então `ensureQueue` mantém `standard` como padrão e a política é opt-in por fila.
  - O enqueue transacional usa a interface `Db` do pg-boss (`executeSql`) adaptada sobre o `EntityManager` do TypeORM — o job entra na mesma transação da linha do vídeo, e o rollback leva os dois.
  - `videos.constants.ts` foi criado neste SI com o nome da fila e as constantes de upload/public_id que os SIs seguintes consomem.

### SI-03.4 — Endpoint de início de upload (POST /videos)
- **Status:** completed
- **Tests:** 16 passing (9 unit/integration + 7 E2E do spec)
- **Observations:**
  - **`nanoid` 4+ também é ESM-only** — mesmo problema do pg-boss. Fixado em `nanoid@3.3.18` (último major com `index.cjs`).
  - Ambiguidade #1 do handoff resolvida como o spec assume: `part_size_bytes` abaixo de 5 MiB é **400** (`@Min` no DTO), não clamp silencioso.
  - `content_type` e o teto de 10 GiB **não** são validados no DTO: se fossem, virariam 400 e quebrariam os ACs #2/#3, que exigem 413/415. A checagem vive no service e sobe como exceção de domínio; o DTO só garante `@IsString`/`@Min(1)`.
  - O `id` do vídeo é gerado na aplicação (`randomUUID`) antes do insert, para que a `storage_key` já exista quando o multipart é aberto. Se o insert falhar, o service aborta o multipart — sem isso ficaria um upload órfão invisível no MinIO.
  - `VideosService` não consulta a tabela `channels` diretamente: `ChannelsService` ganhou `findByUserId`/`getByUserId` e a exceção `ChannelNotFoundException`, mantendo a entidade `Channel` sob o módulo dono dela.
  - O E2E usa `app.get(MailService)` para interceptar o token de confirmação, em vez de alcançar o campo privado `mailService` do `AuthService` como faz `auth.e2e-spec.ts` — mesma cobertura sem `any`.
  - Lint: os arquivos novos exigiram tipar o corpo das respostas do supertest (`res.body` é `any`) e o erro do driver pg. Zero erro de lint nos arquivos novos; `channels.service.ts` segue nos mesmos 6 problemas do baseline herdado.

### SI-03.5 — Ciclo de upload: presign de partes, complete e abort
- **Status:** completed
- **Tests:** 24 passing (14 integration + 10 E2E do spec)
- **Observations:**
  - Ambiguidade #2 do handoff resolvida como **hard delete**: o abort remove a linha do rascunho. O spec só assere o observável (o `public_id` deixa de resolver), então a escolha não vazou para o teste.
  - O cenário 3.1 do spec chama `GET /videos/:publicId/status` e `GET /videos/:publicId`, que só existem em SI-03.7/SI-03.8. Nesta rodada essas duas asserções checam apenas `404` (rota inexistente e id inexistente são indistinguíveis para o cliente). **Apertar para também exigir `errorCode: VIDEO_NOT_FOUND` quando as rotas existirem.**
  - A posse é resolvida dentro da própria consulta (`public_id` + `channel_id` do usuário), então um vídeo de outro dono é indistinguível de um inexistente — 404, nunca 403, como exige o AC #3.
  - O `complete` faz um `UPDATE ... WHERE status = 'draft'` dentro da transação e checa `affected`: dois completes concorrentes não geram dois jobs. Somado ao `stately` do pg-boss, a idempotência tem duas barreiras.
  - Testado explicitamente que uma falha no enqueue faz rollback da transição de status — o vídeo não fica em `processing` sem job correspondente.

### SI-03.6 — Worker FFmpeg de processamento de vídeo
- **Status:** completed
- **Tests:** 5 passing
- **Observations:**
  - Código do worker em `src/worker/` (e não numa pasta `worker/` na raiz do subprojeto) porque o `rootDir` do Jest é `src` — fora dali o spec do worker não seria coletado por `npm test`. O Dockerfile ficou em `Dockerfile.worker`, seguindo a convenção do `Dockerfile.dev` já existente.
  - **`ffmpeg` foi adicionado ao `Dockerfile.dev`.** Os Deliverables mandam rodar a suíte inteira com `docker compose exec nestjs-api npm test`, e o spec de integração do worker precisa de ffprobe/ffmpeg de verdade. A API nunca invoca esses binários — o processamento roda no serviço `video-worker`, que tem o seu próprio Dockerfile.
  - `autoLoadEntities` só enxerga entidades registradas por algum `forFeature`. O `WorkerModule` precisou importar `UsersModule` mesmo sem tocar em usuários: a cadeia `Video → Channel → User` quebrava o boot com `Entity metadata for Channel#user was not found`.
  - O fixture de vídeo é **gerado em tempo de teste** com `ffmpeg -f lavfi -i testsrc` — nenhum binário entra no repositório.
  - Retry limitado conforme TD-09: abaixo do limite o erro é relançado (pg-boss reagenda com backoff); ao atingir o limite o vídeo vai para `failed` com `failure_reason` e o erro é engolido, para o job não repetir para sempre.
  - Reentrega de job para vídeo já `ready` é no-op (verificado inclusive pelo `updated_at` inalterado) — o `singletonKey` cobre a fila, e essa checagem cobre a entrega at-least-once.

### SI-03.7 — Endpoint de status de processamento (polling)
- **Status:** completed
- **Tests:** 11 passing (4 integration + 7 E2E do spec)
- **Observations:**
  - A projeção omite as chaves em vez de devolvê-las como `null`: o spec assere `NÃO traz duration_seconds/width/height/thumbnail_url` para vídeos não-`ready`, o que só `toHaveProperty` negativo captura.
  - A asserção do SI-03.5 sobre `GET /:publicId/status` após abort foi **apertada** para exigir `errorCode: VIDEO_NOT_FOUND`, agora que a rota existe. Falta ainda apertar a rota pública `GET /:publicId` no SI-03.8.
  - O E2E resolve o canal do usuário via `User.email → Channel.user_id`, e não pelo `nickname`: o nickname é derivado e **sanitizado** a partir do e-mail (`status-owner` não sobrevive intacto), o que quebrou a primeira versão do teste.

### SI-03.8 — Playback público: metadata, streaming e download
- **Status:** completed
- **Tests:** 13 passing (5 integration + 8 E2E do spec)
- **Observations:**
  - **O `JwtAuthGuard` ganhou autenticação opcional.** Ele saía cedo em rotas `@Public()` e nunca preenchia `request.user`, mas a Authorization Matrix exige que o dono veja `409 VIDEO_NOT_READY` onde terceiros veem `404` — o que só é possível se a rota pública souber quem chamou. Agora, em rota pública com `Bearer` válido, o payload é anexado; token ausente ou inválido segue como requisição anônima, nunca 401. Rotas protegidas não mudaram (spec do guard segue verde).
  - **O nome do arquivo original não é persistido** — o Data Model não tem coluna `filename` (o `filename` do `POST /videos` só alimenta a chave de storage). O `Content-Disposition` do download usa `title` quando existe, senão o `public_id`, com extensão derivada do `content_type`. Se a Fase 04 quiser o nome original, precisa de uma coluna nova.
  - A asserção pendente do SI-03.5 sobre `GET /:publicId` após abort foi apertada para exigir `errorCode: VIDEO_NOT_FOUND`. **Nenhuma pendência de spec resta.**
  - O teste de não-vazamento compara o corpo da resposta byte a byte com o de um `public_id` inexistente, em `draft`/`processing`/`failed`, anônimo e autenticado — é a garantia de que os dois casos são indistinguíveis, não só de que ambos são 404.

## Revisão final (2026-10-03)

Code review de `main...dev` antes de levar a fase para `main`.

- **Corrigido — PR #4 (`bugfix/enforce-uploaded-size`):** o teto de 10 GiB só olhava o `size_bytes` declarado; o `complete` agora soma as partes guardadas no storage e recusa (`409 UPLOAD_SIZE_MISMATCH`) se não baterem com o declarado. `listUploadedParts` passou a paginar em 1000 partes (limite do S3; o MinIO devolve até 10 000, por isso nada quebrava localmente).
- **Corrigido — PR #3 (`docs/phase-03-doc-coherence`):** citações de arquivos inexistentes nos `CLAUDE.md`/README, fila `TBD` no diagrama C4, guia de testes do backend descrevendo storage em disco e BullMQ.

### Follow-ups (não bloqueiam a entrega; decidir antes de implementar)

1. **Partes órfãs sem teto de tamanho.** Cada URL de parte é assinada sem `Content-Length`, então partes nunca concluídas podem ocupar até 5 GiB cada até a limpeza de uploads parados do MinIO. Fechar exige persistir o tamanho de parte (migration) e assinar o `Content-Length`.
2. **Draft preso após `complete` parcial.** O storage conclui o multipart antes da transação; se a transação falhar (ou o MinIO expirar o upload), `complete`/`abort` passam a dar `NoSuchUpload` → 500 para sempre. Os dois deveriam tolerar `NoSuchUpload` (conferir o objeto e seguir, ou apagar a linha). O mesmo erro faz o perdedor de dois `complete` concorrentes receber 500 em vez de 409.
3. **`failure_reason` vaza a linha de comando do ffprobe/ffmpeg** (`ffmpeg.util.ts`), com a URL presigned interna e o access key id, e a devolve ao dono em `GET /videos/:id/status`. Gravar uma mensagem curta e limpa.
4. **Vídeo pode ficar em `processing` para sempre:** ffprobe/ffmpeg sem timeout (o pg-boss expira e re-tenta sem passar por `handleFailure`); o `retry_limit` da fila é fixado na criação, mas o worker decide a última tentativa pelo env atual; o comentário de `queue.config.ts` cita uma dead-letter queue que não está configurada.
5. **`part_size_bytes` sem teto:** acima de 5 GiB o plano gerado é recusado pelo MinIO (`EntityTooLarge`).
6. **Desvios das rules:** `.catch()` em `videos.service.ts` (`initiateUpload`); `@ApiProperty` manual em DTOs de request que já têm validadores; `MAX_PART_NUMBER` e `PG_UNIQUE_VIOLATION` duplicados fora de `videos.constants.ts`; `ConfigType` importado como valor em `worker.module.ts`; `VideosModule` exporta `VideosService` sem consumidor; `Error` genérico em `videos.service.ts`; o doc do DTO diz que `filename` deriva a chave de storage, mas não é usado.
7. **Documentação:** `testing-guide-nestjs-project/artifacts/entities.md` ainda diz que o projeto não tem entidades (desatualizado desde a Fase 02). Esta fatia ficou sem `library-refs.md` durante o planejamento porque o `/plan-validate` saiu `clean` na primeira passada (o `/plan-resolve` nunca rodou) e nenhum TD declara `**Libraries:**`. **Resolvido no fechamento (2026-10-03):** o arquivo foi gerado depois da implementação, pelo modo library-cache-only do `/plan-resolve` aplicado à mão, com consulta ao Context7 e restrito às APIs que o código usa; as divergências entre a documentação do Context7 e as versões instaladas estão registradas no próprio arquivo.

### Triagem dos follow-ups (2026-10-03)

Prioridade dada à robustez do fluxo de upload/processamento. Cada correção entrou por PR próprio para `dev`, com teste escrito antes da correção.

| # | Follow-up | Decisão | Onde |
|---|---|---|---|
| 1 | Partes órfãs sem teto de tamanho | **Adiado.** Exige migration (persistir o tamanho de parte) e assinar `Content-Length`; o risco depende de um usuário autenticado e é limitado pela limpeza de uploads parados do MinIO. Próxima rodada de backend. | — |
| 2 | Draft preso após `complete` parcial | **Corrigido.** `NoSuchUpload` vira `MultipartUploadNotFoundError`; o `complete` confere o objeto já costurado e segue para a transação (o perdedor de dois completes recebe `409 INVALID_UPLOAD_STATE`); sem objeto → `409 UPLOAD_EXPIRED`. O `abort` tolera o upload ausente e apaga o objeto que tenha sobrado. | PR #9 |
| 3 | `failure_reason` vaza a linha de comando do ffprobe/ffmpeg | **Corrigido.** `MediaToolError` com mensagem limpa (o que falhou + como o processo saiu); erro desconhecido vira mensagem genérica, o detalhe fica no log. | PR #8 |
| 4 | Vídeo preso em `processing` | **Corrigido.** Prazo nas ferramentas (90% de `expireInSeconds`); a fila recebe retry/expiração do env a cada boot (`updateQueue`); dead-letter `video.process.dead-letter` real, cujo consumidor marca `failed` o vídeo ainda em `processing`. | PR #10 |
| 5 | `part_size_bytes` sem teto | **Corrigido.** `@Max(5 GiB)` no DTO → `400` no `POST /videos`. | PR #12 |
| 6 | Desvios das rules | **Adiado.** Refactor sem mudança de comportamento; tarefa de limpeza própria, para não misturar escopo com correções. | — |
| 7 | Guia de testes desatualizado (`entities.md`) | **Adiado.** Vai junto com o follow-up 9 do frontend numa tarefa única de docs dos guias de teste. | — |

Verificação de `dev` com os PRs #8–#12: backend 223/223 + E2E 92/92, `tsc` 0.

