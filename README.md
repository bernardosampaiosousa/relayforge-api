# RelayForge

A small webhook delivery service built with Fastify and PostgreSQL.

The problem I wanted to solve was simple: an API sends an event, but the receiving server times out. The event shouldn't disappear, and two workers shouldn't send the same pending job at the same time.

RelayForge stores events and deliveries in Postgres. A separate worker picks up pending jobs, signs each JSON body with HMAC-SHA256, and retries unsuccessful deliveries. This is a local demo, not a hosted webhook provider.

## How the pieces fit

- **API:** register/login, create a webhook destination, publish an event, inspect recent deliveries
- **Postgres:** stores accounts, destinations, events, and retry state
- **Worker:** claims due deliveries with `FOR UPDATE SKIP LOCKED`, sends HTTPS requests, records the result
- **Tests:** HTTP and worker tests without a database, plus an opt-in PostgreSQL integration suite

The service uses at-least-once delivery. If a worker crashes after sending a request but before saving its result, the receiver may see the same event again. The `x-relayforge-event-id` header is there to help receivers deduplicate it.

## Start it

You'll need Docker Compose.

```bash
git clone https://github.com/bernardosampaiosousa/relayforge-api.git
cd relayforge-api
cp .env.example .env
openssl rand -hex 32
```

Paste the generated value into `JWT_SECRET` in `.env`, then:

```bash
docker compose up --build
```

- API: http://localhost:3000
- Swagger: http://localhost:3000/docs
- Health: http://localhost:3000/health
- Database readiness: http://localhost:3000/ready

The Compose database credentials are **local-development defaults**, and its port is bound to localhost. Don't reuse those credentials or this network setup for a public deployment.

You can also run the API and worker with Node.js 22+ against your own Postgres instance:

```bash
npm ci
cp .env.example .env
npm run db:migrate
npm run dev
```

In a second terminal:

```bash
npm run dev:worker
```

## Send an event

Register an account:

```bash
curl -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"a-local-demo-password"}'
```

The response includes a JWT. Put it in `TOKEN`:

```bash
TOKEN='your-jwt-token'
```

Create an HTTPS destination you control:

```bash
curl -X POST http://localhost:3000/v1/endpoints \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://your-domain.example/hooks","eventTypes":["order.created"]}'
```

The response includes a signing secret, shown only once. Keep it if you want to verify signatures in your receiver.

Publish an event:

```bash
curl -X POST http://localhost:3000/v1/events \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"type":"order.created","idempotencyKey":"order-10001","payload":{"orderId":"10001"}}'
```

Check the attempt history with `GET /v1/deliveries` and the same bearer token. A delivery succeeds on HTTP 2xx. Timeouts, network errors, HTTP 408/425/429, and 5xx responses are retried up to five times. Other 3xx/4xx responses are treated as permanent failures, since sending the same request again usually won't help.

If you post the same event again with the same idempotency key and payload, you get the existing event ID. Changing the payload while reusing the key returns 409.

## Design notes

I used a separate worker instead of sending webhooks inside the API request because receivers may be slow or unreachable. Publishing the event and enqueuing deliveries happen in one transaction, so a failed write doesn't leave half an event behind.

Two workers can poll at once because Postgres locks claimed rows. A job left in `processing` for over three minutes becomes eligible again. Status updates check the attempt number, so a worker holding an expired claim can't overwrite the result of a newer attempt. The delivery signature is calculated over the exact serialized JSON body, not a reconstructed object.

Before each outbound request, the worker resolves the hostname and checks every returned IP address. It connects using one of those checked addresses while keeping the original hostname for TLS verification. This matters because checking DNS and then letting the HTTP client resolve the name again would leave a DNS-rebinding gap. Redirects are not followed.

Relevant files:

- [`src/app.ts`](src/app.ts): routes and request schemas
- [`src/pg-store.ts`](src/pg-store.ts): database queries and job claiming
- [`src/dispatcher.ts`](src/dispatcher.ts): HTTP calls, signatures, retries
- [`src/security.ts`](src/security.ts): passwords and webhook URL checks
- [`src/network.ts`](src/network.ts): outbound IP checks and TLS connections

## Tests and limits

```bash
npm run check
npm run build
```

For the PostgreSQL integration tests, use a **disposable** database ending in `_test`:

```bash
TEST_DATABASE_URL=postgres://relayforge:your-password@127.0.0.1:5432/relayforge_test npm run test:integration
```

Those tests clear tables in the test database. GitHub Actions runs them against a fresh PostgreSQL service.

**Security boundary:** the application rejects private/reserved DNS answers and pins the checked IP for the connection. This reduces the SSRF risk, but application checks alone aren't a replacement for network-level egress restrictions. Don't expose the worker as a public webhook provider yet. A production version would still need egress controls, encrypted signing secrets, delivery metrics, and per-tenant quotas.

MIT license.
