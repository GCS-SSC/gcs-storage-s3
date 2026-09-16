# GCS-SSC S3-Compatible Storage Provider

Private Amazon S3 and Backblaze B2 object-storage provider for GCS-SSC. The host owns attachment metadata, authorization, target lifecycle, and all upload/download APIs. This extension supplies server-side put/get/delete operations and an agency configuration panel.

Amazon S3 configuration supports bucket, AWS region, an optional key prefix, Node's default credential provider chain or agency-scoped encrypted access keys, and bucket-default encryption or SSE-KMS. Backblaze B2 configuration supports the bucket's official S3 endpoint, an optional key prefix, bucket-default encryption, and a bucket-scoped application key stored as an agency encrypted secret. The endpoint is restricted to HTTPS `s3.<region>.backblazeb2.com` hosts; arbitrary S3-compatible endpoints are not accepted because an application-entered endpoint would create an SSRF and credential-exfiltration boundary that URL validation alone cannot secure.

B2 uses path-style bucket addressing and derives its signing region from the validated endpoint. New locators pin the service, bucket, region, endpoint, addressing mode, and provider-returned object version ID. Deletes target that exact version so versioned AWS buckets and always-versioned B2 buckets do not retain billable hidden object versions. Legacy locators without a version ID retain key-only deletion behavior.

The backend fingerprint cannot change while active attachments reference the provider; credential rotation and key-prefix changes remain available. Encrypted credential payloads are tagged with their service, and legacy untagged credentials are treated as Amazon S3 credentials only. Browser responses expose only a masked access-key identifier. Presigned browser transfers and custom attachment metadata are not supported.

Writes use a single SDK attempt because retrying an ambiguously completed PUT can create multiple billable versions under one key. Each write carries a random metadata token; on an ambiguous failure the adapter performs a best-effort HEAD and exact-version delete only when that token proves the recovered version belongs to the failed write. A later host/application retry receives a new opaque key. Version-specific reads and deletes retain the SDK's bounded standard retry behavior. The 10 MiB host upload cap deliberately uses one `PutObject`; multipart upload would add requests and orphan-part risk without a size benefit.

Before resolving credentials or constructing an S3 client, each provider write builds the exact final `prefix/objectName` key and enforces the public SDK's 512-byte UTF-8 provider-object-ID maximum. A rejected key therefore sends no PUT and cannot leave a remote object, including for multibyte prefixes and long host-generated template names.

Ordinary PUT, GET body consumption, HEAD, and DELETE phases have both transport timeouts and abort deadlines. `GCS_STORAGE_S3_OPERATION_TIMEOUT_MS` sets each phase deadline in milliseconds, defaults to 60 seconds, and accepts integers from 100 milliseconds through 10 minutes. Ambiguous PUT recovery gives HEAD and exact-version DELETE their own fresh deadlines; a failed recovery emits one sanitized `storage_cleanup_failed` event while the original PUT error remains authoritative. The connection canary retains its separately configured shorter deadline.

Saving replacement agency credentials first writes, reads, verifies, and deletes a random canary object inside the authorized transaction, so a bad rotation cannot overwrite the last working secret. The explicit connection test runs the same three-request canary on demand.

Run `bun run typecheck`, `bun run test:unit`, `bun run test:integration`, and `bun run test:coverage`. The integration suite uses a loopback stalled HTTP server and needs no cloud credentials. A real AWS test is opt-in with `GCS_S3_REAL_CANARY=true`, `GCS_S3_CANARY_BUCKET`, and `AWS_REGION`, then `bun run test:canary:s3`.

For a real Backblaze test, create the ignored, mode-`0600` `.env.b2.local` containing `B2_S3_BUCKET`, `B2_S3_ENDPOINT`, `B2_S3_KEY_ID`, and `B2_S3_APPLICATION_KEY`, then run `bun run test:canary:b2`. Use a bucket-restricted application key rather than the unsupported B2 master application key.

## Translation ownership

Requires SDK 0.3.0. Interface catalogs live in this package's `i18n/` directory.
Define matching English/French keys and named placeholders with
`defineGcsExtensionMessages`, then use `useExtensionI18n(catalog)` in UI or
`translateGcsExtensionMessage` in shared/server code. There is no host message
lookup or fallback. Keep extension-authored common labels and validation text in
this package; treat bilingual domain values and already-localized errors as data.
The package owns translation tests and includes catalogs in its coverage inventory.

## Audit ownership

The extension creates no dedicated database tables. Agency configuration and secrets retain the host’s owner-based audit rules. External objects are represented by host attachment metadata; object contents are not SQL audit input values.

The manifest targets SDK 0.3.2 and explicitly declares its dedicated tables (an empty
list when there are none). Extension migration journals remain global infrastructure.

Run `bun run test:audit` from this extension inside a GCS-SSC host checkout with
`tooling/gcs-ssc` available. The extension owns its concrete fixtures; the private
host adapter exercises the real audit migrations, declaration publication, row
triggers, both ownership interpreters, rollback and immutable historical audiences.
These reduced-schema ownership fixtures complement the extension’s normal tests.
Set `AUDIT_EXTENSION_POSTGRES_URL` to a disposable PostgreSQL database URL ending
in `_test` to run the same suite on PostgreSQL; the adapter creates and removes an
isolated database. Without that variable, the suite uses in-memory PGlite.
