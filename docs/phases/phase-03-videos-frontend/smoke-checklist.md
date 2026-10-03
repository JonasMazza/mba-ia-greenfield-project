# phase-03-videos-frontend — Smoke contra a stack real

Item de Definition of Done da `TD-08` (Option C): a suíte automatizada fakeia os dois planos (BFF/upstream e storage), então é este checklist que toca as costuras reais — o host das URLs presigned (`TD-01`), o CORS do MinIO expondo o `ETag`, o `Range`/`206` do streaming e o worker processando de verdade. Execute-o uma vez antes de fechar a fatia e registre o resultado no `progress.md` (SI-03.17). Qualquer ✗ volta para o SI dono do defeito.

## Pré-requisitos

| | Como |
|---|---|
| Backend no ar | `cd nestjs-project && docker compose up -d` e `docker compose exec -d nestjs-api npm run start:dev`; `curl -I http://localhost:3000/videos/x/upload/parts` responde `401` |
| Worker com o código atual | `docker compose restart video-worker` depois de qualquer mudança de backend (ele roda `ts-node` sobre `src/` e só lê o código ao subir) |
| Storage voltado ao browser | `nestjs-project/.env` com `STORAGE_PUBLIC_ENDPOINT=http://localhost:9000`; o serviço `minio` com `MINIO_API_CORS_ALLOW_ORIGIN` |
| Frontend contra a API real | `next-frontend/.env.local` com `API_URL=http://host.docker.internal:3000` e `SESSION_PASSWORD` (≥ 32 caracteres); dev server **sem** `MSW_ENABLED`: `docker compose exec -d next-frontend npm run dev` |
| Conta confirmada | cadastro em `/signup` (ou `POST /auth/register`), link de confirmação no Mailpit (`http://localhost:8025`), login em `/login` |
| Arquivos | um vídeo curto real (ex. 10 s, H.264/AAC, ~1 MB) e um vídeo com mais de duas partes de 64 MiB (ex. ~150 MB) para a retomada |
| Browser | um Chrome com codecs proprietários (o Chromium de testes não decodifica H.264) e o DevTools → Network aberto |

## Checklist

| # | Passo | Esperado |
|---|---|---|
| 1 | Login em `/login` com a conta confirmada | sessão criada (cookie `iron-session`) |
| 2 | Abrir `/videos/upload` sem sessão (aba anônima) | redirect para `/login` |
| 3 | Logado, em `/videos/upload`, selecionar o vídeo curto e clicar **Start upload** | a URL ganha `?resume=<public_id>&size=<bytes>`; o progresso chega a 100%; o `PUT` da parte vai para `http://localhost:9000/...` e responde `200` com `ETag` legível (sem erro de CORS no console) |
| 4 | Aguardar o processamento | "Processing your video…" e, em seguida, "Your video is ready." com **thumbnail visível**, duração e dimensões; o `?resume` some da URL |
| 5 | **Open preview** | `/videos/<public_id>/preview` com o `<video>` e o link **Download** |
| 6 | Dar play e arrastar a barra (seek) | `GET /api/videos/<id>/stream` → `307` para `localhost:9000` com `Cache-Control: no-store`; as requisições ao storage levam `Range` e respondem `206`; o vídeo toca a partir do ponto escolhido |
| 7 | Clicar **Download** | `307` para uma URL com `response-content-disposition=attachment…`; o arquivo salvo tem o tamanho do original |
| 8 | Retomada: selecionar o vídeo grande, **Start upload**, e **recarregar a página** quando ao menos uma parte tiver terminado (com throttling no DevTools se a rede local for rápida demais) | a página volta com o aviso de upload pendente e o botão **Resume upload** |
| 9 | Selecionar um arquivo de **outro tamanho** e clicar **Resume upload** | erro inline ("This is not the file you started uploading…") e nenhuma requisição |
| 10 | Selecionar o **mesmo** arquivo e clicar **Resume upload** | um `GET /api/videos/<id>/upload/parts`; só as partes ausentes são assinadas e enviadas; nenhum `POST /api/videos` novo; termina em "Your video is ready." |

## Registro

No `progress.md`, entrada do SI-03.17: data, commit testado, como foi executado, item a item ✓/✗ e observações.
